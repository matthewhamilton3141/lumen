import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, MovOutputFormat,
  BufferTarget, Conversion, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { toRGB, sortByLuma } from './dither.js';
import { makeProcessor, makeRenderer } from './render.js';
import { isImage, decodeImage, drawFramed } from './source.js';
import { gifWriter, htmlWriter, quantize } from './encode.js';
import { framing } from './frame.js';
export { framing, ASPECTS } from './frame.js';
export { makeProcessor, makeRenderer };

export async function probe(file) {
  if (isImage(file)) {
    const bmp = await decodeImage(file);
    return { kind: 'image', width: bmp.width, height: bmp.height, rotation: 0, duration: 0, start: 0, fps: 0, hasAudio: false };
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');
  const [duration, stats, start] = await Promise.all([
    input.computeDuration(), track.computePacketStats(120), track.getFirstTimestamp(),
  ]);
  return {
    kind: 'video', width: track.displayWidth, height: track.displayHeight, rotation: track.rotation, duration, start,
    fps: Math.round(stats.averagePacketRate * 100) / 100 || 30,
    hasAudio: !!(await input.getPrimaryAudioTrack()),
  };
}

// Adaptive palette: sample frames across the clip, apply the tone controls, quantise.
export async function paletteFromVideo(file, info, settings, count, trim, frame) {
  const f0 = framing(info, { ...frame, long: 96 });
  const { w, h } = f0;
  const span = Math.max(1e-3, trim.end - trim.start);
  const samples = isImage(file) ? 1 : 12;
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
  if (isImage(file)) throw new Error('MP4 and MOV need a video. Export a still image as PNG, GIF or HTML.');
  const { w, h } = frame;
  const W = w * scale, H = h * scale;
  const [small, sctx] = canvas(w, h);
  const [big, bctx] = canvas(W, H);
  const ren = makeRenderer(w, h, scale, settings);
  const img = bctx.createImageData(W, H);

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
        ren.run(sctx.getImageData(0, 0, w, h).data);
        // Output timestamps start at 0; twinkles follow source time.
        ren.paint(img.data, sample.timestamp + (trim?.start || 0));
        bctx.putImageData(img, 0, 0);
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
  if (isImage(file)) {
    const [, ictx] = canvas(w, h);
    drawFramed(ictx, await decodeImage(file), frame);
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    yield { rgba: ictx.getImageData(0, 0, w, h).data, i: 0, n: 1, t: 0 };
    return;
  }
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
    yield { rgba: ctx.getImageData(0, 0, w, h).data, i, n, t: ts[i++] };
  }
}

export async function exportGif({ file, settings, frame, scale, fps, trim, loop = true, onProgress, signal }) {
  const { w, h } = frame;
  const gif = gifWriter(makeRenderer(w, h, scale, settings), fps);
  for await (const f of frames(file, frame, fps, trim, signal)) {
    gif.add(f.rgba, f.t);
    onProgress?.((f.i + 1) / f.n);
  }
  return new Blob([gif.finish({ loop })], { type: 'image/gif' });
}

export async function exportHtml({ file, settings, frame, scale = 1, fps, trim, loop = true, title, embed = 'page', fit = 'contain', onProgress, signal }) {
  const { w, h } = frame;
  const page = htmlWriter(makeRenderer(w, h, scale, settings), w, h, isImage(file) ? 0 : trim.start + 0.5 / (fps || 1));
  for await (const f of frames(file, frame, fps, trim, signal)) {
    page.add(f.rgba);
    onProgress?.(((f.i + 1) / f.n) * 0.95);
  }
  const html = await page.finish({ fps, loop, title, embed, fit });
  onProgress?.(1);
  return new Blob([html], { type: 'text/html' });
}

// One frame as a PNG: the frame at `time` seconds (clamped into the clip), or the image itself.
export async function exportPng({ file, settings, frame, scale = 1, time = 0 }) {
  const { w, h } = frame;
  let trim = { start: 0, end: 0 }, fps = 1;
  if (!isImage(file)) {
    const info = await probe(file);
    const step = 1 / (info.fps || 30);
    const t = Math.min(Math.max(time, info.start), Math.max(info.start, info.start + info.duration - step));
    // frames() samples at start + 0.5/fps, so this lands exactly on t.
    fps = 1 / step;
    trim = { start: t - step / 2, end: t + step / 2 };
  }
  const ren = makeRenderer(w, h, scale, settings);
  const [big, bctx] = canvas(ren.W, ren.H);
  const img = bctx.createImageData(ren.W, ren.H);
  for await (const f of frames(file, frame, fps, trim)) {
    ren.run(f.rgba);
    ren.paint(img.data, f.t);
    bctx.putImageData(img, 0, 0);
    break;
  }
  return big.convertToBlob({ type: 'image/png' });
}
