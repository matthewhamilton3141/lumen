#!/usr/bin/env node
// Command-line exporter: the app's looks, dither and glow, with ffmpeg doing the
// decoding and encoding. One output file per --clip.
//
//   npm run cut -- input.mp4 --clip 0:01.250-0:02.500 --clip 5-6.5 --preset phosphor --format gif
//   npm run cut -- input.mp4 --settings '{…}'        (from the app's "Copy as command")
//   npm run cut -- input.mp4 --clip intro=0:05-0:09 --tile led,width=160 --tile bayer,width=390 \
//       --tile neonascii,width=160 --tile crt,algorithm=atkinson --tile-size 1920x1080   (2×2 grid)
//   npm run cut -- --presets                          (list preset ids)
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { makeRenderer } from '../src/render.js';
import { framing, ASPECTS } from '../src/frame.js';
import { APP_DEFAULTS, withPreset, roomForGlyphs, toRender } from '../src/settings.js';
import { LOOK_PRESETS } from '../src/presets.js';
import { LOOKS } from '../src/looks.js';
import { ALGORITHMS } from '../src/dither.js';
import { gifWriter, htmlWriter } from '../src/encode.js';
import { normalise, parseRange, parseTime, clipTime, clipFileName } from '../src/clips.js';

const HELP = `Usage: npm run cut -- <input> [options]

  -c, --clip START-END   a clip to export (repeatable), e.g. 0:01.250-0:02.500 or 1.25-2.5.
                         Name it with NAME=START-END to name the file. Without one, the whole video.
  -f, --format FMT       mp4 | mov | gif | html | png (default mp4; png for images)
  -p, --preset ID        a look from the strip (see --presets)
  -s, --settings JSON    settings from the app's "Copy as command" (JSON text or a .json file)
      --set KEY=VALUE    any single setting, e.g. --set glow=0.5 --set look=ascii (repeatable)
      --scale N          pixels per cell in the output
      --width N          dots / cells on the long side
      --fps N            output frame rate (default: the source's)
      --aspect A         original | 16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9, with --fit crop|contain
      --at TIME          png: the frame to save (default: each clip's start)
      --embed snippet    html: an embed snippet instead of a page
      --lens LOOK        html: a cursor lens that shows another look (square, led, halftone, ascii, scan)
                         over the same cells; it follows the pointer and drifts on its own
      --lens-size F      html: lens radius as a fraction of the shorter side, 0.05–0.6 (default 0.22)
      --once             gif / html: play once instead of looping
      --no-audio         mp4 / mov: drop the audio
      --crf N            mp4 / mov quality, lower is better (default 14)
      --maxrate RATE     mp4 / mov: cap the bitrate, e.g. 20M (for sites with upload limits)
      --resize WxH       scale the finished frame (lanczos), e.g. 1080x1216; one side may be -2 to keep the shape
      --tag NAME         file name suffix (default: the preset id, or the look)

  Grid: several looks side by side in one video (mp4 / mov / png), one decode and one encode.
      --tile SPEC        a tile: a preset and/or settings, e.g. led,width=160 or crt,algorithm=atkinson.
                         Repeat for each tile; they fill rows left to right, top to bottom.
      --cols N           tiles per row (default: a square-ish grid, 2 for 4 tiles)
      --tile-size WxH    pixels per tile. Each tile is drawn at the smallest whole cell size that
                         covers it, then centre-cropped (default: the largest tile's own size)
      --side WIDTH       the untouched source, WIDTH px wide, in a column to the right of the grid

  -o, --out DIR          where to write (default: next to the input)
      --force            overwrite existing files
      --presets          list the presets and exit`;

function fail(msg) { console.error(`cut: ${msg}`); process.exit(1); }

