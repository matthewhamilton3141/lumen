import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, MovOutputFormat,
  BufferTarget, Conversion, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { GIFEncoder } from 'gifenc';
import { toLuma, dither, palette as makePalette, paint } from './dither.js';
import { FramePacker, toBase64 } from './pack.js';
import { buildPlayer } from './player.js';

export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');
  const [duration, stats, start] = await Promise.all([
    input.computeDuration(), track.computePacketStats(120), track.getFirstTimestamp(),
  ]);
  return {
    width: track.displayWidth, height: track.displayHeight, duration, start,
    fps: Math.round(stats.averagePacketRate * 100) / 100 || 30,
    hasAudio: !!(await input.getPrimaryAudioTrack()),
  };
}

// One dither pass: RGBA in -> indices + painted RGBA.
export function makeProcessor(w, h, settings) {
  const lum = new Float32Array(w * h);
  const idx = new Uint8Array(w * h);
  const pal = makePalette(settings.levels, settings.ink, settings.paper);
  return {
    pal,
    run(rgba) {
      toLuma(rgba, w, h, settings, lum);
      dither(lum, w, h, settings, idx);
      return idx;
    },
    paint(rgbaOut) { return paint(idx, pal, rgbaOut); },
  };
}

const canvas = (w, h) => {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d', { willReadFrequently: true })];
};

// MP4 / MOV through Mediabunny's conversion pipeline, so audio comes along.
export async function exportVideo({ file, format, settings, w, h, scale, fps, trim, audio = true, onProgress, onConversion }) {
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
      width: w, height: h, fit: 'fill', frameRate: fps,
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
export async function* frames(file, w, h, fps, trim, signal) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 2 });
  const [, ctx] = canvas(w, h);
  const n = Math.max(1, Math.floor((trim.end - trim.start) * fps + 1e-6));
  const ts = Array.from({ length: n }, (_, i) => trim.start + (i + 0.5) / fps);
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(ts)) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    if (wc) { ctx.clearRect(0, 0, w, h); ctx.drawImage(wc.canvas, 0, 0); }
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

export async function exportGif({ file, settings, w, h, scale, fps, trim, onProgress, signal }) {
  const proc = makeProcessor(w, h, settings);
  const gif = GIFEncoder();
  const big = new Uint8Array(w * scale * h * scale);
  const delay = 1000 / fps;
  let t = 0;
  for await (const f of frames(file, w, h, fps, trim, signal)) {
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

export async function exportHtml({ file, settings, w, h, fps, trim, loop = true, title, onProgress, signal }) {
  const proc = makeProcessor(w, h, settings);
  const packer = new FramePacker(w, h, settings.levels);
  for await (const f of frames(file, w, h, fps, trim, signal)) {
    packer.add(proc.run(f.rgba));
    onProgress?.(((f.i + 1) / f.n) * 0.95);
  }
  const data = toBase64(await packer.compress());
  onProgress?.(1);
  const html = buildPlayer({
    w, h, fps, frames: packer.count, levels: settings.levels, bits: packer.bits,
    palette: proc.pal, loop, data, title,
  });
  return new Blob([html], { type: 'text/html' });
}
