import test from 'node:test';
import assert from 'node:assert/strict';
import { glowFrame, glowParams } from '../src/glow.js';
import { makeRenderer } from '../src/render.js';
import { GLOW_SOURCE } from '../src/player.js';
import { DEFAULTS } from '../src/dither.js';

const W = 64, H = 48;
function frame(bg, dots = [], ink = [255, 255, 255]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([...bg, 255], i * 4);
  for (const [x, y] of dots) px.set([...ink, 255], (y * W + x) * 4);
  return px;
}
const at = (px, x, y) => px[(y * W + x) * 4];

test('off, or nothing but background, leaves the frame alone', () => {
  const a = frame([0, 0, 0], [[10, 10]]);
  assert.deepEqual(glowFrame(Uint8ClampedArray.from(a), W, H, [0, 0, 0], 0, 8), a);
  const flat = frame([30, 60, 90]);
  assert.deepEqual(glowFrame(Uint8ClampedArray.from(flat), W, H, [30, 60, 90], 1, 8), flat);
});

for (const radius of [2, 6, 18]) test(`bright dots bloom on dark, falling off with distance (r=${radius})`, () => {
  const cx = 32, cy = 24, dots = [];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) dots.push([cx + x, cy + y]);
  const px = glowFrame(frame([0, 0, 0], dots), W, H, [0, 0, 0], 1, radius);
  assert.equal(at(px, cx, cy), 255, 'core stays lit');
  const ring = Math.min(cx - 2, cx + Math.ceil(radius / 2));
  assert.ok(at(px, ring, cy) > 0, `glow reaches ${ring - cx}px out`);
  let prev = 256;
  for (let x = cx + 2; x < W; x++) { assert.ok(at(px, x, cy) <= prev + 1, `monotone at ${x}`); prev = at(px, x, cy); }
  assert.ok(Math.abs(at(px, cx - 5, cy) - at(px, cx + 5, cy)) <= 2, 'roughly symmetric');
  assert.ok(at(px, 0, 0) < 8, 'far corner stays dark');
});

test('dark ink bleeds into a light background', () => {
  const px = glowFrame(frame([255, 255, 255], [[20, 20], [21, 20], [20, 21], [21, 21]], [0, 0, 0]), W, H, [255, 255, 255], 1, 6);
  assert.ok(at(px, 23, 20) < 255);
  assert.equal(at(px, 63, 47), 255);
});

test('scratch buffers are reused and the result is deterministic', () => {
  const ws = {};
  const a = glowFrame(frame([0, 0, 0], [[5, 5], [40, 30]]), W, H, [0, 0, 0], 0.7, 9, ws);
  const e = ws.e;
  const b = glowFrame(frame([0, 0, 0], [[5, 5], [40, 30]]), W, H, [0, 0, 0], 0.7, 9, ws);
  assert.equal(ws.e, e);
  assert.deepEqual(a, b);
});

test('glowParams: radius is in cells; zero means off', () => {
  assert.equal(glowParams({ glow: 0 }, 8, [0, 0, 0]), null);
  assert.deepEqual(glowParams({ glow: 0.5, glowSize: 1.5 }, 8, [1, 2, 3]), { amount: 0.5, radius: 12, bg: [1, 2, 3] });
});

test('renderer applies glow in paint and reports it', () => {
  const src = new Uint8ClampedArray(16 * 10 * 4);
  for (let i = 0; i < 160; i++) src.set([(i % 16) * 16, 40, 200, 255], i * 4);
  const st = { ...DEFAULTS, mode: 'original', chLevels: 3, look: 'led', bg: [0, 0, 0], ink: [0, 0, 0], paper: [255, 255, 255] };
  const plain = makeRenderer(16, 10, 6, st);
  const lit = makeRenderer(16, 10, 6, { ...st, glow: 0.8, glowSize: 2 });
  assert.equal(plain.glow, null);
  assert.deepEqual(lit.glow.bg, [0, 0, 0]);
  assert.equal(lit.glow.radius, 12);
  plain.run(src); lit.run(src);
  const a = plain.paint(new Uint8ClampedArray(plain.W * plain.H * 4));
  const b = lit.paint(new Uint8ClampedArray(lit.W * lit.H * 4));
  let brighter = 0;
  for (let i = 0; i < a.length; i += 4) { assert.ok(b[i] >= a[i]); if (b[i] > a[i]) brighter++; }
  assert.ok(brighter > a.length / 40, 'gaps between dots pick up light');
  // Square pixels glow against the auto background, ignoring a stale explicit bg.
  const sq = makeRenderer(16, 10, 4, { ...st, look: 'square', bg: [255, 0, 0], glow: 0.5 });
  assert.deepEqual(sq.glow.bg, [0, 0, 0]);
});

test('player copy of the glow is standalone and identical', () => {
  assert.doesNotMatch(GLOW_SOURCE, /^\s*\/\//m);
  const copy = new Function(`return ${GLOW_SOURCE}`)();
  const a = glowFrame(frame([0, 0, 20], [[3, 3], [30, 40], [31, 40]]), W, H, [0, 0, 20], 0.6, 7);
  const b = copy(frame([0, 0, 20], [[3, 3], [30, 40], [31, 40]]), W, H, [0, 0, 20], 0.6, 7);
  assert.deepEqual(a, b);
});