const { values: A, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clip: { type: 'string', short: 'c', multiple: true },
    format: { type: 'string', short: 'f' },
    preset: { type: 'string', short: 'p' },
    settings: { type: 'string', short: 's' },
    set: { type: 'string', multiple: true },
    scale: { type: 'string' }, width: { type: 'string' }, fps: { type: 'string' },
    aspect: { type: 'string' }, fit: { type: 'string' }, at: { type: 'string' },
    embed: { type: 'string' }, once: { type: 'boolean' }, 'no-audio': { type: 'boolean' },
    out: { type: 'string', short: 'o' }, force: { type: 'boolean' },
    presets: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    crf: { type: 'string' }, tag: { type: 'string' }, lens: { type: 'string' }, 'lens-size': { type: 'string' }, maxrate: { type: 'string' }, resize: { type: 'string' },
    tile: { type: 'string', multiple: true }, cols: { type: 'string' }, 'tile-size': { type: 'string' }, side: { type: 'string' },
  },
});

if (A.help) { console.log(HELP); process.exit(0); }
if (A.presets) {
  for (const p of LOOK_PRESETS) console.log(`${p.id.padEnd(11)} ${p.name}  (${LOOKS[p.settings.look].label}, ${ALGORITHMS[p.settings.algorithm]}${p.settings.glow ? ', glow' : ''})`);
  process.exit(0);
}
if (positionals.length !== 1) { console.error(HELP); process.exit(1); }
const input = resolve(positionals[0]);
if (!existsSync(input)) fail(`no such file: ${input}`);
for (const bin of ['ffmpeg', 'ffprobe']) {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); } catch { fail(`${bin} is needed (brew install ffmpeg).`); }
}

// ---- Source ---------------------------------------------------------------------------
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif)$/i;
function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) fail('no video track found in this file.');
  const rot = Math.abs(v.side_data_list?.find((d) => 'rotation' in d)?.rotation || 0) % 180 === 90;
  const rate = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };
  const still = IMAGE.test(file) && !/\.gif$/i.test(file);
  return {
    kind: still ? 'image' : 'video',
    width: rot ? v.height : v.width, height: rot ? v.width : v.height,
    fps: Math.round((rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30) * 100) / 100,
    duration: still ? 0 : +j.format?.duration || 0,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}
const info = probe(input);

