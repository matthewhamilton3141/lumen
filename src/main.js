import { ALGORITHMS, DEFAULTS, DIFFUSION, PRESETS, hexToRgb, rgbToHex } from './dither.js';
import { probe, makeProcessor, exportVideo, exportGif, exportHtml, paletteFromVideo, framing, ASPECTS } from './export.js';

const $ = (id) => document.getElementById(id);
const STORE = 'vid-dith:settings';

const BASE = {
  ...DEFAULTS,
  ink: '#000000', paper: '#ffffff',
  mode: 'mono', preset: 'cga', colors: [...PRESETS.cga.colors], count: 8, chLevels: 2,
  aspect: 'original', fit: 'crop',
  width: 320, scale: 4, fps: 24,
  format: 'mp4', audio: true, loop: true,
};

let S = { ...BASE };
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
try { theme = localStorage.getItem('vid-dith:theme'); } catch {}
applyTheme(theme);
themeBtn.onclick = () => {
  const dark = themeBtn.textContent === 'Dark';
  theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('vid-dith:theme', theme); } catch {}
  applyTheme(theme);
};

// Controls
const sel = $('algorithm');
for (const [k, v] of Object.entries(ALGORITHMS)) sel.add(new Option(v, k));
const aspectSel = $('aspect');
for (const [k, v] of Object.entries(ASPECTS)) aspectSel.add(new Option(v, k));
aspectSel.onchange = () => { S.aspect = aspectSel.value; changed('frame'); };
const presetSel = $('preset');
for (const [k, v] of Object.entries(PRESETS)) presetSel.add(new Option(v.name, k));
presetSel.add(new Option('Custom', 'custom'));

const fmt = {
  levels: (v) => (v == 2 ? '1-bit' : `${v} levels`),
  chLevels: (v) => `${v} → ${v ** 3} colours`,
  strength: (v) => `${Math.round(v * 100)}%`,
  gamma: (v) => (+v).toFixed(2),
  scale: (v) => `${v}×`,
  fps: (v) => `${v} fps`,
  width: (v) => v,
};
const ranges = ['levels', 'strength', 'brightness', 'contrast', 'saturation', 'gamma', 'threshold', 'width', 'scale', 'fps', 'count', 'chLevels'];
const checks = ['serpentine', 'invert', 'audio', 'loop'];

function fill(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', `${p}%`);
  const o = document.querySelector(`output[data-for="${el.id}"]`);
  if (o) o.textContent = (fmt[el.id] || ((v) => v))(el.value);
}

function syncUI() {
  sel.value = S.algorithm;
  for (const k of ranges) { $(k).value = S[k]; fill($(k)); }
  for (const k of checks) $(k).checked = !!S[k];
  $('ink').value = S.ink; $('paper').value = S.paper;
  for (const b of $('format').children) b.setAttribute('aria-checked', b.dataset.v === S.format);
  for (const b of $('mode').children) b.setAttribute('aria-checked', b.dataset.v === S.mode);
  for (const el of document.querySelectorAll('[data-mode]')) el.hidden = !el.dataset.mode.split(' ').includes(S.mode);
  aspectSel.value = S.aspect;
  for (const b of $('fit').children) b.setAttribute('aria-checked', b.dataset.v === S.fit);
  $('fit-row').hidden = S.aspect === 'original';
  for (const el of document.querySelectorAll('[data-show="diffusion"]')) el.hidden = !DIFFUSION.has(S.algorithm);
  for (const el of document.querySelectorAll('[data-show="amount"]')) el.hidden = S.algorithm === 'threshold';
  presetSel.value = S.preset in PRESETS ? S.preset : 'custom';
  renderSwatches();
  $('add-color').disabled = S.colors.length >= 16;
  $('remove-color').disabled = S.colors.length <= 2;
  for (const el of document.querySelectorAll('[data-fmt]')) el.hidden = !el.dataset.fmt.split(' ').includes(S.format);
  updateNotes();
}

