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

import { ditherColor, toRGB, PRESETS, hexToRgb, nearestLut } from '../src/dither.js';

const solid = (r, g, b) => {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) a.set([r, g, b, 255], i * 4);
  return toRGB(a, W, H, {});
};
const rgb8 = PRESETS.rgb.colors.map(hexToRgb);

test('colour: palette colours map to themselves', () => {
  const lut = nearestLut(rgb8);
  for (const alg of Object.keys(ALGORITHMS)) {
    rgb8.forEach((c, k) => {
      const idx = ditherColor(solid(...c), W, H, { algorithm: alg }, rgb8);
      assert.ok(idx.every((v) => v === k), `${alg} colour ${k}`);
    });
  }
  assert.equal(lut.length, 64 ** 3);
});

test('colour: dithering mixes towards the source colour', () => {
  // Orange from an 8-colour RGB palette must be a mix of red and yellow.
  for (const alg of ['floyd', 'bayer8', 'bluenoise']) {
    const idx = ditherColor(solid(255, 128, 0), W, H, { algorithm: alg }, rgb8);
    const avg = [0, 0, 0];
    idx.forEach((k) => rgb8[k].forEach((v, j) => (avg[j] += v / idx.length)));
    assert.ok(Math.abs(avg[0] - 255) < 15 && Math.abs(avg[1] - 128) < 30 && avg[2] < 15, `${alg}: ${avg.map(Math.round)}`);
  }
});

test('colour: saturation 0 to -100 makes grey', () => {
  const a = new Uint8ClampedArray([255, 0, 0, 255]);
  const [r, g, b] = toRGB(a, 1, 1, { saturation: -100 });
  assert.ok(Math.abs(r - g) < 1e-3 && Math.abs(g - b) < 1e-3);
});

import { framing } from '../src/frame.js';

test('framing: original aspect keeps shape, long side is the dot count', () => {
  assert.deepEqual(framing({ width: 1920, height: 1080 }, { long: 320 }), { w: 320, h: 180, crop: null, fit: 'fill' });
  // Portrait phone video: long side is the height.
  assert.deepEqual(framing({ width: 1080, height: 1920 }, { long: 320 }), { w: 180, h: 320, crop: null, fit: 'fill' });
  // Never upsample past the source.
  assert.equal(framing({ width: 200, height: 100 }, { long: 640 }).w, 200);
});

test('framing: crop is centred and matches the target aspect', () => {
  const f = framing({ width: 1920, height: 1080 }, { aspect: '9:16', fit: 'crop', long: 320 });
  assert.equal(f.h, 320); assert.equal(f.w, 180);
  assert.equal(f.crop.height, 1080);
  assert.ok(Math.abs(f.crop.width / f.crop.height - 9 / 16) < 0.01);
  assert.ok(Math.abs(f.crop.left - (1920 - f.crop.width) / 2) <= 1);
  const g = framing({ width: 1080, height: 1920 }, { aspect: '1:1', fit: 'crop', long: 300 });
  assert.deepEqual([g.w, g.h, g.crop.width, g.crop.height, g.crop.top], [300, 300, 1080, 1080, 420]);
});

test('framing: fit letterboxes', () => {
  const f = framing({ width: 1920, height: 1080 }, { aspect: '1:1', fit: 'contain', long: 256 });
  assert.deepEqual(f, { w: 256, h: 256, crop: null, fit: 'contain' });
});
