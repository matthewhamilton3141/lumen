import test from 'node:test';
import assert from 'node:assert/strict';
import { findTwinkles, drawTwinkles } from '../src/twinkle.js';
import { makeRenderer } from '../src/render.js';
import { TWINKLE_SOURCE, buildPlayer } from '../src/player.js';
import { APP_DEFAULTS, toRender } from '../src/settings.js';

const s = 6, w = 60, h = 40, W = w * s, H = h * s;
// Left half lit (colour), right half background.
function frame(bg = [0, 0, 0], ink = [40, 200, 255]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([...(x < W / 2 ? ink : bg), 255], (y * W + x) * 4);
  return px;
}
const count = (list) => (list ? list.length / 6 : 0);

test('off at zero; sparse, and only on lit cells', () => {
  assert.equal(findTwinkles(frame(), W, H, s, [0, 0, 0], 1, 0), null);
  let total = 0;
  for (let t = 0; t < 6; t += 0.25) {
    const list = findTwinkles(frame(), W, H, s, [0, 0, 0], t, 1);
    total += count(list);
    assert.ok(count(list) < (w * h) / 2 * 0.02, `few at once (t=${t}: ${count(list)})`);
    for (let i = 0; i < list.length; i += 6) assert.ok(list[i] < W / 2, 'never on an unlit cell');
  }
  assert.ok(total > 10, `some twinkles over time (${total})`);
});

test('the same moment always looks the same, and it changes over time', () => {
  const a = findTwinkles(frame(), W, H, s, [0, 0, 0], 2.5, 0.7);
  const b = findTwinkles(frame(), W, H, s, [0, 0, 0], 2.5, 0.7);
  assert.deepEqual(a, b);
  const later = findTwinkles(frame(), W, H, s, [0, 0, 0], 4.1, 0.7);
  assert.notDeepEqual(a, later);
});

test('twinkles fade in and out rather than popping', () => {
  // Track one cell's strength across finely spaced times: no big jumps.
  const strength = (t) => {
    const l = findTwinkles(frame(), W, H, s, [0, 0, 0], t, 1) || [];
    const m = new Map();
    for (let i = 0; i < l.length; i += 6) m.set(`${l[i]},${l[i + 1]}`, l[i + 5]);
    return m;
  };
  let prev = strength(0);
  for (let t = 0.02; t < 3; t += 0.02) {
    const cur = strength(t);
    for (const [k, v] of cur) assert.ok(Math.abs(v - (prev.get(k) || 0)) < 0.2, `cell ${k} jumped at ${t.toFixed(2)}`);
    prev = cur;
  }
});

test('brightens toward white on dark, darkens on light; stays local', () => {
  const dark = frame();
  const list = [W / 4, H / 2, 255, 255, 255, 1];
  drawTwinkles(dark, W, H, s, list);
  const at = (px, x, y) => px[(Math.round(y) * W + Math.round(x)) * 4];
  assert.equal(at(dark, W / 4, H / 2), 255, 'core goes white');
  assert.ok(at(dark, W / 4 + s * 1.5, H / 2) > 40, 'ray reaches out along x');
  assert.equal(at(dark, W - 2, 2), 0, 'far away untouched');
  const light = frame([255, 255, 255], [0, 0, 0]);
  const l2 = findTwinkles(light, W, H, s, [255, 255, 255], 0, 1) || [];
  for (let i = 2; i < l2.length; i += 6) assert.ok(l2[i] <= 30, 'target is deeper ink on paper');
});

test('renderer: paint(t) adds twinkles; effects flag set', () => {
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) src.set([200, 80, 255, 255], i * 4);
  const st = toRender({ ...APP_DEFAULTS, look: 'led', mode: 'original', chLevels: 3, bg: '#000000', twinkle: 1 });
  const r = makeRenderer(w, h, s, st);
  assert.ok(r.effects && r.twinkle && !r.glow);
  r.run(src);
  let differs = false;
  const base = makeRenderer(w, h, s, { ...st, twinkle: 0 });
  base.run(src);
  const b = base.paint(new Uint8ClampedArray(r.W * r.H * 4));
  for (let t = 0; t < 3 && !differs; t += 0.2) {
    const a = r.paint(new Uint8ClampedArray(r.W * r.H * 4), t);
    differs = a.some((v, i) => v !== b[i]);
  }
  assert.ok(differs);
});

test('player copy is standalone and matches; ships only when on', () => {
  const copy = new Function(`${TWINKLE_SOURCE}\nreturn { findTwinkles, drawTwinkles };`)();
  for (const t of [0.3, 1.7, 2.9]) {
    const a = frame(), b = frame();
    drawTwinkles(a, W, H, s, findTwinkles(a, W, H, s, [0, 0, 0], t, 0.8));
    copy.drawTwinkles(b, W, H, s, copy.findTwinkles(b, W, H, s, [0, 0, 0], t, 0.8));
    assert.deepEqual(a, b);
  }
  const base = { w: 2, h: 2, fps: 10, frames: 1, bits: 1, palette: [[0, 0, 0], [255, 255, 255]], data: 'AA==' };
  assert.doesNotMatch(buildPlayer(base), /findTwinkles=/);
  const html = buildPlayer({ ...base, twinkle: { amount: 0.5, bg: [0, 0, 0], t0: 1.5 } });
  assert.match(html, /const findTwinkles=function findTwinkles/);
  assert.match(html, /"tw":\{"a":0.5,"bg":\[0,0,0\],"t0":1.5\}/);
});
