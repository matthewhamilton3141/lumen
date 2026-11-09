import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dither, toLuma, palette, ALGORITHMS } from '../src/dither.js';
import { packFrame, unpackFrame, FramePacker, bitsFor } from '../src/pack.js';
import { blueNoise } from '../src/bluenoise.js';

const W = 64, H = 64;
const flat = (v) => new Float32Array(W * H).fill(v);
const mean = (idx, L) => idx.reduce((a, b) => a + b, 0) / idx.length / L;

test('every algorithm preserves average tone', () => {
  for (const alg of Object.keys(ALGORITHMS)) {
    if (alg === 'threshold') continue;
    // Atkinson discards 1/4 of the error, so it crushes shadows/highlights by design.
    for (const v of alg === 'atkinson' ? [128] : [32, 128, 200]) {
      const idx = dither(flat(v), W, H, { algorithm: alg, levels: 2, threshold: 128, strength: 1 });
      const m = mean(idx, 1);
      const tol = alg === 'bayer2' ? 0.13 : 0.05; // 2x2 only has 5 tones
      assert.ok(Math.abs(m - v / 255) < tol, `${alg} at ${v}: got ${m.toFixed(3)}`);
    }
  }
});

test('extremes stay solid', () => {
  for (const alg of Object.keys(ALGORITHMS)) {
    assert.equal(mean(dither(flat(0), W, H, { algorithm: alg, levels: 2 }), 1), 0, alg);
    assert.equal(mean(dither(flat(255), W, H, { algorithm: alg, levels: 2 }), 1), 1, alg);
  }
});

test('multi-level output stays in range', () => {
  const lum = new Float32Array(W * H).map((_, i) => (i % W) * 4);
  for (const alg of Object.keys(ALGORITHMS)) {
    const idx = dither(lum, W, H, { algorithm: alg, levels: 5 });
    assert.ok(idx.every((v) => v >= 0 && v <= 4), alg);
    assert.ok(new Set(idx).size >= 4, `${alg} uses the levels`);
  }
});

test('blue noise is a permutation of thresholds', () => {
  const { t, size } = blueNoise(16);
  assert.equal(size, 16);
  const sorted = [...t].sort((a, b) => a - b);
  sorted.forEach((v, i) => assert.ok(Math.abs(v - (i + 0.5) / 256) < 1e-6));
});

test('luma adjustments', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual([...toLuma(rgba, 2, 1, { invert: true })].map(Math.round), [0, 255]);
  assert.ok(toLuma(rgba, 2, 1, { brightness: 50 })[1] > 100);
});

test('palette endpoints', () => {
  assert.deepEqual(palette(3, [0, 0, 0], [255, 255, 255]), [[0, 0, 0], [128, 128, 128], [255, 255, 255]]);
});

test('pack/unpack round trip', () => {
  for (const levels of [2, 3, 4, 8, 16]) {
    const b = bitsFor(levels);
    const idx = Uint8Array.from({ length: 1001 }, (_, i) => (i * 7) % levels);
    assert.deepEqual(unpackFrame(packFrame(idx, b), b, idx.length), idx);
  }
});

test('xor delta stream decodes', async () => {
  const p = new FramePacker(10, 10, 4);
  const frames = [0, 1, 2].map((k) => Uint8Array.from({ length: 100 }, (_, i) => (i + k) % 4));
  frames.forEach((f) => p.add(f));
  const z = await p.compress();
  const raw = new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  const cur = new Uint8Array(p.size);
  frames.forEach((f, k) => {
    for (let i = 0; i < p.size; i++) cur[i] ^= raw[k * p.size + i];
    assert.deepEqual(unpackFrame(cur, p.bits, 100), f);
  });
});
