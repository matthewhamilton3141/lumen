import { ALGORITHMS, DEFAULTS, DIFFUSION, PRESETS, hexToRgb, rgbToHex } from './dither.js';
import { framing, ASPECTS } from './frame.js';
import { makeRenderer } from './render.js';
import { createPreview } from './preview.js';
import { APP_DEFAULTS, LOOK_KEYS, SHARE_KEYS, hasEffects, withPreset as presetOn, roomForGlyphs as roomFor, toRender } from './settings.js';
import { addClip, removeClip, setIn, setOut, clipTime, clipFileName, normalise, parseTime } from './clips.js';
import { parseField, clampSnap } from './fields.js';
import { LOOKS, lookLevels } from './looks.js';
import { LOOK_PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);
// Clean address: /lumen/index.html → /lumen/ (keeps any ?query and #hash).
if (location.pathname.endsWith('/index.html')) history.replaceState(null, '', location.pathname.slice(0, -10) + location.search + location.hash);

// Decoding and encoding (Mediabunny, gifenc) load on first use, so the page and the
// demo start from a small bundle. Fetched when the browser is idle after start-up.
let exportMod = null;
const ex = () => (exportMod ||= import('./export.js'));
const STORE = 'lumen:settings';
// The app used to be called vid-dith: carry anything saved under the old name across once.
try {
  for (const k of ['settings', 'theme', 'open', 'muted']) {
    const old = localStorage.getItem(`vid-dith:${k}`);
    if (old !== null && localStorage.getItem(`lumen:${k}`) === null) localStorage.setItem(`lumen:${k}`, old);
  }
} catch {}

const BASE = APP_DEFAULTS;
const fx = () => hasEffects(S);

let S = structuredClone(BASE);
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch {} };

// Theme
const themeBtn = $('theme');
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  themeBtn.textContent = dark ? 'Light' : 'Dark';
}
let theme = null;
try { theme = localStorage.getItem('lumen:theme'); } catch {}
applyTheme(theme);
themeBtn.onclick = () => {
  const dark = themeBtn.textContent === 'Dark';
  theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('lumen:theme', theme); } catch {}
  applyTheme(theme);
};

// Controls
const sel = $('algorithm');
for (const [k, v] of Object.entries(ALGORITHMS)) sel.add(new Option(v, k));
const aspectSel = $('aspect');
for (const [k, v] of Object.entries(ASPECTS)) aspectSel.add(new Option(v, k));
aspectSel.onchange = () => { S.aspect = aspectSel.value; changed('frame'); };
const lookSel = $('look');
for (const [k, v] of Object.entries(LOOKS)) lookSel.add(new Option(v.label, k));
// ASCII glyphs need room: a 5×7 font is unreadable below ~8 px cells.
function roomForGlyphs() { Object.assign(S, roomFor(S)); }
lookSel.onchange = () => { S.look = lookSel.value; roomForGlyphs(); changed(); resize(); };
const presetSel = $('preset');
for (const [k, v] of Object.entries(PRESETS)) presetSel.add(new Option(v.name, k));
presetSel.add(new Option('Custom', 'custom'));

const fmt = {
  levels: (v) => (v == 2 ? '1-bit' : `${v} levels`),
  chLevels: (v) => `${v} → ${v ** 3} colours`,
  strength: (v) => `${Math.round(v * 100)}%`,
  gamma: (v) => (+v).toFixed(2),
  scale: (v) => (S.look === 'square' ? `${v}×` : `${v} px`),
  fps: (v) => `${v} fps`,
  width: (v) => v,
  glow: (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off'),
  twinkle: (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'Off'),
  glowSize: (v) => `${(+v).toFixed(1)} cells`,
  dotGain: (v) => (v > 0 ? `+${Math.round(v * 100)}%` : 'Off'),
};
const ranges = ['levels', 'strength', 'brightness', 'contrast', 'saturation', 'gamma', 'threshold', 'width', 'scale', 'fps', 'count', 'chLevels', 'glow', 'glowSize', 'twinkle', 'dotGain'];
const checks = ['serpentine', 'invert', 'audio', 'loop'];

// force: rewrite the value field even while it's being edited (after Enter or a nudge).
function fill(el, force) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', `${p}%`);
  const o = document.querySelector(`.val[data-for="${el.id}"]`);
  if (o && (force || document.activeElement !== o)) {
    o.value = (fmt[el.id] || ((v) => v))(el.value);
    o.size = Math.max(2, o.value.length);
  }
}

