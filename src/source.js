// Still-image input: detection, decoding and framing onto a canvas.

const EXT = /\.(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i;

export const isImage = (file) => (file.type ? file.type.startsWith('image/') : EXT.test(file.name || ''));

// Decoded upright (EXIF orientation applied). Cached per file; ImageBitmaps are cheap to keep.
const cache = new WeakMap();
export function decodeImage(file) {
  let p = cache.get(file);
  if (!p) {
    p = createImageBitmap(file, { imageOrientation: 'from-image' });
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}

// Same framing rules as video: crop rectangle, stretch to fill, or contain with black bars.
export function drawFramed(ctx, bmp, frame) {
  const { w, h, crop, fit } = frame;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (crop) ctx.drawImage(bmp, crop.left, crop.top, crop.width, crop.height, 0, 0, w, h);
  else if (fit === 'contain') {
    const k = Math.min(w / bmp.width, h / bmp.height);
    const dw = bmp.width * k, dh = bmp.height * k;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else ctx.drawImage(bmp, 0, 0, w, h);
}
