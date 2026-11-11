import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_DEFAULTS, LOOK_KEYS, SHARE_KEYS, withPreset, roomForGlyphs, toRender } from '../src/settings.js';
import { LOOK_PRESETS } from '../src/presets.js';
import { gifWriter, htmlWriter, playOnce } from '../src/encode.js';
import { makeRenderer } from '../src/render.js';

test('a preset resets every look key, then applies its own', () => {
  const S = { ...structuredClone(APP_DEFAULTS), glow: 0.9, contrast: 50, look: 'led', format: 'gif', width: 500 };
  // Every look key comes from the preset (or the defaults), never from what was set before.
  const bayer = LOOK_PRESETS.find((p) => p.id === 'bayer');
  const o = withPreset(S, bayer);
  for (const k of LOOK_KEYS) assert.deepEqual(o[k], bayer.settings[k] ?? APP_DEFAULTS[k], k);
  assert.equal(o.glow, 0);
  assert.equal(o.look, 'square');
  assert.equal(o.algorithm, 'bayer8');
  assert.equal(o.format, 'gif', 'non-look keys are kept');
  assert.equal(o.width, 500);
  const p = withPreset(S, LOOK_PRESETS.find((x) => x.id === 'neonascii'));
  assert.equal(p.glow, 0.55);
  assert.equal(p.look, 'ascii');
});

test('presets never share arrays with the defaults', () => {
  const o = withPreset(APP_DEFAULTS, LOOK_PRESETS.find((p) => p.id === 'pocket'));
  o.colors.push('#123456');
  assert.ok(!APP_DEFAULTS.colors.includes('#123456'));
});

test('ASCII gets room for its glyphs; other looks are untouched', () => {
  assert.deepEqual(roomForGlyphs({ look: 'ascii', scale: 4, width: 320 }), { look: 'ascii', scale: 8, width: 160 });
  assert.deepEqual(roomForGlyphs({ look: 'ascii', scale: 12, width: 100 }), { look: 'ascii', scale: 12, width: 100 });
  const o = { look: 'led', scale: 2, width: 900 };
  assert.equal(roomForGlyphs(o), o);
});

test('render settings use RGB triples', () => {
  const r = toRender({ ...APP_DEFAULTS, ink: '#ff0000', bg: '#00ff00' });
  assert.deepEqual(r.ink, [255, 0, 0]);
  assert.deepEqual(r.bg, [0, 255, 0]);
  assert.equal(toRender(APP_DEFAULTS).bg, null);
  for (const k of SHARE_KEYS) assert.ok(k in APP_DEFAULTS, k);
});

const src = (w, h, f) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([(i * 7 + f * 40) % 256, (i * 3) % 256, 128, 255], i * 4);
  return a;
};

test('GIF writer: valid file, loops unless asked not to, glow fits 256 colours', () => {
  for (const glow of [0, 0.6]) {
    const ren = makeRenderer(16, 10, 3, toRender({ ...APP_DEFAULTS, mode: 'original', chLevels: 6, look: 'led', glow }));
    const g = gifWriter(ren, 10);
    for (let f = 0; f < 3; f++) g.add(src(16, 10, f));
    const loop = g.finish();
    assert.equal(String.fromCharCode(...loop.subarray(0, 6)), 'GIF89a');
    assert.ok(Buffer.from(loop).includes('NETSCAPE2.0'));
    const once = playOnce(loop);
    assert.equal(once.length, loop.length - 19);
    assert.ok(!Buffer.from(once).includes('NETSCAPE'));
    assert.equal(once[once.length - 1], 0x3b, 'still ends with the trailer');
  }
});

test('HTML writer packs one frame per add', async () => {
  const ren = makeRenderer(16, 10, 4, toRender({ ...APP_DEFAULTS, look: 'ascii', glow: 0.5 }));
  const h = htmlWriter(ren, 16, 10);
  for (let f = 0; f < 4; f++) h.add(src(16, 10, f));
  const html = await h.finish({ fps: 12, title: 'x' });
  assert.match(html, /"frames":4/);
  assert.match(html, /"glow":/);
});
