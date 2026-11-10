import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, MovOutputFormat,
  BufferTarget, Conversion, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { GIFEncoder, quantize } from 'gifenc';
import { toLuma, dither, palette as makePalette, paint, toRGB, ditherColor, sortByLuma } from './dither.js';
import { FramePacker, toBase64 } from './pack.js';
import { buildPlayer } from './player.js';
import { framing } from './frame.js';
export { framing, ASPECTS } from './frame.js';

export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');
  const [duration, stats, start] = await Promise.all([
    input.computeDuration(), track.computePacketStats(120), track.getFirstTimestamp(),
  ]);
  return {
    width: track.displayWidth, height: track.displayHeight, rotation: track.rotation, duration, start,
    fps: Math.round(stats.averagePacketRate * 100) / 100 || 30,
    hasAudio: !!(await input.getPrimaryAudioTrack()),
  };
}

// One dither pass: RGBA in -> palette indices, then paint to RGBA.
// settings.mode 'color' uses settings.colors ([[r,g,b]...]); otherwise ink→paper levels.
export function makeProcessor(w, h, settings) {
  const idx = new Uint8Array(w * h);
  if (settings.mode === 'original') return originalProcessor(w, h, settings, idx);
  const color = settings.mode === 'color' && settings.colors?.length >= 2;
  const pal = color ? settings.colors : makePalette(settings.levels, settings.ink, settings.paper);
  const buf = new Float32Array(w * h * (color ? 3 : 1));
  return {
    pal,
    run(rgba) {
      if (color) ditherColor(toRGB(rgba, w, h, settings, buf), w, h, settings, pal, idx);
      else dither(toLuma(rgba, w, h, settings, buf), w, h, settings, idx);
      return idx;
    },
    paint(rgbaOut) { return paint(idx, pal, rgbaOut); },
  };
}

// "Original colours": dither R, G and B independently with L levels each, so the
// output keeps the source's own colours. Palette is the L³ grid (≤ 216 for GIF).
function originalProcessor(w, h, settings, idx) {
  const L = Math.max(2, Math.min(6, settings.chLevels | 0 || 2));
  const pal = [];
  for (let r = 0; r < L; r++) for (let g = 0; g < L; g++) for (let b = 0; b < L; b++)
    pal.push([r, g, b].map((v) => Math.round((v * 255) / (L - 1))));
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const ch = [0, 1, 2].map(() => new Float32Array(n));
  const q = [0, 1, 2].map(() => new Uint8Array(n));
  const opts = { ...settings, levels: L };
  return {
    pal,
    run(rgba) {
      toRGB(rgba, w, h, settings, rgb);
      for (let i = 0; i < n; i++) { ch[0][i] = rgb[i * 3]; ch[1][i] = rgb[i * 3 + 1]; ch[2][i] = rgb[i * 3 + 2]; }
      for (let c = 0; c < 3; c++) dither(ch[c], w, h, opts, q[c]);
      for (let i = 0; i < n; i++) idx[i] = (q[0][i] * L + q[1][i]) * L + q[2][i];
      return idx;
    },
    paint(rgbaOut) { return paint(idx, pal, rgbaOut); },
  };
}

// Adaptive palette: sample frames across the clip, apply the tone controls, quantise.
export async function paletteFromVideo(file, info, settings, count, trim, frame) {
  const f0 = framing(info, { ...frame, long: 96 });
  const { w, h } = f0;
  const span = trim.end - trim.start;
  const samples = 12;
  const all = new Uint8ClampedArray(w * h * 4 * samples);
  let n = 0;
  for await (const f of frames(file, f0, samples / span, trim)) {
    const rgb = toRGB(f.rgba, w, h, settings);
    for (let i = 0; i < w * h; i++) all.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255], (n * w * h + i) * 4);
    if (++n >= samples) break;
  }
  return sortByLuma(quantize(all.subarray(0, n * w * h * 4), count, { format: 'rgb444' }));
}

const canvas = (w, h) => {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d', { willReadFrequently: true })];
};

