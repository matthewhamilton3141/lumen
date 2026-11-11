import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayer, packMasks, unpackMasks, RUNTIME_BYTES } from '../src/player.js';
import { FramePacker, toBase64 } from '../src/pack.js';
import { glowFrame } from '../src/glow.js';
import { findTwinkles, drawTwinkles } from '../src/twinkle.js';

const W = 4, H = 3;
const PAL = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [255, 255, 255]];
const FRAMES = [0, 1, 2].map((f) => Uint8Array.from({ length: W * H }, (_, i) => (i + f * 3) % PAL.length));

async function pack(frames = FRAMES) {
  const p = new FramePacker(W, H, PAL.length);
  for (const f of frames) p.add(f);
  return { bits: p.bits, frames: p.count, data: toBase64(await p.compress()) };
}

const base = async (extra = {}, frames) => ({ w: W, h: H, fps: 10, palette: PAL, loop: true, title: 'Test', ...(await pack(frames)), ...extra });

// Pull the pieces out of the generated markup and run the real runtime against DOM stubs.
async function run(html, { reduce = false } = {}) {
  const meta = html.match(/<script type="application\/json">([\s\S]*?)<\/script>/)[1];
  const data = html.match(/<script type="text\/plain">([\s\S]*?)<\/script>/)[1];
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const draws = [];
  let onDraw = () => {};
  const listeners = {};
  const canvas = {
    width: 0, height: 0, dataset: {},
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (img) => { draws.push(Uint8ClampedArray.from(img.data)); onDraw(); },
    }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
  };
  const root = {
    querySelector: (sel) => sel === 'canvas' ? canvas
      : sel.includes('application/json') ? { textContent: meta } : { textContent: data },
  };
  const rafs = [];
  let io = null;
  const env = {
    document: { currentScript: { parentNode: root } },
    matchMedia: () => ({ matches: reduce }),
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    self: { IntersectionObserver: class { constructor(cb) { io = cb; } observe() {} } },
  };
  env.IntersectionObserver = env.self.IntersectionObserver;
  const first = new Promise((res) => { onDraw = res; });
  new Function(...Object.keys(env), code)(...Object.values(env));
  await first;
  await new Promise((r) => setTimeout(r, 0));
  let t = 1000; // rAF timestamps are never 0 in a browser
  // Advance time by ms, running whatever animation frame is pending.
  const advance = (ms) => { t += ms; const fn = rafs.shift(); if (fn) fn(t); return !!fn; };
  const fire = (type, e) => listeners[type]?.({ pointerType: 'mouse', timeStamp: t, ...e });
  return { canvas, draws, advance, fire, click: () => listeners.click(), see: (v) => io([{ isIntersecting: v }]), pending: () => rafs.length };
}

const px = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];

test('page output is a full document, snippet is a fragment without ids', async () => {
  const page = buildPlayer(await base());
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>Test<\/title>/);
  assert.match(page, /object-fit:contain/);
  assert.match(buildPlayer(await base({ fit: 'cover' })), /object-fit:cover/);

  const snip = buildPlayer(await base({ embed: 'snippet', fit: 'cover' }));
  assert.doesNotMatch(snip, /<html|<body|<!doctype/i);
  assert.doesNotMatch(snip, /\sid=/);
  assert.doesNotMatch(snip, /getElementById/);
  assert.match(snip, /position:absolute;inset:0/);
  assert.match(snip, /object-fit:cover/);
  assert.equal((snip.match(/<script/g) || []).length, 3);
  assert.ok(RUNTIME_BYTES > 500 && RUNTIME_BYTES < 4000, `runtime is ${RUNTIME_BYTES} bytes`);
});

test('title and meta cannot break out of their tags', async () => {
  const evil = '</title></script><script>alert(1)</script>"&';
  for (const embed of ['page', 'snippet']) {
    const html = buildPlayer(await base({ title: evil, embed }));
    assert.doesNotMatch(html, /alert\(1\)<\/script>/);
    assert.equal((html.match(/<\/script>/g) || []).length, 3);
    assert.equal((html.match(/<script/g) || []).length, 3);
  }
  await assert.rejects(async () => buildPlayer({ ...(await base()), data: 'x</script>' }));
});

test('mask serialisation round-trips', () => {
  const s = 5;
  const masks = [0, 1, 2].map((k) => Uint8Array.from({ length: s * s }, (_, i) => +((i * 7 + k * 3) % 4 < k + 1)));
  const out = unpackMasks(packMasks(masks), masks.length, s);
  assert.deepEqual(out, masks);
});

test('runtime decodes frames with square pixels', async () => {
  const r = await run(buildPlayer(await base()));
  assert.equal(r.canvas.width, W);
  assert.equal(r.canvas.height, H);
  assert.equal(r.draws.length, 1);
  const check = (buf, frame) => {
    for (let i = 0; i < W * H; i++) assert.deepEqual(px(buf, i), [...PAL[frame[i]], 255]);
  };
  check(r.draws[0], FRAMES[0]);
  r.advance(0); r.advance(100); r.advance(100); r.advance(100);
  assert.equal(r.draws.length, 4);
  check(r.draws[1], FRAMES[1]);
  check(r.draws[2], FRAMES[2]);
  check(r.draws[3], FRAMES[0]); // looped
});

