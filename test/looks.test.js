import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKS, makeStamps, resolveBg, lookTables, stampFrame, makeLook } from '../src/looks.js';
import { LOOK_PRESETS } from '../src/presets.js';
import { ALGORITHMS, PRESETS } from '../src/dither.js';

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 20, 24];
const sum = (m) => m.reduce((a, b) => a + b, 0);

test('every look gives K binary s×s masks at every size', () => {
  for (const look of Object.keys(LOOKS)) {
    for (const s of SIZES) {
      const st = makeStamps(look, s);
      assert.equal(st.K, LOOKS[look].K);
      assert.equal(st.s, s);
      assert.equal(st.masks.length, st.K);
      for (const m of st.masks) {
        assert.ok(m instanceof Uint8Array);
        assert.equal(m.length, s * s);
        assert.ok(m.every((v) => v === 0 || v === 1));
      }
    }
  }
});

test('unknown look and odd sizes fall back without throwing', () => {
  assert.equal(sum(makeStamps('nope', 4).masks[0]), 16);
  assert.equal(makeStamps('halftone', 0).s, 1);
  assert.equal(makeStamps('ascii', 2.7).s, 2);
});

test('square is all ones; scan drops the bottom rows; led leaves a gap', () => {
  for (const s of SIZES) assert.equal(sum(makeStamps('square', s).masks[0]), s * s);
  for (const s of SIZES.filter((v) => v >= 2)) {
    const m = makeStamps('scan', s).masks[0];
    const off = Math.max(1, Math.round(s / 3));
    assert.equal(sum(m), (s - off) * s);
    assert.equal(sum(m.subarray(0, s)), s);
    assert.equal(sum(m.subarray((s - 1) * s)), 0);
  }
  assert.equal(sum(makeStamps('scan', 1).masks[0]), 1);
  for (const s of [4, 8, 12]) {
    const m = makeStamps('led', s).masks[0];
    assert.equal(m[0], 0, 'corner is off');
    assert.equal(m[(s / 2) * s + s / 2], 1, 'centre is on');
    assert.ok(sum(m) > s * s * 0.4 && sum(m) < s * s * 0.8);
    // symmetric both ways
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      assert.equal(m[y * s + x], m[y * s + (s - 1 - x)]);
      assert.equal(m[y * s + x], m[(s - 1 - y) * s + x]);
    }
  }
  assert.ok(sum(makeStamps('led', 1).masks[0]) === 1 && sum(makeStamps('led', 2).masks[0]) === 4);
});

test('halftone and ascii coverage grows with level', () => {
  for (const look of ['halftone', 'ascii']) {
    for (const s of SIZES) {
      const c = makeStamps(look, s).masks.map(sum);
      assert.equal(c[0], 0, `${look} s=${s} level 0 is empty`);
      for (let k = 1; k < c.length; k++) assert.ok(c[k] >= c[k - 1], `${look} s=${s}: ${c}`);
      assert.ok(c[c.length - 1] > 0);
    }
  }
  for (const s of SIZES) assert.equal(sum(makeStamps('halftone', s).masks[7]), s * s, 'top halftone level is solid');
  // Real glyphs from s = 6 up: strictly more ink at each step from '=' on (':' and '-' may tie).
  for (const s of [8, 12, 16]) {
    const c = makeStamps('ascii', s).masks.map(sum);
    for (let k = 4; k < c.length; k++) assert.ok(c[k] > c[k - 1], `ascii s=${s}: ${c}`);
    const m = makeStamps('ascii', s).masks[9];
    assert.equal(sum(m.subarray(0, s)), 0, '1px top margin');
  }
});

test('resolveBg', () => {
  assert.deepEqual(resolveBg({ mode: 'mono', paper: [250, 240, 230], bg: null }), [250, 240, 230]);
  assert.deepEqual(resolveBg({ mode: 'color', bg: null }), [0, 0, 0]);
  assert.deepEqual(resolveBg({ mode: 'original' }), [0, 0, 0]);
  assert.deepEqual(resolveBg({ mode: 'mono', bg: [1, 2, 3] }), [1, 2, 3]);
  assert.deepEqual(resolveBg({ mode: 'mono', bg: '#ff0080' }), [255, 0, 128]);
  assert.deepEqual(resolveBg({}), [255, 255, 255]);
});