// MP4 / MOV through Mediabunny's conversion pipeline, so audio comes along.
export async function exportVideo({ file, format, settings, frame, scale, fps, trim, audio = true, onProgress, onConversion }) {
  const { w, h } = frame;
  const W = w * scale, H = h * scale;
  const [small, sctx] = canvas(w, h);
  const [big, bctx] = canvas(W, H);
  bctx.imageSmoothingEnabled = false;
  const proc = makeProcessor(w, h, settings);
  const img = sctx.createImageData(w, h);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({
    format: format === 'mov' ? new MovOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const conversion = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    trim,
    video: {
      width: w, height: h, fit: frame.fit, frameRate: fps,
      ...(frame.crop && { crop: frame.crop }),
      // Bake rotation into pixels; otherwise the output could carry rotation metadata over our upright frames.
      allowTransformationMetadata: false,
      codec: 'avc', quality: QUALITY_VERY_HIGH, forceTranscode: true,
      processedWidth: W, processedHeight: H,
      process(sample) {
        sctx.clearRect(0, 0, w, h);
        sample.draw(sctx, 0, 0, w, h);
        proc.run(sctx.getImageData(0, 0, w, h).data);
        proc.paint(img.data);
        sctx.putImageData(img, 0, 0);
        bctx.drawImage(small, 0, 0, W, H);
        return big;
      },
    },
    audio: audio ? {} : { discard: true },
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
    throw new Error(`Can't encode this video here (${why}). Try a smaller size.`);
  }
  onConversion?.(conversion);
  conversion.onProgress = (p) => onProgress?.(p);
  await conversion.execute();
  return new Blob([output.target.buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' });
}

// Decoded frames at a fixed rate, resized to w×h.
export async function* frames(file, frame, fps, trim, signal) {
  const { w, h } = frame;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new CanvasSink(track, { width: w, height: h, fit: frame.fit, ...(frame.crop && { crop: frame.crop }), poolSize: 2 });
  const [, ctx] = canvas(w, h);
  const n = Math.max(1, Math.floor((trim.end - trim.start) * fps + 1e-6));
  const ts = Array.from({ length: n }, (_, i) => trim.start + (i + 0.5) / fps);
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(ts)) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    if (wc) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.drawImage(wc.canvas, 0, 0); }
    yield { rgba: ctx.getImageData(0, 0, w, h).data, i: i++, n };
  }
}

function upscaleIdx(idx, w, h, s, out) {
  if (s === 1) return idx;
  const W = w * s;
  for (let y = 0; y < h; y++) {
    const row = out.subarray(y * s * W, y * s * W + W);
    for (let x = 0; x < w; x++) row.fill(idx[y * w + x], x * s, x * s + s);
    for (let k = 1; k < s; k++) out.copyWithin((y * s + k) * W, y * s * W, y * s * W + W);
  }
  return out;
}

export async function exportGif({ file, settings, frame, scale, fps, trim, onProgress, signal }) {
  const { w, h } = frame;
  const proc = makeProcessor(w, h, settings);
  const gif = GIFEncoder();
  const big = new Uint8Array(w * scale * h * scale);
  const delay = 1000 / fps;
  let t = 0;
  for await (const f of frames(file, frame, fps, trim, signal)) {
    const idx = proc.run(f.rgba);
    // GIF delays are whole centiseconds; carry the remainder so long clips stay in sync.
    const d = Math.round((t + delay) / 10) * 10 - Math.round(t / 10) * 10;
    t += delay;
    gif.writeFrame(upscaleIdx(idx, w, h, scale, big), w * scale, h * scale, { palette: proc.pal, delay: d });
    onProgress?.((f.i + 1) / f.n);
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export async function exportHtml({ file, settings, frame, fps, trim, loop = true, title, onProgress, signal }) {
  const { w, h } = frame;
  const proc = makeProcessor(w, h, settings);
  const packer = new FramePacker(w, h, proc.pal.length);
  for await (const f of frames(file, frame, fps, trim, signal)) {
    packer.add(proc.run(f.rgba));
    onProgress?.(((f.i + 1) / f.n) * 0.95);
  }
  const data = toBase64(await packer.compress());
  onProgress?.(1);
  const html = buildPlayer({
    w, h, fps, frames: packer.count, levels: proc.pal.length, bits: packer.bits,
    palette: proc.pal, loop, data, title,
  });
  return new Blob([html], { type: 'text/html' });
}