test('runtime draws stamps for a look', async () => {
  const s = 3;
  const empty = new Uint8Array(s * s);
  const plus = Uint8Array.from([0, 1, 0, 1, 1, 1, 0, 1, 0]);
  const full = new Uint8Array(s * s).fill(1);
  const masks = [empty, plus, full];
  const bg = [10, 20, 30];
  const cov = [2, 1, 1, 0];
  const col = [0, 1, 0, 4]; // entry 2 draws in ink (0); entry 3 points at the bg index
  const r = await run(buildPlayer(await base({ look: { s, masks, cov: Uint8Array.from(cov), col, bg } })));
  assert.equal(r.canvas.width, W * s);
  assert.equal(r.canvas.height, H * s);
  const out = [...PAL, bg];
  const buf = r.draws[0];
  for (let y = 0; y < H * s; y++) for (let x = 0; x < W * s; x++) {
    const v = FRAMES[0][(y / s | 0) * W + (x / s | 0)];
    const on = masks[cov[v]][(y % s) * s + (x % s)];
    assert.deepEqual(px(buf, y * W * s + x), [...(on ? out[col[v]] : bg), 255], `pixel ${x},${y}`);
  }
});

test('runtime glow matches the module, and ships only when on', async () => {
  const s = 3, full = new Uint8Array(s * s).fill(1), bg = [0, 0, 0];
  const look = { s, masks: [full], cov: Uint8Array.from([0, 0, 0, 0, 0]), col: [0, 1, 2, 3, 4], bg };
  const glow = { amount: 0.7, radius: 4, bg };
  const plainHtml = buildPlayer(await base({ look }));
  const html = buildPlayer(await base({ look, glow }));
  assert.doesNotMatch(plainHtml, /const glowFrame=/);
  assert.match(html, /const glowFrame=function glowFrame/);
  const [plain, lit] = [await run(plainHtml), await run(html)];
  const want = glowFrame(Uint8ClampedArray.from(plain.draws[0]), W * s, H * s, bg, glow.amount, glow.radius);
  assert.deepEqual(lit.draws[0], want);
  assert.notDeepEqual(lit.draws[0], plain.draws[0]);
});

test('runtime twinkles match the module at source time t0 + f / fps', async () => {
  // A bigger frame than the others, so some cells twinkle.
  const w = 40, h = 30, s = 4, n = w * h, bg = [0, 0, 0];
  const frames = [0, 1, 2].map(() => Uint8Array.from({ length: n }, (_, i) => (i % 7 ? 3 : 1)));
  const p = new FramePacker(w, h, PAL.length);
  for (const f of frames) p.add(f);
  const full = new Uint8Array(s * s).fill(1);
  const look = { s, masks: [full], cov: Uint8Array.from([0, 0, 0, 0, 0]), col: [0, 1, 2, 3, 4], bg };
  const meta = { w, h, fps: 10, palette: PAL, loop: true, title: 'T', bits: p.bits, frames: p.count, data: toBase64(await p.compress()), look };
  const twinkle = { amount: 1, bg, t0: 2.25 };
  const plain = await run(buildPlayer(meta));
  const lit = await run(buildPlayer({ ...meta, twinkle }));
  for (let f = 0; f < 3; f++) {
    if (f) { plain.advance(f === 1 ? 0 : 100); lit.advance(f === 1 ? 0 : 100); plain.advance(100); lit.advance(100); }
  }
  const W = w * s, H = h * s, k = plain.draws.length - 1, t = 2.25 + (k % 3) / 10;
  const want = Uint8ClampedArray.from(plain.draws[k]);
  const list = findTwinkles(want, W, H, s, bg, t, 1);
  drawTwinkles(want, W, H, s, list);
  assert.ok(list.length > 0, 'some twinkles in this frame');
  assert.deepEqual(lit.draws[k], want);
});

// A lens over a 12×8 grid: every cell is palette entry 1; the main look fills the cell,
// the lens look draws a plus. Which stamp a cell got tells whether it's inside the lens.
async function lensPiece(extra = {}) {
  const w = 12, h = 8, s = 3, n = w * h, bg = [10, 20, 30];
  const frames = [0, 1].map(() => new Uint8Array(n).fill(1));
  const p = new FramePacker(w, h, PAL.length);
  for (const f of frames) p.add(f);
  const full = new Uint8Array(s * s).fill(1), plus = Uint8Array.from([0, 1, 0, 1, 1, 1, 0, 1, 0]);
  const zero = Uint8Array.from([0, 0, 0, 0, 0]), col = [0, 1, 2, 3, 4];
  const look = { s, masks: [full], cov: zero, col, bg };
  const meta = { w, h, fps: 10, palette: PAL, loop: true, title: 'L', bits: p.bits, frames: p.count, data: toBase64(await p.compress()), look };
  const lens = { masks: [plus], cov: zero, col, r: 3, at: [6, 4], ...extra };
  // Cell (x, y) drawn with the plus? Its corner pixel is background then.
  const isLens = (buf, x, y) => px(buf, (y * s) * w * s + x * s)[0] === bg[0];
  return { w, h, s, meta, lens, isLens };
}