test('lookTables on light and dark backgrounds', () => {
  const pal = [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]];
  const light = lookTables(pal, [255, 255, 255], 8, 'ink');
  assert.deepEqual([...light.cov], [7, 5, 2, 0]);
  assert.deepEqual([...light.col], [0, 0, 0, 0]);
  assert.equal(light.bgIndex, 4);
  const dark = lookTables(pal, [0, 0, 0], 8, 'cell');
  assert.deepEqual([...dark.cov], [0, 2, 5, 7]);
  assert.deepEqual([...dark.col], [0, 1, 2, 3]);
  // Single-stamp looks always use stamp 0.
  assert.deepEqual([...lookTables(pal, [0, 0, 0], 1, 'cell').cov], [0, 0, 0, 0]);
  // Every entry equally far from bg → fullest stamp.
  const flat = lookTables([[255, 0, 0], [255, 0, 0]], [0, 0, 0], 8, 'cell');
  assert.deepEqual([...flat.cov], [7, 7]);
  assert.deepEqual([...lookTables([[9, 9, 9]], [9, 9, 9], 10, 'ink').cov], [9]);
});

test('stampFrame against a hand-checked case', () => {
  // 2×1 cells, s = 2. Stamp 0 = top-left pixel only, stamp 1 = full.
  const masks = [Uint8Array.of(1, 0, 0, 0), Uint8Array.of(1, 1, 1, 1)];
  const cov = Uint8Array.of(0, 1), col = Uint8Array.of(0, 1);
  const out = stampFrame(Uint8Array.of(0, 1), 2, 1, 2, masks, cov, col, 2);
  assert.deepEqual([...out], [0, 2, 1, 1, 2, 2, 1, 1]);
  // 'ink' style colour table, two rows, reused buffer.
  const buf = new Uint8Array(16);
  const r = stampFrame(Uint8Array.of(1, 0, 0, 1), 2, 2, 2, masks, cov, Uint8Array.of(1, 1), 2, buf);
  assert.equal(r, buf);
  assert.deepEqual([...buf], [
    1, 1, 1, 2,
    1, 1, 2, 2,
    1, 2, 1, 1,
    2, 2, 1, 1,
  ]);
  // s = 1 is a straight lookup.
  assert.deepEqual([...stampFrame(Uint8Array.of(1, 0), 2, 1, 1, [Uint8Array.of(1)], Uint8Array.of(0, 0), Uint8Array.of(5, 6), 2)], [6, 5]);
});

test('makeLook picks the colour rule and appends bg', () => {
  const pal = [[0, 0, 0], [128, 128, 128], [255, 255, 255]];
  const mono = makeLook(pal, 8, { look: 'halftone', mode: 'mono', paper: [255, 255, 255], bg: null });
  assert.equal(mono.K, 8);
  assert.equal(mono.square, false);
  assert.deepEqual([...mono.col], [0, 0, 0]);
  assert.equal(mono.cov[2], 0);
  assert.equal(mono.bgIndex, 3);
  assert.deepEqual(mono.outPal, [...pal, [255, 255, 255]]);
  const colour = makeLook(pal, 8, { look: 'halftone', mode: 'color', bg: null });
  assert.deepEqual([...colour.col], [0, 1, 2]);
  assert.deepEqual(colour.outPal[3], [0, 0, 0]);
  const led = makeLook(pal, 6, { look: 'led', mode: 'mono', paper: [255, 255, 255] });
  assert.deepEqual([...led.col], [0, 1, 2], 'single-stamp looks keep cell colours');
  const sq = makeLook(pal, 4, {});
  assert.ok(sq.square && sq.K === 1 && sq.s === 4);
  // End to end: a full frame has the right size and only valid indices.
  const out = stampFrame(Uint8Array.of(0, 1, 2, 1), 2, 2, mono.s, mono.masks, mono.cov, mono.col, mono.bgIndex);
  assert.equal(out.length, 16 * 16);
  assert.ok(out.every((v) => v === 0 || v === 3));
});

test('presets only use values the app knows', () => {
  assert.deepEqual(LOOK_PRESETS.map((p) => p.id), ['bayer', 'pocket', 'neonascii', 'led', 'crt']);
  const hex = /^#[0-9a-f]{6}$/;
  const ids = new Set();
  for (const p of LOOK_PRESETS) {
    assert.ok(p.id && p.name && !ids.has(p.id));
    ids.add(p.id);
    const s = p.settings;
    assert.ok(s.algorithm in ALGORITHMS, p.id);
    assert.ok(s.look in LOOKS, p.id);
    assert.ok(['mono', 'color', 'original'].includes(s.mode), p.id);
    assert.ok(s.levels >= 2 && s.levels <= 8);
    assert.ok(s.chLevels >= 2 && s.chLevels <= 6);
    assert.ok(hex.test(s.ink) && hex.test(s.paper));
    assert.ok(s.bg === null || hex.test(s.bg));
    assert.ok(s.glow >= 0 && s.glow <= 1 && s.glowSize >= 0.5 && s.glowSize <= 6, p.id);
    assert.ok(s.twinkle >= 0 && s.twinkle <= 1, p.id);
    if (s.mode === 'color') {
      assert.ok(s.preset in PRESETS, p.id);
      assert.deepEqual(s.colors, PRESETS[s.preset].colors);
    }
  }
});