// Slider values are editable: type a number (units optional), Enter or leave to apply,
// Esc to cancel, ↑/↓ to nudge (Shift ×10). Double-click a slider or its label to reset.
// The wheel nudges a slider only while it (or its value) has focus, so scrolling the
// panel never changes settings by accident.
const PERCENT = new Set(['strength', 'glow', 'twinkle', 'dotGain']);
function setRange(el, v) {
  if (v === null || v === undefined) { fill(el, true); return; }
  if (+el.value !== v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  fill(el, true);
}
const spec = (el) => ({ min: +el.min, max: +el.max, step: +el.step || 1, percent: PERCENT.has(el.id) });
const nudge = (el, n) => setRange(el, clampSnap(+el.value + n * (+el.step || 1), spec(el)));
function defaultFor(k) {
  if (k === 'fps' && kind === 'video') return Math.min(60, Math.round(info.fps) || 30);
  if (S.look === 'ascii' && k === 'width') return Math.min(160, BASE.width);
  if (S.look === 'ascii' && k === 'scale') return Math.max(8, BASE.scale);
  return BASE[k];
}
function wheelNudge(el, ...targets) {
  let acc = 0;
  const onWheel = (e) => {
    if (!targets.includes(document.activeElement)) return;
    e.preventDefault();
    let d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? -e.deltaY : e.deltaX;
    if (e.deltaMode !== 0) d *= 40;
    const k = e.shiftKey ? 10 : 1;
    // A mouse-wheel notch is one step; trackpads send many small deltas, ~40 px a step.
    if (Math.abs(d) >= 50) { acc = 0; nudge(el, Math.sign(d) * k); return; }
    acc += d;
    while (Math.abs(acc) >= 40) { const sgn = Math.sign(acc); acc -= sgn * 40; nudge(el, sgn * k); }
  };
  for (const t of targets) t.addEventListener('wheel', onWheel, { passive: false });
}
for (const k of ranges) {
  const el = $(k), out = document.querySelector(`output[data-for="${k}"]`), label = el.closest('label');
  const name = (label.querySelector('span')?.textContent || label.firstChild.textContent).trim();
  const f = document.createElement('input');
  Object.assign(f, { type: 'text', className: 'val', spellcheck: false, autocomplete: 'off', inputMode: 'decimal' });
  f.dataset.for = k;
  f.setAttribute('aria-label', `${name} value`);
  f.title = 'Type a value. ↑/↓ to nudge, Shift for ×10. Double-click the slider to reset.';
  out.replaceWith(f);
  let before = '';
  f.onfocus = () => { before = f.value; f.select(); };
  f.onblur = () => { if (f.value !== before) setRange(el, parseField(f.value, spec(el))); else fill(el, true); };
  f.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setRange(el, parseField(f.value, spec(el))); before = f.value; f.select(); }
    else if (e.key === 'Escape') { e.preventDefault(); f.value = before; f.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudge(el, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      before = f.value; f.select();
    }
  };
  // Shift + arrows on the slider itself move 10 steps.
  el.addEventListener('keydown', (e) => {
    if (!e.shiftKey || !/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
    e.preventDefault();
    nudge(el, /Up|Right/.test(e.key) ? 10 : -10);
  });
  wheelNudge(el, el, f);
  label.addEventListener('mousedown', (e) => { if (e.detail > 1 && e.target !== f) e.preventDefault(); });
  label.addEventListener('dblclick', (e) => {
    if (e.target === f) return;
    const d = defaultFor(k);
    if (d !== undefined) setRange(el, clampSnap(+d, spec(el)));
  });
  label.title = `Double-click to reset ${name.toLowerCase()}`;
}

const segs = ['format', 'mode', 'fit', 'embed', 'embedFit'];
const autoBg = () => (S.mode === 'mono' ? S.paper : '#000000');

function syncUI() {
  sel.value = S.algorithm;
  if (!(S.look in LOOKS)) S.look = 'square';
  lookSel.value = S.look;
  const square = S.look === 'square';
  $('scale-label').textContent = square ? 'Export scale' : 'Cell size';
  $('bg-row').hidden = square;
  $('bg').value = S.bg || autoBg();
  $('bg-auto').setAttribute('aria-pressed', !S.bg);
  const isVideo = kind === 'video';
  if (kind === 'image' && (S.format === 'mp4' || S.format === 'mov')) S.format = 'png';
  for (const b of $('format').children) b.hidden = kind === 'image' && (b.dataset.v === 'mp4' || b.dataset.v === 'mov');
  $('time-group').hidden = !isVideo;
  $('clips-group').hidden = !isVideo;
  for (const k of ranges) { $(k).value = S[k]; fill($(k)); }
  for (const k of checks) $(k).checked = !!S[k];
  $('ink').value = S.ink; $('paper').value = S.paper;
  for (const k of segs) for (const b of $(k).children) b.setAttribute('aria-checked', b.dataset.v === S[k]);
  for (const el of document.querySelectorAll('[data-mode]')) el.hidden = !el.dataset.mode.split(' ').includes(S.mode);
  // Diamond halftone: dot size is the tone, so it picks its own levels; dot gain is its own.
  if (LOOKS[S.look].tone) $('levels-row').hidden = true;
  $('dot-gain-row').hidden = !LOOKS[S.look].spread;
  aspectSel.value = S.aspect;
  $('fit-row').hidden = S.aspect === 'original';
  for (const el of document.querySelectorAll('[data-show="diffusion"]')) el.hidden = !DIFFUSION.has(S.algorithm);
  for (const el of document.querySelectorAll('[data-show="amount"]')) el.hidden = S.algorithm === 'threshold';
  presetSel.value = S.preset in PRESETS ? S.preset : 'custom';
  renderSwatches();
  $('add-color').disabled = S.colors.length >= 16;
  $('remove-color').disabled = S.colors.length <= 2;
  for (const el of document.querySelectorAll('[data-fmt]')) el.hidden = !el.dataset.fmt.split(' ').includes(S.format) || ('video' in el.dataset && kind === 'image');
  for (const el of document.querySelectorAll('.transport [data-video]')) el.hidden = !isVideo;
  syncLooks();
  updateNotes();
  syncClips();
}

sel.onchange = () => { S.algorithm = sel.value; changed(); };
for (const k of ranges) $(k).oninput = (e) => { S[k] = +e.target.value; fill(e.target); changed(k); };
for (const k of checks) $(k).onchange = (e) => { S[k] = e.target.checked; changed(); };
$('ink').oninput = (e) => { S.ink = e.target.value; changed(); };
$('paper').oninput = (e) => { S.paper = e.target.value; changed(); };
$('swap-colors').onclick = () => { [S.ink, S.paper] = [S.paper, S.ink]; changed(); };
$('reset-colors').onclick = () => { S.ink = BASE.ink; S.paper = BASE.paper; changed(); };
for (const k of segs) for (const b of $(k).children) b.onclick = () => { S[k] = b.dataset.v; changed(k === 'fit' ? 'frame' : undefined); };
$('bg').oninput = (e) => { S.bg = e.target.value; changed(); };
$('bg-auto').onclick = () => { S.bg = null; changed(); };

// Collapsible groups remember whether they are open.
let openState = {};
try { openState = JSON.parse(localStorage.getItem('lumen:open') || '{}'); } catch {}
for (const d of document.querySelectorAll('details[data-g]')) {
  if (d.dataset.g in openState) d.open = !!openState[d.dataset.g];
  d.ontoggle = () => { openState[d.dataset.g] = d.open; try { localStorage.setItem('lumen:open', JSON.stringify(openState)); } catch {} };
}

// Palette swatches: update in place so an open colour picker isn't torn down.
const swatches = $('swatches');
function renderSwatches() {
  while (swatches.children.length > S.colors.length) swatches.lastChild.remove();
  while (swatches.children.length < S.colors.length) {
    const i = swatches.children.length;
    const el = document.createElement('input');
    el.type = 'color';
    el.oninput = () => { S.colors[i] = el.value; S.preset = 'custom'; changed(); };
    swatches.append(el);
  }
  S.colors.forEach((c, i) => {
    const el = swatches.children[i];
    if (el.value !== c) el.value = c;
    el.title = el.ariaLabel = `Colour ${i + 1}: ${c}`;
  });
}
presetSel.onchange = () => {
  if (presetSel.value in PRESETS) { S.preset = presetSel.value; S.colors = [...PRESETS[S.preset].colors]; }
  changed();
};
const luma = (h) => { const [r, g, b] = hexToRgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
$('add-color').onclick = () => {
  if (S.colors.length >= 16) return;
  // Midpoint between the two most distant neighbours in luma is a reasonable new slot.
  const sorted = [...S.colors].sort((a, b) => luma(a) - luma(b));
  let gap = 0, at = 0;
  for (let i = 1; i < sorted.length; i++) { const d = luma(sorted[i]) - luma(sorted[i - 1]); if (d > gap) { gap = d; at = i; } }
  const [a, b] = [hexToRgb(sorted[at - 1] || sorted[0]), hexToRgb(sorted[at])];
  S.colors.push(rgbToHex(a.map((v, j) => (v + b[j]) / 2)));
  S.preset = 'custom'; changed();
};
$('remove-color').onclick = () => { if (S.colors.length > 2) { S.colors.pop(); S.preset = 'custom'; changed(); } };
$('sort-colors').onclick = () => { S.colors.sort((a, b) => luma(a) - luma(b)); changed(); };
$('from-video').onclick = async () => {
  if (!file) return;
  const btn = $('from-video');
  btn.disabled = true; btn.textContent = 'Picking colours…';
  try {
    const st = settings();
    const pal = await (await ex()).paletteFromVideo(file, info, st, S.count, cutRanges()[0], frameOpts());
    S.colors = pal.map(rgbToHex); S.preset = 'custom'; S.mode = 'color';
    changed();
  } catch (err) {
    console.error(err); status(`Couldn't pick colours: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Pick colours from source';
  }
};

function changed(key) {
  save();
  if (dims.w && (key === undefined || key === 'glow' || key === 'twinkle')) pcell = previewCell();
  if (key !== undefined && ranges.includes(key)) updateNotes();
  else syncUI();
  if (key === 'frame') updateNotes();
  if (key === 'scale') fill($('scale'));
  if (key === 'width' || key === 'frame') resize();
  if (!vid.paused) return;
  render();
}

// Source: a video, an image, or the built-in demo animation shown before a file is loaded.
const vid = $('vid'), out = $('out'), view = $('view');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const DEMO = { kind: 'demo', width: 480, height: 300, duration: 0, fps: 30, rotation: 0, hasAudio: false, start: 0 };
const demo = document.createElement('canvas');
demo.width = DEMO.width; demo.height = DEMO.height;
const dctx = demo.getContext('2d');
let file = null, info = DEMO, url = null, bitmap = null, dims = { w: 0, h: 0, crop: null, fit: 'fill' };
let kind = 'demo';
let showOrig = false;

const srcEl = () => (kind === 'video' ? vid : kind === 'image' ? bitmap : demo);
const srcSize = () => (kind === 'video' ? [vid.videoWidth || info.width, vid.videoHeight || info.height]
  : kind === 'image' ? [bitmap.width, bitmap.height] : [demo.width, demo.height]);
const ready = () => !!dims.w && (kind === 'video' ? vid.readyState >= 2 : kind === 'image' ? !!bitmap : true);

const frameOpts = () => ({ aspect: S.aspect, fit: S.fit, long: S.width });
function resize() {
  dims = framing(info, frameOpts());
  work.width = dims.w; work.height = dims.h;
  updateNotes();
}

function updateNotes() {
  const { w, h } = dims;
  const W = w * S.scale, H = h * S.scale;
  const unit = S.look === 'square' ? 'dots' : 'cells';
  let n = `${w} × ${h} ${unit}`;
  if (S.format !== 'html' || S.look !== 'square' || fx()) n += ` → ${W} × ${H} px`;
  if ((S.format === 'mp4' || S.format === 'mov') && (W > 4096 || H > 4096)) n += '. Over 4096 px, most H.264 encoders refuse.';
  if (S.format === 'gif' && W * H > 1920 * 1080) n += '. Large GIFs get heavy.';
  $('size-note').textContent = n;

  const notes = {
    mp4: 'H.264. Use a scale of 3× or more so compression keeps the dots sharp.',
    mov: 'H.264 in a QuickTime container.',
    gif: fx()
      ? `${palCount()} exact colours, the rest of 256 go to glow and twinkles. GIF timing rounds to 1/100 s.`
      : `${palCount()} colours. GIF timing rounds to 1/100 s.`,
    png: kind === 'video' ? 'The frame at the playhead, lossless.' : 'Lossless.',
    html: S.embed === 'snippet'
      ? 'A canvas and a small script to paste into your own page. No dependencies. Pauses off screen.'
      : 'One self-contained file, canvas player, no dependencies. Click to pause.',
  };
  $('fmt-note').textContent = notes[S.format];
}
const palCount = () => (S.mode === 'color' ? S.colors.length : S.mode === 'original' ? S.chLevels ** 3 : lookLevels(S)) + (S.look === 'square' && !(fx()) ? 0 : 1);

const conv = toRender;
function settings() { return conv(S); }

// Looks other than square pixels are drawn at roughly the stage's pixel size.
let pcell = 4;
function previewCell() {
  const r = view.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(view).paddingLeft) * 2 || 0;
  const k = Math.min((r.width - pad) / dims.w, (r.height - pad) / dims.h) * (devicePixelRatio || 1);
  let s = Math.max(2, Math.min(16, Math.ceil(k) || 2));
  // Glow costs ~13 ns a pixel; it's soft anyway, so give the preview a smaller canvas.
  const budget = fx() ? 1.2e6 : 2.5e6;
  while (s > 1 && dims.w * dims.h * s * s > budget) s--;
  return s;
}
// Draw the source into a w×h context using the frame's crop / fit.
function drawSrc(ctx, w, h, crop, fit) {
  const el = srcEl(), [vw, vh] = srcSize();
  ctx.imageSmoothingQuality = 'high';
  if (crop) {
    // The element may report a slightly different intrinsic size than the demuxer; map crop through it.
    const kx = vw / info.width, ky = vh / info.height;
    ctx.drawImage(el, crop.left * kx, crop.top * ky, crop.width * kx, crop.height * ky, 0, 0, w, h);
  } else if (fit === 'contain') {
    const k = Math.min(w / vw, h / vh);
    const dw = vw * k, dh = vh * k;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    ctx.drawImage(el, 0, 0, w, h);
  }
}

// Source time of the frame on screen: twinkles are a function of it, like in exports.
const now = () => (kind === 'video' ? vid.currentTime : kind === 'demo' ? demoT : 0);
function render() {
  if (!ready()) return;
  const { w, h, crop, fit } = dims;
  drawSrc(wctx, w, h, crop, fit);
  thumbsSoon();
  // Square pixels without glow are drawn at cell size and scaled up crisply by CSS.
  out.classList.toggle('smooth', !showOrig && (S.look !== 'square' || fx()));
  sendFrame({ type: 'frame', rgba: wctx.getImageData(0, 0, w, h).data, w, h, settings: settings(), cell: pcell, orig: showOrig, t: now() });
}

new ResizeObserver(() => {
  if (!dims.w) return;
  const s = previewCell();
  if (s !== pcell) { pcell = s; if ((S.look !== 'square' || fx()) && vid.paused) render(); }
}).observe(view);

// Looks strip: every preset drawn live from the current frame.
const RESET = LOOK_KEYS;
const withPreset = (p) => presetOn(S, p);
function applyPreset(p) { Object.assign(S, withPreset(p)); roomForGlyphs(); changed(); resize(); }
const isActive = (p) => { const o = withPreset(p); return [...RESET, ...Object.keys(p.settings)].every((k) => JSON.stringify(o[k]) === JSON.stringify(S[k])); };

const TH = { fine: { w: 120, h: 75, s: 2 }, cell: { w: 40, h: 25, s: 6 } };
for (const t of Object.values(TH)) {
  t.c = document.createElement('canvas'); t.c.width = t.w; t.c.height = t.h;
  t.ctx = t.c.getContext('2d', { willReadFrequently: true });
}
const tiles = LOOK_PRESETS.map((p) => {
  const btn = document.createElement('button');
  btn.className = 'look'; btn.type = 'button'; btn.dataset.id = p.id;
  const c = document.createElement('canvas');
  c.width = 240; c.height = 150;
  const name = document.createElement('span');
  name.textContent = p.name;
  btn.append(c, name);
  btn.onclick = () => applyPreset(p);
  $('looks').append(btn);
  return { p, btn, c };
});
function syncLooks() { for (const t of tiles) t.btn.setAttribute('aria-pressed', isActive(t.p)); }

function drawThumbs() {
  if (!ready()) return;
  const [vw, vh] = srcSize();
  const sources = {};
  for (const [name, t] of Object.entries(TH)) {
    const k = Math.max(t.w / vw, t.h / vh);
    t.ctx.imageSmoothingQuality = 'high';
    t.ctx.drawImage(srcEl(), (t.w - vw * k) / 2, (t.h - vh * k) / 2, vw * k, vh * k);
    sources[name] = { rgba: t.ctx.getImageData(0, 0, t.w, t.h).data, w: t.w, h: t.h, s: t.s };
  }
  const list = tiles.map((t) => { const o = withPreset(t.p); return { settings: conv(o), grid: o.look === 'square' ? 'fine' : 'cell' }; });
  preview.thumbs({ type: 'thumbs', sources, list, t: now() });
}

// Preview: a worker draws on transferred canvases, so the main thread only grabs source
// frames. One frame is in flight at a time; while the worker is busy only the newest
// waiting frame is kept, so slow looks drop frames instead of stalling playback.
let busy = false, queued = null;
function sendFrame(m) {
  if (busy) { queued = m; return; }
  busy = true;
  preview.frame(m);
}
function frameDone() {
  busy = false;
  if (queued) { const m = queued; queued = null; sendFrame(m); }
}
function setupPreview() {
  const canvases = [out, ...tiles.map((t) => t.c)];
  if (window.Worker && out.transferControlToOffscreen) {
    let worker = null;
    try { worker = new Worker(new URL('./preview-worker.js', import.meta.url), { type: 'module' }); } catch (err) {
      console.warn('Preview worker unavailable; drawing on the main thread.', err);
    }
    if (worker) {
      const offs = canvases.map((c) => c.transferControlToOffscreen());
      worker.postMessage({ type: 'init', out: offs[0], tiles: offs.slice(1) }, offs);
      worker.onmessage = (e) => { if (e.data.type === 'done') frameDone(); };
      worker.onerror = (e) => console.error('Preview worker failed', e.message);
      return {
        frame: (m) => worker.postMessage(m, [m.rgba.buffer]),
        thumbs: (m) => worker.postMessage(m, Object.values(m.sources).map((g) => g.rgba.buffer)),
      };
    }
  }
  const p = createPreview(out, canvases.slice(1));
  return { frame: (m) => { try { p.frame(m); } finally { frameDone(); } }, thumbs: (m) => p.thumbs(m) };
}
const preview = setupPreview();

// At most twice a second, with a trailing update so the last frame always lands.
let thumbAt = 0, thumbTimer = 0;
function thumbsSoon() {
  const wait = 500 - (performance.now() - thumbAt);
  if (wait <= 0) { clearTimeout(thumbTimer); thumbTimer = 0; thumbAt = performance.now(); drawThumbs(); }
  else if (!thumbTimer) thumbTimer = setTimeout(() => { thumbTimer = 0; thumbAt = performance.now(); drawThumbs(); }, wait);
}

// Demo: soft drifting lights with a wide tonal range, so every look has something to chew on.
const BLOBS = [
  [0.30, 0.40, 0.42, 28, 0.9, 0.7, 0.0], [0.70, 0.55, 0.36, 200, 0.6, 1.1, 1.7], [0.50, 0.30, 0.30, 330, 1.2, 0.5, 3.1],
  [0.25, 0.75, 0.26, 150, 0.8, 0.9, 4.4], [0.80, 0.25, 0.22, 55, 1.4, 1.3, 5.2],
];
function drawDemo(sec) {
  const W = demo.width, H = demo.height, g = dctx;
  g.globalCompositeOperation = 'source-over';
  const bgd = g.createLinearGradient(0, 0, W, H);
  bgd.addColorStop(0, '#07070c'); bgd.addColorStop(1, '#3b3442');
  g.fillStyle = bgd; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'screen';
  for (const [bx, by, br, hue, fx, fy, ph] of BLOBS) {
    const x = (bx + 0.22 * Math.sin(sec * 0.35 * fx + ph)) * W;
    const y = (by + 0.24 * Math.cos(sec * 0.3 * fy + ph * 1.3)) * H;
    const r = br * W * (0.85 + 0.15 * Math.sin(sec * 0.5 + ph));
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsl(${hue} 85% 78%)`); rg.addColorStop(0.35, `hsl(${hue} 80% 52% / 0.75)`); rg.addColorStop(1, `hsl(${hue} 80% 40% / 0)`);
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  g.globalCompositeOperation = 'source-over';
}
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let demoAt = 0, demoT = 0;
function demoLoop(ms) {
  if (kind !== 'demo') return;
  if (ms - demoAt >= 33) { demoAt = ms; demoT = ms / 1000; drawDemo(demoT + 20); render(); }
  requestAnimationFrame(demoLoop);
}
function startDemo() {
  drawDemo(20);
  resize(); pcell = previewCell(); render();
  if (!still) requestAnimationFrame(demoLoop);
}

function loop() {
  // Previewing a clip: wrap back to its In point.
  // A clip that runs to the end comes back round via the video's own loop, at 0.
  if (looping && !vid.paused && (vid.currentTime >= looping.end - 0.01 || vid.currentTime < looping.start - 0.05)) vid.currentTime = looping.start;
  render();
  updateTime();
  if (!vid.paused) schedule();
}
function schedule() {
  if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

const t = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTime() {
  if (kind !== 'video') return;
  $('time').textContent = `${clipTime(vid.currentTime)} / ${clipTime(info.duration)}`;
  if (!seeking) { $('seek').value = (vid.currentTime / info.duration) * 1000 || 0; fill($('seek')); }
}

const PLAY = '<path d="M4 2.5v11l9-5.5z"/>';
const PAUSE = '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>';
vid.onplay = () => { $('play-icon').innerHTML = PAUSE; $('play').ariaLabel = 'Pause'; schedule(); };
vid.onpause = () => { $('play-icon').innerHTML = PLAY; $('play').ariaLabel = 'Play'; };

// Sound: on by default; remembered. If the browser blocks unmuted autoplay, fall back to muted.
const SPEAKER = '<path d="M2 6h3l4-3.5v11L5 10H2z"/>';
const WAVES = '<path d="M11 5.2a4 4 0 0 1 0 5.6M12.8 3.4a6.5 6.5 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.3"/>';
const CROSS = '<path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.3"/>';
let wantSound = true;
try { wantSound = localStorage.getItem('lumen:muted') !== '1'; } catch {}
function showMute() {
  $('mute-icon').innerHTML = SPEAKER + (vid.muted ? CROSS : WAVES);
  $('mute').ariaLabel = vid.muted ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-pressed', vid.muted);
  $('mute').hidden = kind !== 'video' || !info.hasAudio;
}
vid.muted = !wantSound;
vid.onvolumechange = showMute;
$('mute').onclick = () => {
  vid.muted = !vid.muted;
  try { localStorage.setItem('lumen:muted', vid.muted ? '1' : '0'); } catch {}
};
async function startPlayback() {
  try { await vid.play(); } catch {
    if (!vid.muted) { vid.muted = true; status('Sound was blocked by the browser. Press the speaker to turn it on.'); vid.play().catch(() => {}); }
  }
}
showMute();
vid.onseeked = () => { render(); updateTime(); };
$('play').onclick = () => (vid.paused ? vid.play() : vid.pause());

let seeking = false;
$('seek').oninput = (e) => { seeking = true; stopLooping(); fill(e.target); vid.currentTime = (e.target.value / 1000) * info.duration; };
$('seek').onchange = () => { seeking = false; };

$('orig').onclick = () => {
  showOrig = !showOrig;
  $('orig').setAttribute('aria-pressed', showOrig);
  render();
};

addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') $('orig').click();
  if (kind !== 'video') return;
  if (e.code === 'Space' && !e.target.closest('button, summary')) { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
  if (k === 'm') $('mute').click();
  if (k === 'i') $('set-t0').click();
  if (k === 'o') $('set-t1').click();
  if (k === 'a') $('add-clip').click();
});

// Clips: In → Out is the selection; Add clip keeps it in a list. Export writes one file
// per clip, or just the selection when the list is empty.
const t0 = $('t0'), t1 = $('t1');
let clips = [], looping = null;
// In / Out take m:ss.mmm, h:mm:ss.mmm or plain seconds; ↑/↓ step one frame (Shift: 1 s).
const readTime = (el) => { try { return parseTime(el.value); } catch { return NaN; } };
const selection = () => {
  const a = readTime(t0), b = readTime(t1);
  return { start: Number.isFinite(a) ? a : 0, end: t1.value.trim() === '' || !Number.isFinite(b) ? info.duration : b };
};
const showTime = (el, v) => { el.value = clipTime(v); el.dataset.ok = el.value; };
const setSel = (c) => { showTime(t0, c.start); showTime(t1, c.end); stopLooping(); syncClips(); };
for (const el of [t0, t1]) {
  const commit = () => {
    const v = readTime(el);
    if (!Number.isFinite(v)) { status(`Can't read "${el.value}". Use m:ss.mmm, like 1:07.640.`); el.value = el.dataset.ok || ''; return; }
    status('');
    showTime(el, Math.min(v, info.duration || v));
    stopLooping(); syncClips();
    if (vid.paused && kind === 'video') vid.currentTime = Math.min(v, info.duration);
  };
  el.onchange = commit;
  el.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); el.select(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.value = el.dataset.ok || ''; el.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = readTime(el), step = e.shiftKey ? 1 : 1 / (info.fps || 30);
      const v = Math.max(0, Math.min(info.duration, (Number.isFinite(cur) ? cur : 0) + (e.key === 'ArrowUp' ? step : -step)));
      el.value = clipTime(v); commit(); el.select();
    }
  };
  el.onfocus = () => el.select();
}
$('set-t0').onclick = () => setSel(setIn(selection(), vid.currentTime, info.duration));
$('set-t1').onclick = () => setSel(setOut(selection(), vid.currentTime, info.duration));
$('add-clip').onclick = () => {
  try {
    clips = addClip(clips, selection(), info.duration);
    status('');
    // Back to the whole video, ready to mark the next one.
    setSel({ start: 0, end: info.duration });
  } catch (err) { status(err.message); }
};
function stopLooping() { if (looping) { looping = null; syncClips(); } }
function previewClip(c) {
  looping = c;
  vid.currentTime = c.start;
  vid.play().catch(() => {});
  syncClips();
}

const pct = (v) => `${(v / info.duration) * 100}%`;
function syncClips() {
  if (kind !== 'video' || !info.duration) { $('export').textContent = 'Export'; return; }
  const marks = $('tl-marks');
  marks.replaceChildren();
  for (const c of clips) {
    const m = document.createElement('span');
    m.className = 'tl-clip' + (c === looping ? ' on' : '');
    m.style.left = pct(c.start); m.style.width = pct(c.end - c.start);
    marks.append(m);
  }
  const sel = selection();
  if (sel.start > 0.005 || sel.end < info.duration - 0.005) {
    const m = document.createElement('span');
    m.className = 'tl-sel';
    m.style.left = pct(Math.max(0, sel.start)); m.style.width = pct(Math.max(0, Math.min(info.duration, sel.end) - sel.start));
    marks.append(m);
  }

  const list = $('clips');
  list.replaceChildren(...clips.map((c, i) => {
    const li = document.createElement('li');
    if (c === looping) li.setAttribute('aria-current', 'true');
    const play = document.createElement('button');
    play.className = 'clip-play'; play.type = 'button';
    play.title = 'Play this clip on a loop';
    play.innerHTML = `<span class="n">${i + 1}</span><span>${clipTime(c.start)} – ${clipTime(c.end)}</span><span class="d">${(c.end - c.start).toFixed(3)} s</span>`;
    play.onclick = () => previewClip(c);
    const x = document.createElement('button');
    x.className = 'clip-x'; x.type = 'button'; x.textContent = '×';
    x.ariaLabel = `Remove clip ${i + 1}`;
    x.onclick = () => { if (looping === c) looping = null; clips = removeClip(clips, i); syncClips(); };
    li.append(play, x);
    return li;
  }));

  const n = clips.length, batch = n > 0 && S.format !== 'png';
  $('export').textContent = batch && n > 1 ? `Export ${n} clips` : 'Export';
  $('clips-note').textContent = n === 0
    ? 'I and O mark In and Out, A adds the clip. With no clips, Export uses In → Out.'
    : S.format === 'png' ? 'PNG saves the frame at the playhead; clips apply to the other formats.'
      : `Export writes ${n === 1 ? 'this clip' : `${n} files, one per clip`}.`;
}

// Ranges to export: the clips, or the In → Out selection.
function cutRanges() {
  if (kind !== 'video') return [{ start: 0, end: 1 }];
  return clips.length && S.format !== 'png' ? clips : [normalise(selection(), info.duration)];
}

// Loading
async function load(f) {
  status(''); $('copy').hidden = true;
  let i, bmp = null;
  try {
    i = await (await ex()).probe(f);
    if (i.kind === 'image') bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
  } catch (err) {
    status(`Couldn't read that file: ${err.message}`);
    return;
  }
  file = f; info = i; kind = i.kind === 'image' ? 'image' : 'video';
  clips = []; looping = null;
  bitmap?.close?.(); bitmap = bmp;
  if (url) URL.revokeObjectURL(url);
  url = null;
  $('drop').hidden = true; $('transport').hidden = false;
  $('export').disabled = false; $('from-video').disabled = false;
  $('meta').title = file.name;
  if (kind === 'image') {
    vid.pause(); vid.removeAttribute('src'); vid.load();
    $('meta').textContent = `${file.name} · ${info.width}×${info.height}`;
    resize(); pcell = previewCell(); syncUI(); showMute();
    render();
    return;
  }
  url = URL.createObjectURL(file);
  vid.src = url;
  showTime(t0, 0); showTime(t1, info.duration);
  // Export at the source's own rate by default; a lower rate drops frames and judders.
  S.fps = Math.min(60, Math.round(info.fps) || 30);
  $('meta').textContent = `${file.name} · ${info.width}×${info.height}${info.rotation ? ` (rotated ${info.rotation}°)` : ''} · ${info.fps} fps · ${t(info.duration)}`;
  resize(); pcell = previewCell(); syncUI();
  showMute();
  vid.onloadeddata = () => { render(); updateTime(); startPlayback(); };
}

$('file').onchange = (e) => e.target.files[0] && load(e.target.files[0]);
$('swap-file').onclick = () => $('file').click();
const stage = $('stage');
stage.ondragover = (e) => { e.preventDefault(); stage.classList.add('over'); };
stage.ondragleave = (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('over'); };
stage.ondrop = (e) => {
  e.preventDefault(); stage.classList.remove('over');
  const f = [...e.dataTransfer.files].find((f) => /^(video|image)\//.test(f.type) || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name));
  if (f) load(f); else status('That doesn\'t look like a video or image file.');
};

// Export
function status(s) { $('status').textContent = s; }
let job = null, snippet = '', lastExport = null;
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(snippet); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Copy failed'; }
  setTimeout(() => { $('copy').textContent = 'Copy snippet'; }, 1500);
};

$('export').onclick = async () => {
  if (!file || job) return;
  let list;
  try { list = cutRanges(); } catch (e) { status(e.message); return; }
  vid.pause();
  const ctl = new AbortController();
  job = { ctl, conversion: null };
  $('export').disabled = true; $('progress').hidden = false; status(''); $('copy').hidden = true;
  const prog = (p) => { $('bar').style.width = `${p * 100}%`; $('pct').textContent = `${Math.floor(p * 100)}%`; };
  prog(0);
  const t0ms = performance.now();
  const base = file.name.replace(/\.[^.]+$/, '');
  const snip = S.format === 'html' && S.embed === 'snippet';
  const tag = (S.look === 'square' ? 'dither' : S.look) + (snip ? '-embed' : '');
  const n = list.length;
  let total = 0, last = null, done = 0;
  try {
    const { exportVideo, exportGif, exportHtml, exportPng } = await ex();
    for (let i = 0; i < n; i++) {
      if (ctl.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      if (n > 1) status(`Clip ${i + 1} of ${n}…`);
      const opts = {
        file, settings: settings(), frame: dims, scale: S.scale, fps: S.fps, trim: list[i],
        onProgress: (p) => prog((i + p) / n), signal: ctl.signal,
      };
      let blob;
      if (S.format === 'mp4' || S.format === 'mov') {
        blob = await exportVideo({ ...opts, format: S.format, audio: S.audio, onConversion: (c) => (job.conversion = c) });
      } else if (S.format === 'gif') {
        blob = await exportGif({ ...opts, loop: S.loop || kind !== 'video' });
      } else if (S.format === 'png') {
        blob = await exportPng({ file, settings: opts.settings, frame: dims, scale: S.scale, time: kind === 'video' ? vid.currentTime : 0 });
      } else {
        blob = await exportHtml({ ...opts, loop: S.loop, title: n > 1 ? `${base} ${i + 1}` : base, embed: S.embed, fit: S.embedFit });
      }
      const name = clipFileName(base, i, n, tag, S.format);
      download(blob, name);
      last = { name, size: blob.size, type: blob.type, blob };
      total += blob.size; done++;
      prog((i + 1) / n);
    }
    lastExport = last;
    const secs = ((performance.now() - t0ms) / 1000).toFixed(1);
    if (n > 1) status(`Saved ${n} clips (${size(total)}) in ${secs} s.`);
    else if (S.format === 'html') {
      status(`${snip ? 'Embed' : 'Page'} is ${size(last.size)}. Saved ${last.name} in ${secs} s.`);
      if (snip) { snippet = await last.blob.text(); $('copy').hidden = false; }
    } else status(`Saved ${last.name} (${size(last.size)}) in ${secs} s.`);
  } catch (err) {
    const kept = done ? ` ${done} of ${n} saved.` : '';
    if (err.name === 'AbortError' || err.name === 'ConversionCanceledError') status(`Canceled.${kept}`);
    else { console.error(err); status(`Export failed: ${err.message}.${kept}`); }
  } finally {
    job = null;
    $('export').disabled = false; $('from-video').disabled = false; $('progress').hidden = true;
  }
};
$('cancel').onclick = () => { job?.ctl.abort(); job?.conversion?.cancel(); };

// Everything needed to repeat this export from the command line (npm run cut).
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
function exportCommand() {
  const look = Object.fromEntries(SHARE_KEYS.map((k) => [k, S[k]]));
  const parts = ['npm run cut --', shq(file ? file.name : 'input.mp4'), '--format', S.format];
  if (kind === 'video') {
    let list = clips;
    if (!list.length) try { list = [normalise(selection(), info.duration)]; } catch { list = []; }
    for (const c of list) parts.push('--clip', `${clipTime(c.start)}-${clipTime(c.end)}`);
    parts.push('--fps', S.fps);
    if (!S.audio && S.format !== 'gif' && S.format !== 'html') parts.push('--no-audio');
    if (!S.loop) parts.push('--once');
  }
  if (S.format === 'html' && S.embed === 'snippet') parts.push('--embed', 'snippet');
  parts.push('--settings', shq(JSON.stringify(look)));
  return parts.join(' ');
}
$('copy-cmd').onclick = async () => {
  try { await navigator.clipboard.writeText(exportCommand()); $('copy-cmd').textContent = 'Copied'; }
  catch { $('copy-cmd').textContent = 'Copy failed'; }
  setTimeout(() => { $('copy-cmd').textContent = 'Copy as command'; }, 1500);
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

syncUI();
startDemo();
(window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => ex().catch(() => { exportMod = null; }));

// Headless test hook: ?test lets a script drive load/export without the UI.
if (new URLSearchParams(location.search).has('test')) {
  const lazy = (name) => async (...a) => (await ex())[name](...a);
  window.__vd = { load, S, changed, framing, cutRanges, makeRenderer, settings, dims: () => dims,
    clips: () => clips, video: vid, exportCommand,
    paletteFromVideo: lazy('paletteFromVideo'), exportVideo: lazy('exportVideo'), exportGif: lazy('exportGif'),
    exportHtml: lazy('exportHtml'), exportPng: lazy('exportPng'), probe: lazy('probe'),
    LOOKS, LOOK_PRESETS, applyPreset, kind: () => kind, last: () => lastExport, snippet: () => snippet };
}
