// Output geometry: pure, shared by preview and every exporter.

export const ASPECTS = { original: 'Original', '16:9': '16:9', '9:16': '9:16', '1:1': '1:1', '4:5': '4:5', '4:3': '4:3', '21:9': '21:9' };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Output geometry from source size, chosen aspect, crop/fit and long-side dot count.
// crop: centred source rectangle (display pixels); fit 'contain' letterboxes in black.
export function framing(info, { aspect = 'original', fit = 'crop', long = 320 }) {
  const srcA = info.width / info.height;
  const A = aspect in ASPECTS && aspect !== 'original' ? (([a, b]) => a / b)(aspect.split(':').map(Number)) : srcA;
  const L = Math.max(16, Math.min(long, Math.max(info.width, info.height)));
  const w = even(A >= 1 ? L : L * A);
  const h = even(A >= 1 ? L / A : L);
  const same = Math.abs(A - srcA) < 1e-3;
  if (same || fit !== 'crop') return { w, h, crop: null, fit: same ? 'fill' : 'contain' };
  let crop;
  if (srcA > A) {
    const cw = Math.round(info.height * A);
    crop = { left: Math.floor((info.width - cw) / 2), top: 0, width: cw, height: info.height };
  } else {
    const ch = Math.round(info.width / A);
    crop = { left: 0, top: Math.floor((info.height - ch) / 2), width: info.width, height: ch };
  }
  return { w, h, crop, fit: 'fill' };
}