test('lens: cells inside draw the other look, cells outside the main one; edge is mixed', async () => {
  const { w, h, meta, lens, isLens } = await lensPiece();
  const html = buildPlayer({ ...meta, lens });
  assert.match(html, /const lensRT=function lensRT/);
  assert.match(html, /cursor:crosshair;touch-action:pan-y/);
  const r = await run(html, { reduce: true });
  const buf = r.draws[0];
  let edgeIn = 0, edgeOut = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x + 0.5 - 6, y + 0.5 - 4);
    if (d < 1.5) assert.ok(isLens(buf, x, y), `inside at ${x},${y}`);
    else if (d >= 4.5) assert.ok(!isLens(buf, x, y), `outside at ${x},${y}`);
    else if (isLens(buf, x, y)) edgeIn++; else edgeOut++;
  }
  assert.ok(edgeIn > 0 && edgeOut > 0, `dithered rim (${edgeIn} in, ${edgeOut} out)`);
});

test('lens: follows the pointer, and a touch tap moves it without pausing', async () => {
  const { s, meta, lens, isLens } = await lensPiece();
  const r = await run(buildPlayer({ ...meta, lens }));
  r.advance(0);
  // Point at cell (1, 1): the lens eases over within a few frames.
  r.fire('pointermove', { clientX: 1.5 * s, clientY: 1.5 * s });
  for (let i = 0; i < 12; i++) r.advance(100);
  const buf = r.draws[r.draws.length - 1];
  assert.ok(isLens(buf, 1, 1), 'lens moved under the pointer');
  assert.ok(!isLens(buf, 10, 7), 'far corner is the main look');

  const before = r.draws.length;
  r.fire('pointerdown', { pointerType: 'touch', clientX: 10.5 * s, clientY: 6.5 * s });
  r.click();
  for (let i = 0; i < 12; i++) r.advance(100);
  assert.ok(r.draws.length > before + 5, 'still playing after a tap');
  assert.ok(isLens(r.draws[r.draws.length - 1], 10, 6), 'lens moved to the tap');

  // Mouse clicks still pause.
  r.fire('pointerdown', { pointerType: 'mouse' });
  r.click();
  for (let i = 0; i < 4; i++) r.advance(100);
  assert.equal(r.pending(), 0);
});

test('lens: paused pieces redraw on pointer moves, then go idle', async () => {
  const { s, meta, lens, isLens } = await lensPiece();
  const r = await run(buildPlayer({ ...meta, lens }), { reduce: true });
  assert.equal(r.pending(), 0, 'nothing to do until the pointer moves');
  r.fire('pointermove', { clientX: 10.5 * s, clientY: 1.5 * s });
  for (let i = 0; i < 20 && r.pending(); i++) r.advance(100);
  assert.equal(r.pending(), 0, 'settles');
  assert.ok(r.draws.length > 1);
  assert.ok(isLens(r.draws[r.draws.length - 1], 10, 1));
});

test('no lens: no lens code, no crosshair, same pixels as before', async () => {
  const { meta } = await lensPiece();
  const html = buildPlayer(meta);
  assert.doesNotMatch(html, /lensRT=|crosshair|"lens"|"fit"/);
  assert.throws(() => buildPlayer({ ...meta, look: null, lens: { masks: [], cov: [], col: [], r: 2 } }), /stamped look/);
});

test('pauses on click, off-screen and for reduced motion; stills do not animate', async () => {
  const r = await run(buildPlayer(await base()));
  r.advance(0); r.advance(100);
  assert.equal(r.draws.length, 2);
  r.click();
  r.advance(100);
  assert.equal(r.pending(), 0);
  assert.equal(r.draws.length, 2);
  r.click();
  r.advance(0); r.advance(100);
  assert.equal(r.draws.length, 3);
  r.see(false);
  r.advance(100);
  assert.equal(r.pending(), 0);
  r.see(true);
  assert.equal(r.pending(), 1);

  const calm = await run(buildPlayer(await base()), { reduce: true });
  assert.equal(calm.draws.length, 1);
  assert.equal(calm.pending(), 0);
  calm.click();
  calm.advance(0); calm.advance(100);
  assert.equal(calm.draws.length, 2);

  const still = await run(buildPlayer(await base({}, [FRAMES[0]])));
  assert.equal(still.draws.length, 1);
  assert.equal(still.pending(), 0);
});

test('non-looping playback stops on the last frame and restarts on click', async () => {
  const r = await run(buildPlayer(await base({ loop: false })));
  for (let i = 0; i < 8; i++) r.advance(100);
  assert.equal(r.draws.length, 3);
  assert.equal(r.pending(), 0);
  r.click();
  r.advance(0); r.advance(100);
  assert.equal(r.draws.length, 4);
  assert.deepEqual(r.draws[3], r.draws[0]);
});
