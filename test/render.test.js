import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProcessor, makeRenderer, upscaleIdx } from '../src/render.js';
import { DEFAULTS } from '../src/dither.js';

const W = 12, H = 8;
// Gradient with some colour so every mode has something to chew on.
function source() {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    a[i] = (x / (W - 1)) * 255; a[i + 1] = (y / (H - 1)) * 255; a[i + 2] = 255 - a[i]; a[i + 3] = 255;
  }
  return a;
}
const MODES = {
  mono: { mode: 'mono', levels: 4, ink: [0, 0, 0], paper: [255, 255, 255] },
  color: { mode: 'color', colors: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]] },
  original: { mode: 'original', chLevels: 3 },
};
const LOOKS = ['square', 'led', 'halftone', 'diamond', 'ascii', 'scan'];
const st = (mode, look, extra = {}) => ({ ...DEFAULTS, ink: [0, 0, 0], paper: [255, 255, 255], bg: null, ...MODES[mode], look, ...extra });

for (const mode of Object.keys(MODES)) for (const look of LOOKS) for (const s of [1, 3, 8]) {
  test(`${mode} / ${look} / ${s}×: size, index range, paint`, () => {
    const settings = st(mode, look);
    const r = makeRenderer(W, H, s, settings);
    assert.equal(r.W, W * s);
    assert.equal(r.H, H * s);
    const cellPal = makeProcessor(W, H, settings).pal;
    assert.equal(r.pal.length, cellPal.length + 1);
    assert.equal(r.bgIndex, cellPal.length);
    assert.deepEqual(r.pal.slice(0, -1), cellPal);
    assert.ok(r.pal.length <= 256, 'fits a GIF palette');

    const out = r.run(source());
    assert.equal(out.length, r.W * r.H);
    for (let i = 0; i < out.length; i++) assert.ok(out[i] < r.pal.length, `index ${out[i]} out of range`);
    assert.equal(r.cells.length, W * H);

    const rgba = new Uint8ClampedArray(r.W * r.H * 4);
    r.paint(rgba);
    for (let i = 0; i < out.length; i++) {
      const c = r.pal[out[i]];
      assert.deepEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]], [c[0], c[1], c[2], 255]);
    }
  });
}

for (const mode of Object.keys(MODES)) test(`${mode}: square look is the nearest-neighbour upscale of the processor`, () => {
  const settings = st(mode, 'square'), s = 4;
  const idx = makeProcessor(W, H, settings).run(source());
  const out = makeRenderer(W, H, s, settings).run(source());
  for (let y = 0; y < H * s; y++) for (let x = 0; x < W * s; x++)
    assert.equal(out[y * W * s + x], idx[((y / s) | 0) * W + ((x / s) | 0)]);
});

test('upscaleIdx at 1× returns the input untouched', () => {
  const idx = Uint8Array.from([0, 1, 1, 0]);
  assert.equal(upscaleIdx(idx, 2, 2, 1, new Uint8Array(4)), idx);
});

test('background: default is paper in mono and black otherwise; explicit bg wins', () => {
  const bgOf = (settings) => { const r = makeRenderer(W, H, 6, settings); return r.pal[r.bgIndex]; };
  assert.deepEqual(bgOf(st('mono', 'led')), [255, 255, 255]);
  assert.deepEqual(bgOf(st('color', 'led')), [0, 0, 0]);
  assert.deepEqual(bgOf(st('original', 'led', { bg: [10, 20, 30] })), [10, 20, 30]);
});

test('LED look leaves background gaps and keeps cell colours', () => {
  const r = makeRenderer(W, H, 8, st('color', 'led'));
  const out = r.run(source());
  const seen = new Set(out);
  assert.ok(seen.has(r.bgIndex), 'gaps show the background');
  assert.ok(seen.size > 2, 'cells keep their own colours');
});

test('mono halftone paints solid ink only (ink rule)', () => {
  const r = makeRenderer(W, H, 8, st('mono', 'halftone'));
  const seen = new Set(r.run(source()));
  seen.delete(r.bgIndex);
  assert.deepEqual([...seen], [0]);
});

test('buffers are reused across frames', () => {
  const r = makeRenderer(W, H, 4, st('mono', 'led'));
  assert.equal(r.run(source()), r.run(source()));
});

test('mono diamond: dot size carries the tone, whatever Levels says', () => {
  const r = makeRenderer(W, H, 8, st('mono', 'diamond', { levels: 2 }));
  assert.equal(r.cellPal.length, 16);
  assert.equal(makeProcessor(W, H, st('mono', 'diamond', { levels: 2 })).pal.length, 16);
  const out = r.run(source());
  // Ink only (no greys), and a ramp from dark to light shows a range of dot sizes.
  assert.ok(out.every((v) => v === 0 || v === r.bgIndex));
  const ink = (x0) => { let a = 0; for (let y = 0; y < r.H; y++) for (let x = x0; x < x0 + 8; x++) a += out[y * r.W + x] === 0; return a; };
  const cols = [0, 3, 6, 9].map((c) => ink(c * 8));
  assert.ok(new Set(cols).size >= 3, `dot sizes vary: ${cols}`);
});

test('diamond with dot gain prints darker', () => {
  const ink = (gain) => makeRenderer(W, H, 8, st('mono', 'diamond', { dotGain: gain })).run(source()).reduce((a, v) => a + (v === 0), 0);
  assert.ok(ink(0.3) > ink(0));
});