// ---- Settings: defaults → copied app settings → preset → explicit overrides ------------
const parseValue = (v) => {
  if (/^-?\d+(\.\d+)?$/.test(v)) return +v;
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null') return null;
  if (/^[[{]/.test(v)) return JSON.parse(v);
  return v;
};
let S = structuredClone(APP_DEFAULTS);
if (A.settings) {
  const text = A.settings.trim().startsWith('{') ? A.settings : readFileSync(A.settings, 'utf8');
  try { Object.assign(S, JSON.parse(text)); } catch (e) { fail(`--settings isn't valid JSON: ${e.message}`); }
}
if (A.preset) {
  const p = LOOK_PRESETS.find((x) => x.id === A.preset || x.name.toLowerCase() === A.preset.toLowerCase());
  if (!p) fail(`unknown preset "${A.preset}". Try: ${LOOK_PRESETS.map((x) => x.id).join(', ')}`);
  S = roomForGlyphs(withPreset(S, p));
}
const sets = {};
for (const kv of A.set || []) {
  const i = kv.indexOf('=');
  if (i < 1) fail(`--set wants KEY=VALUE, got "${kv}"`);
  sets[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
}
for (const k of ['scale', 'width', 'fps']) if (A[k] !== undefined) sets[k] = +A[k];
if (A.aspect) sets.aspect = A.aspect;
if (A.fit) sets.fit = A.fit;
Object.assign(S, sets);
if (!('fps' in sets)) S.fps = Math.min(60, Math.round(info.fps) || 30);
if (!(S.look in LOOKS)) fail(`unknown look "${S.look}". Looks: ${Object.keys(LOOKS).join(', ')}`);
if (!(S.algorithm in ALGORITHMS)) fail(`unknown dither "${S.algorithm}". Dithers: ${Object.keys(ALGORITHMS).join(', ')}`);
if (!(S.aspect in ASPECTS)) fail(`unknown aspect "${S.aspect}".`);

const format = (A.format || (info.kind === 'image' ? 'png' : 'mp4')).toLowerCase();
if (!['mp4', 'mov', 'gif', 'html', 'png'].includes(format)) fail(`unknown format "${format}".`);
if (info.kind === 'image' && (format === 'mp4' || format === 'mov')) fail('MP4 and MOV need a video; use png, gif or html.');
if ((A.lens || A['lens-size']) && format !== 'html') fail('--lens and --lens-size work with -f html only (the lens runs in the browser).');
if (A.lens && !(A.lens in LOOKS)) fail(`unknown lens look "${A.lens}". Looks: ${Object.keys(LOOKS).join(', ')}`);
if (A['lens-size'] && !(+A['lens-size'] >= 0.05 && +A['lens-size'] <= 0.6)) fail('--lens-size wants a fraction between 0.05 and 0.6.');
if (A.resize && !/^(-2|\d+)x(-2|\d+)$/.test(A.resize)) fail('--resize wants WxH, e.g. 1080x1216 or 1080x-2');
if (A.maxrate && !/^\d+(\.\d+)?[kKmM]?$/.test(A.maxrate)) fail('--maxrate wants a rate like 20M or 8000k');
const crf = A.crf !== undefined ? Math.max(0, Math.min(51, +A.crf)) : 14;
const scale = Math.max(1, S.scale | 0);
const fps = Math.max(1, Math.min(120, +S.fps || 30));
const frame = framing(info, { aspect: S.aspect, fit: S.fit, long: S.width });

// ---- Grid tiles -----------------------------------------------------------------------
const findPreset = (id) => LOOK_PRESETS.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
let grid = null;
if (A.tile?.length) {
  if (!['mp4', 'mov', 'png'].includes(format)) fail('grids export as mp4, mov or png.');
  const tiles = A.tile.map((spec) => {
    let T = structuredClone(S), name = '';
    const kvs = {};
    for (const part of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
      const i = part.indexOf('=');
      if (i < 0) {
        const p = findPreset(part);
        if (!p) fail(`tile "${spec}": unknown preset "${part}". Try: ${LOOK_PRESETS.map((x) => x.id).join(', ')}`);
        T = roomForGlyphs(withPreset(T, p)); name = p.id;
      } else kvs[part.slice(0, i)] = parseValue(part.slice(i + 1));
    }
    Object.assign(T, kvs);
    if (!(T.look in LOOKS)) fail(`tile "${spec}": unknown look "${T.look}".`);
    if (!(T.algorithm in ALGORITHMS)) fail(`tile "${spec}": unknown dither "${T.algorithm}".`);
    return { spec, name: name || T.look, S: T, frame: framing(info, { aspect: T.aspect, fit: T.fit, long: T.width }) };
  });
  let TW, TH;
  if (A['tile-size']) {
    const m = A['tile-size'].match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!m) fail('--tile-size wants WxH, e.g. 1920x1080');
    [TW, TH] = [+m[1], +m[2]];
  } else {
    TW = Math.max(...tiles.map((t) => t.frame.w * Math.max(1, t.S.scale | 0)));
    TH = Math.max(...tiles.map((t) => t.frame.h * Math.max(1, t.S.scale | 0)));
  }
  for (const t of tiles) {
    // Smallest whole cell size that covers the tile; ASCII keeps room for its glyphs.
    t.scale = Math.max(Math.ceil(TW / t.frame.w), Math.ceil(TH / t.frame.h), t.S.look === 'ascii' ? 8 : 1);
    t.W = t.frame.w * t.scale; t.H = t.frame.h * t.scale;
    t.ox = Math.floor((t.W - TW) / 2); t.oy = Math.floor((t.H - TH) / 2);
  }
  const cols = Math.max(1, +A.cols || Math.ceil(Math.sqrt(tiles.length)));
  grid = { tiles, TW, TH, cols, rows: Math.ceil(tiles.length / cols) };
  grid.W = cols * TW; grid.H = grid.rows * TH;
}
const side = grid && A.side ? Math.max(2, Math.round(+A.side / 2) * 2) : 0;
if (A.side && !grid) fail('--side goes with --tile.');
if (side && info.kind !== 'video') fail('--side needs a video.');

// ---- Clips ----------------------------------------------------------------------------
let clips;
try {
  if (info.kind === 'image') clips = [{ start: 0, end: 0 }];
  else if (A.clip?.length) {
    clips = A.clip.map((c) => {
      const m = c.match(/^\s*([^=]+?)\s*=\s*(.+)$/);
      const clip = normalise(parseRange(m ? m[2] : c), info.duration);
      // A name becomes the file name, so keep it to safe characters.
      return m ? { ...clip, name: m[1].replace(/[^\w.-]+/g, '_') } : clip;
    });
  }
  else clips = [{ start: 0, end: info.duration }];
} catch (e) { fail(e.message); }

const outDir = resolve(A.out || dirname(input));
mkdirSync(outDir, { recursive: true });
const base = basename(input, extname(input));
const tag = (A.tag || (grid ? 'grid' : A.preset ? findPreset(A.preset).id : S.look === 'square' ? 'dither' : S.look))
  + (format === 'html' && A.embed === 'snippet' ? '-embed' : '');
const outputs = clips.map((c, i) => join(outDir, c.name ? `${c.name}-${tag}.${format}` : clipFileName(base, i, clips.length, tag, format)));
if (new Set(outputs).size !== outputs.length) fail('two clips would write the same file; give them different names.');
const clash = outputs.filter((p) => existsSync(p));
if (clash.length && !A.force) fail(`already exists (use --force to overwrite):\n  ${clash.join('\n  ')}`);

// ---- ffmpeg plumbing ------------------------------------------------------------------
// Same framing as the app: crop to the aspect, letterbox in black, or stretch to fill.
function frameFilter(fr) {
  const { w, h, crop, fit } = fr;
  if (crop) return `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},scale=${w}:${h}:flags=area`;
  if (fit === 'contain') return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=area,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  return `scale=${w}:${h}:flags=area`;
}

// Decoded frames at `fps`, framed to w×h, as RGBA buffers.
async function* decode(start, dur, maxFrames, fr = frame) {
  const { w, h } = fr, size = w * h * 4;
  const args = ['-v', 'error'];
  if (info.kind === 'video') args.push('-ss', String(start), '-t', String(dur));
  args.push('-i', input, '-an', '-vf', `${info.kind === 'video' ? `fps=${fps},` : ''}${frameFilter(fr)},format=rgba`,
    '-frames:v', String(maxFrames), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const done = once(ff, 'close');
  let buf = new Uint8ClampedArray(size), fill = 0;
  for await (const chunk of ff.stdout) {
    let o = 0;
    while (o < chunk.length) {
      const n = Math.min(size - fill, chunk.length - o);
      buf.set(chunk.subarray(o, o + n), fill);
      fill += n; o += n;
      if (fill === size) { yield buf; buf = new Uint8ClampedArray(size); fill = 0; }
    }
  }
  const [code] = await done;
  if (code !== 0) throw new Error(`ffmpeg couldn't decode: ${err.trim()}`);
}

// side: width of the untouched source, shown in a column to the right, vertically centred.
function encoder(out, W, H, start, dur, side = 0) {
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(fps), '-i', 'pipe:0'];
  const audio = format !== 'png' && !A['no-audio'] && info.hasAudio;
  if (audio || side) args.push('-ss', String(start), '-t', String(dur), '-i', input);
  // yuv420p needs even sizes; a 1 px black edge is added if not. --resize happens first.
  const even = (A.resize ? `scale=${A.resize.replace('x', ':')}:flags=lanczos,` : '') + 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black';
  if (side) {
    args.push('-filter_complex', `[1:v]fps=${fps},scale=${side}:-2:flags=lanczos,setsar=1[o];`
      + `[0:v]pad=${W + side}:${H}:0:0:black[g];[g][o]overlay=${W}:(${H}-h)/2:shortest=1,${even}[v]`, '-map', '[v]');
  } else args.push('-map', '0:v');
  if (audio) args.push('-map', '1:a:0');
  if (format === 'png') args.push('-frames:v', '1', '-update', '1');
  else {
    if (!side) args.push('-vf', even);
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps));
    if (A.maxrate) args.push('-maxrate', A.maxrate, '-bufsize', `${parseFloat(A.maxrate) * 2}${A.maxrate.replace(/[\d.]/g, '')}`, '-profile:v', 'high');
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push('-movflags', '+faststart');
  }
  args.push(out);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  ff.stdin.on('error', () => {}); // surfaces as a non-zero exit below
  const done = once(ff, 'close');
  return {
    async write(rgba) { if (!ff.stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))) await once(ff.stdin, "drain"); },
    async end() { ff.stdin.end(); const [code] = await done; if (code !== 0) throw new Error(`ffmpeg couldn't encode: ${err.trim()}`); },
  };
}