sel.onchange = () => { S.algorithm = sel.value; changed(); };
for (const k of ranges) $(k).oninput = (e) => { S[k] = +e.target.value; fill(e.target); changed(k); };
for (const k of checks) $(k).onchange = (e) => { S[k] = e.target.checked; changed(); };
$('ink').oninput = (e) => { S.ink = e.target.value; changed(); };
$('paper').oninput = (e) => { S.paper = e.target.value; changed(); };
$('swap-colors').onclick = () => { [S.ink, S.paper] = [S.paper, S.ink]; changed(); };
$('reset-colors').onclick = () => { S.ink = BASE.ink; S.paper = BASE.paper; changed(); };
for (const b of $('format').children) b.onclick = () => { S.format = b.dataset.v; changed(); };
for (const b of $('mode').children) b.onclick = () => { S.mode = b.dataset.v; changed(); };
for (const b of $('fit').children) b.onclick = () => { S.fit = b.dataset.v; changed('frame'); };

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
    const pal = await paletteFromVideo(file, info, st, S.count, trim(), frameOpts());
    S.colors = pal.map(rgbToHex); S.preset = 'custom'; S.mode = 'color';
    changed();
  } catch (err) {
    console.error(err); status(`Couldn't pick colours: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Pick colours from video';
  }
};

function changed(key) {
  save();
  if (key !== undefined && ranges.includes(key)) updateNotes();
  else syncUI();
  if (key === 'frame') updateNotes();
  if (key === 'width' || key === 'frame') resize();
  if (!vid.paused) return;
  render();
}

// Video
const vid = $('vid'), out = $('out'), octx = out.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
let file = null, info = null, url = null, dims = { w: 0, h: 0, crop: null, fit: 'fill' };
let showOrig = false;

const frameOpts = () => ({ aspect: S.aspect, fit: S.fit, long: S.width });
function resize() {
  if (!info) return;
  dims = framing(info, frameOpts());
  work.width = out.width = dims.w;
  work.height = out.height = dims.h;
  cache.key = '';
  updateNotes();
}

function updateNotes() {
  if (!info) { $('size-note').textContent = ''; $('fmt-note').textContent = ''; return; }
  const { w, h } = dims;
  const W = w * S.scale, H = h * S.scale;
  let n = `${w} × ${h} dots`;
  if (S.format !== 'html') n += ` → ${W} × ${H} px`;
  if ((S.format === 'mp4' || S.format === 'mov') && (W > 4096 || H > 4096)) n += '. Over 4096 px, most H.264 encoders refuse.';
  if (S.format === 'gif' && W * H > 1920 * 1080) n += '. Large GIFs get heavy.';
  $('size-note').textContent = n;

  const notes = {
    mp4: 'H.264. Use a scale of 3× or more so compression keeps the dots sharp.',
    mov: 'H.264 in a QuickTime container.',
    gif: `${palCount()} colours. GIF timing rounds to 1/100 s.`,
    html: 'One self-contained file, canvas player, no dependencies. Click to pause.',
  };
  $('fmt-note').textContent = notes[S.format];
}
const palCount = () => (S.mode === 'color' ? S.colors.length : S.mode === 'original' ? S.chLevels ** 3 : S.levels);

function settings() {
  return { ...S, ink: hexToRgb(S.ink), paper: hexToRgb(S.paper), colors: S.colors.map(hexToRgb) };
}

// Processor is rebuilt only when settings or size change.
let cache = { key: '', p: null };
function processor() {
  const st = settings();
  const key = JSON.stringify([dims, st]);
  if (cache.key !== key) cache = { key, p: makeProcessor(dims.w, dims.h, st) };
  return cache.p;
}

function render() {
  if (!info || !dims.w || vid.readyState < 2) return;
  const { w, h, crop, fit } = dims;
  wctx.imageSmoothingQuality = 'high';
  // The <video> may report a slightly different intrinsic size than the demuxer; map crop through it.
  const vw = vid.videoWidth || info.width, vh = vid.videoHeight || info.height;
  if (crop) {
    const kx = vw / info.width, ky = vh / info.height;
    wctx.drawImage(vid, crop.left * kx, crop.top * ky, crop.width * kx, crop.height * ky, 0, 0, w, h);
  } else if (fit === 'contain') {
    const k = Math.min(w / vw, h / vh);
    const dw = vw * k, dh = vh * k;
    wctx.fillStyle = '#000'; wctx.fillRect(0, 0, w, h);
    wctx.drawImage(vid, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    wctx.drawImage(vid, 0, 0, w, h);
  }
  if (showOrig) { octx.drawImage(work, 0, 0); return; }
  const img = wctx.getImageData(0, 0, w, h);
  const p = processor();
  p.run(img.data);
  p.paint(img.data);
  octx.putImageData(img, 0, 0);
}

function loop() {
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
  if (!info) return;
  $('time').textContent = `${t(vid.currentTime)} / ${t(info.duration)}`;
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
try { wantSound = localStorage.getItem('vid-dith:muted') !== '1'; } catch {}
function showMute() {
  $('mute-icon').innerHTML = SPEAKER + (vid.muted ? CROSS : WAVES);
  $('mute').ariaLabel = vid.muted ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-pressed', vid.muted);
  $('mute').hidden = info ? !info.hasAudio : false;
}
vid.muted = !wantSound;
vid.onvolumechange = showMute;
$('mute').onclick = () => {
  vid.muted = !vid.muted;
  try { localStorage.setItem('vid-dith:muted', vid.muted ? '1' : '0'); } catch {}
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
$('seek').oninput = (e) => { seeking = true; fill(e.target); vid.currentTime = (e.target.value / 1000) * info.duration; };
$('seek').onchange = () => { seeking = false; };

$('orig').onclick = () => {
  showOrig = !showOrig;
  $('orig').setAttribute('aria-pressed', showOrig);
  render();
};

addEventListener('keydown', (e) => {
  if (!info || e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
  if (e.key === 'o') $('orig').click();
  if (e.key === 'm') $('mute').click();
});

// Trim
const t0 = $('t0'), t1 = $('t1');
$('set-t0').onclick = () => { t0.value = vid.currentTime.toFixed(2); };
$('set-t1').onclick = () => { t1.value = vid.currentTime.toFixed(2); };
function trim() {
  const a = Math.max(0, +t0.value || 0);
  const b = Math.min(info.duration, +t1.value || info.duration);
  if (!(b > a)) throw new Error('End must be after start.');
  return { start: a, end: b };
}

// Loading
async function load(f) {
  status('');
  try {
    const i = await probe(f);
    file = f; info = i;
  } catch (err) {
    status(`Couldn't read that file: ${err.message}`);
    return;
  }
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  vid.src = url;
  $('drop').hidden = true; out.hidden = false; $('transport').hidden = false;
  $('export').disabled = false; $('from-video').disabled = false;
  t0.value = 0; t1.value = info.duration.toFixed(2); t1.max = t0.max = info.duration.toFixed(2);
  S.fps = Math.min(S.fps, Math.round(info.fps) || 60);
  $('meta').textContent = `${file.name} · ${info.width}×${info.height}${info.rotation ? ` (rotated ${info.rotation}°)` : ''} · ${info.fps} fps · ${t(info.duration)}`;
  $('meta').title = file.name;
  resize(); syncUI();
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
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name));
  if (f) load(f); else status('That doesn\'t look like a video file.');
};