// ---- Export ---------------------------------------------------------------------------
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const progress = (s) => process.stderr.isTTY && process.stderr.write(`\r${s}\x1b[K`);
const look = `${LOOKS[S.look].label}, ${ALGORITHMS[S.algorithm]}, ${S.mode}${S.glow > 0 ? `, glow ${Math.round(S.glow * 100)}%` : ''}${S.twinkle > 0 ? `, twinkle ${Math.round(S.twinkle * 100)}%` : ''}`;
const lookOf = (T) => `${LOOKS[T.look].label}, ${ALGORITHMS[T.algorithm]}, ${T.mode}${T.glow > 0 ? `, glow ${Math.round(T.glow * 100)}%` : ''}${T.twinkle > 0 ? `, twinkle ${Math.round(T.twinkle * 100)}%` : ''}`;
const rate = format !== 'png' && info.kind === 'video' ? ` at ${fps} fps` : '';
if (grid) {
  console.log(`${basename(input)}: ${grid.cols}×${grid.rows} grid of ${grid.TW}×${grid.TH} tiles${side ? ` + source ${side} px wide at the side` : ''} → ${grid.W + side}×${grid.H} px, ${format.toUpperCase()}${rate}`);
  grid.tiles.forEach((t, i) => console.log(`  tile ${i + 1} ${t.name.padEnd(10)} ${t.frame.w}×${t.frame.h} cells × ${t.scale} px${t.ox || t.oy ? `, ${t.W}×${t.H} cropped` : ''}: ${lookOf(t.S)}`));
} else console.log(`${basename(input)}: ${frame.w}×${frame.h} cells → ${frame.w * scale}×${frame.h * scale} px, ${look}, ${format.toUpperCase()}${rate}`);

// One grid frame: every tile decoded in lockstep, rendered, centre-cropped into place.
async function exportGrid(c, out, label, n, i) {
  const { tiles, TW, TH, cols, W, H } = grid;
  const single = format === 'png';
  const t0s = single ? Math.min(A.at !== undefined ? parseTime(A.at) : c.start, Math.max(0, info.duration - 1 / fps)) : c.start;
  const dur = single ? 1 / fps + 0.05 : c.end - c.start;
  const frames = single ? 1 : n;
  for (const t of tiles) { t.ren = makeRenderer(t.frame.w, t.frame.h, t.scale, toRender(t.S)); t.buf = new Uint8ClampedArray(t.W * t.H * 4); }
  const its = tiles.map((t) => decode(t0s, dur, frames, t.frame)[Symbol.asyncIterator]());
  const enc = encoder(out, W, H, t0s, dur, side);
  for (let k = 0; k < frames; k++) {
    const got = await Promise.all(its.map((it) => it.next()));
    if (got.some((g) => g.done)) break;
    const img = new Uint8ClampedArray(W * H * 4);
    const time = t0s + k / fps;
    tiles.forEach((t, j) => {
      t.ren.run(got[j].value);
      t.ren.paint(t.buf, time);
      const x0 = (j % cols) * TW, y0 = Math.floor(j / cols) * TH;
      for (let y = 0; y < TH; y++) {
        const src = ((y + t.oy) * t.W + t.ox) * 4;
        img.set(t.buf.subarray(src, src + TW * 4), ((y0 + y) * W + x0) * 4);
      }
    });
    await enc.write(img);
    progress(`  ${i + 1}/${clips.length} ${label}  ${Math.round(((k + 1) / frames) * 100)}%`);
  }
  await Promise.all(its.map((it) => it.return?.()));
  await enc.end();
}