// Export
function status(s) { $('status').textContent = s; }
let job = null;

$('export').onclick = async () => {
  if (!file || job) return;
  let tr;
  try { tr = trim(); } catch (e) { status(e.message); return; }
  vid.pause();
  const ctl = new AbortController();
  job = { ctl, conversion: null };
  $('export').disabled = true; $('progress').hidden = false; status('');
  const prog = (p) => { $('bar').style.width = `${p * 100}%`; $('pct').textContent = `${Math.floor(p * 100)}%`; };
  prog(0);
  const t0ms = performance.now();
  const opts = {
    file, settings: settings(), frame: dims, scale: S.scale, fps: S.fps, trim: tr,
    onProgress: prog, signal: ctl.signal,
  };
  try {
    let blob;
    if (S.format === 'mp4' || S.format === 'mov') {
      blob = await exportVideo({ ...opts, format: S.format, audio: S.audio, onConversion: (c) => (job.conversion = c) });
    } else if (S.format === 'gif') {
      blob = await exportGif(opts);
    } else {
      blob = await exportHtml({ ...opts, loop: S.loop, title: file.name.replace(/\.[^.]+$/, '') });
    }
    if (S.format === 'gif' && !S.loop) blob = await gifOnce(blob);
    const name = `${file.name.replace(/\.[^.]+$/, '')}-dither.${S.format}`;
    download(blob, name);
    const secs = ((performance.now() - t0ms) / 1000).toFixed(1);
    status(`Saved ${name} (${size(blob.size)}) in ${secs} s.`);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'ConversionCanceledError') status('Canceled.');
    else { console.error(err); status(`Export failed: ${err.message}`); }
  } finally {
    job = null;
    $('export').disabled = false; $('from-video').disabled = false; $('progress').hidden = true;
  }
};
$('cancel').onclick = () => { job?.ctl.abort(); job?.conversion?.cancel(); };

// gifenc always writes "loop forever"; patch the NETSCAPE loop count to play once.
async function gifOnce(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < b.length - 16; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xff && b[i + 2] === 0x0b && String.fromCharCode(...b.subarray(i + 3, i + 11)) === 'NETSCAPE') {
      // Remove the whole 19-byte application extension.
      return new Blob([b.subarray(0, i), b.subarray(i + 19)], { type: 'image/gif' });
    }
  }
  return blob;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

syncUI();

// Headless test hook: ?test lets a script drive load/export without the UI.
if (new URLSearchParams(location.search).has('test')) {
  window.__vd = { load, S, changed, framing, paletteFromVideo, trim, exportVideo, exportGif, exportHtml, probe, settings, dims: () => dims };
}