let total = 0;
for (let i = 0; i < clips.length; i++) {
  const t0 = performance.now();
  const c = clips[i], out = outputs[i];
  const label = (c.name ? `${c.name} ` : '') + (info.kind === 'video' ? `${clipTime(c.start)}–${clipTime(c.end)}` : 'image');
  const ren = makeRenderer(frame.w, frame.h, scale, toRender(S));
  const settings = { loop: !A.once, title: clips.length > 1 ? `${base} ${i + 1}` : base, embed: A.embed === 'snippet' ? 'snippet' : 'page', fit: S.embedFit, fps };
  try {
    if (grid) {
      await exportGrid(c, out, label, info.kind === 'video' ? Math.max(1, Math.floor((c.end - c.start) * fps + 1e-6)) : 1, i);
    } else if (format === 'png') {
      const at = A.at !== undefined ? parseTime(A.at) : c.start;
      const t = Math.min(at, Math.max(0, info.duration - 1 / fps));
      const enc = encoder(out, ren.W, ren.H, 0, 0);
      for await (const f of decode(t, 1 / fps + 0.05, 1)) {
        ren.run(f);
        await enc.write(ren.paint(new Uint8ClampedArray(ren.W * ren.H * 4), t));
      }
      await enc.end();
    } else {
      const dur = c.end - c.start;
      const n = info.kind === 'video' ? Math.max(1, Math.floor(dur * fps + 1e-6)) : 1;
      let k = 0;
      if (format === 'gif' || format === 'html') {
        // Frame k shows source time start + k / fps (drives twinkles).
        const w = format === 'gif' ? gifWriter(ren, fps) : htmlWriter(ren, frame.w, frame.h, c.start,
          A.lens ? { lens: { look: A.lens, size: A['lens-size'], settings: toRender(S) } } : {});
        for await (const f of decode(c.start, dur, n)) { w.add(f, c.start + k / fps); progress(`  ${i + 1}/${clips.length} ${label}  ${Math.round((++k / n) * 100)}%`); }
        writeFileSync(out, format === 'gif' ? w.finish(settings) : await w.finish(settings));
      } else {
        const enc = encoder(out, ren.W, ren.H, c.start, dur);
        for await (const f of decode(c.start, dur, n)) {
          ren.run(f);
          await enc.write(ren.paint(new Uint8ClampedArray(ren.W * ren.H * 4), c.start + k / fps));
          progress(`  ${i + 1}/${clips.length} ${label}  ${Math.round((++k / n) * 100)}%`);
        }
        await enc.end();
      }
    }
  } catch (e) { progress(''); fail(`${label}: ${e.message}`); }
  const bytes = statSync(out).size;
  total += bytes;
  progress('');
  console.log(`  ${i + 1}/${clips.length} ${label} → ${out} (${kb(bytes)}, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
if (clips.length > 1) console.log(`${clips.length} files, ${kb(total)}`);
