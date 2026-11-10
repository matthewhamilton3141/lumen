// Dither core. Pure functions, no DOM: runs in the browser and in Node tests.
// Input: luminance 0..255 (Float32Array, w*h). Output: level index per pixel (Uint8Array).

import { blueNoise } from './bluenoise.js';

export const ALGORITHMS = {
  threshold: 'Threshold',
  bayer2: 'Bayer 2×2',
  bayer4: 'Bayer 4×4',
  bayer8: 'Bayer 8×8',
  bluenoise: 'Blue noise',
  floyd: 'Floyd–Steinberg',
  atkinson: 'Atkinson',
  jarvis: 'Jarvis–Judice–Ninke',
  stucki: 'Stucki',
  sierra: 'Sierra lite',
};

// Error-diffusion kernels: [dx, dy, weight], divisor.
const KERNELS = {
  floyd: { d: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  // Atkinson only spreads 6/8 of the error, which is what gives it the contrasty look.
  atkinson: { d: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  jarvis: { d: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  stucki: { d: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  sierra: { d: 4, k: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
};

function bayer(n) {
  // Recursive construction, normalised to (0,1) thresholds.
  let m = [[0]];
  while (m.length < n) {
    const s = m.length, out = [];
    for (let y = 0; y < s * 2; y++) {
      out.push([]);
      for (let x = 0; x < s * 2; x++) {
        const q = [0, 2, 3, 1][(y >= s) * 2 + (x >= s)];
        out[y].push(4 * m[y % s][x % s] + q);
      }
    }
    m = out;
  }
  const flat = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) flat[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return { size: n, t: flat };
}

const MATRICES = { bayer2: bayer(2), bayer4: bayer(4), bayer8: bayer(8) };
let BLUE = null;

export const DEFAULTS = {
  algorithm: 'atkinson',
  levels: 2,          // 2 = 1-bit
  brightness: 0,      // -100..100
  contrast: 0,        // -100..100
  gamma: 1,           // 0.2..3
  threshold: 128,     // used by 'threshold'; also biases ordered dithers
  strength: 1,        // error diffusion amount 0..1
  serpentine: true,
  invert: false,
  saturation: 0,      // -100..100, colour mode only
};

export const ORDERED = new Set(['bayer2', 'bayer4', 'bayer8', 'bluenoise']);
export const DIFFUSION = new Set(Object.keys(KERNELS));

// RGBA -> adjusted luminance (Rec. 709 weights).
export function toLuma(rgba, w, h, o, out = new Float32Array(w * h)) {
  const b = (o.brightness ?? 0) * 2.55;
  const c = o.contrast ?? 0;
  const cf = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
  const g = 1 / (o.gamma ?? 1);
  const inv = !!o.invert;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    let v = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    v = cf * (v + b - 128) + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (g !== 1) v = 255 * Math.pow(v / 255, g);
    out[i] = inv ? 255 - v : v;
  }
  return out;
}

export function dither(lum, w, h, o, out = new Uint8Array(w * h)) {
  const levels = Math.max(2, Math.min(16, o.levels | 0 || 2));
  const L = levels - 1;
  const alg = o.algorithm in ALGORITHMS ? o.algorithm : 'atkinson';

  if (alg === 'threshold') {
    const t = (o.threshold ?? 128) / 255;
    for (let i = 0; i < w * h; i++) {
      // Multi-level threshold: shift the rounding point within each band.
      const v = (lum[i] / 255) * L;
      const f = Math.floor(v);
      out[i] = Math.min(L, f + (v - f >= t ? 1 : 0));
    }
    return out;
  }

  if (alg in MATRICES || alg === 'bluenoise') {
    let m;
    if (alg === 'bluenoise') m = BLUE ??= blueNoise(64);
    else m = MATRICES[alg];
    const n = m.size, t = m.t;
    const bias = ((o.threshold ?? 128) - 128) / 255;
    const amt = o.strength ?? 1;
    for (let y = 0; y < h; y++) {
      const row = (y % n) * n;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = (lum[i] / 255) * L;
        const f = Math.floor(v);
        const q = f + (v - f > 0.5 + (t[row + (x % n)] - 0.5) * amt + bias ? 1 : 0);
        out[i] = q < 0 ? 0 : q > L ? L : q;
      }
    }
    return out;
  }

  // Error diffusion on a working copy.
  const { d, k } = KERNELS[alg];
  const s = (o.strength ?? 1) / d;
  const buf = Float32Array.from(lum);
  const step = 255 / L;
  const bias = (o.threshold ?? 128) - 128;
  const serp = o.serpentine !== false;
  for (let y = 0; y < h; y++) {
    const rev = serp && (y & 1);
    for (let j = 0; j < w; j++) {
      const x = rev ? w - 1 - j : j;
      const i = y * w + x;
      const old = buf[i];
      let q = Math.round((old - bias) / step);
      q = q < 0 ? 0 : q > L ? L : q;
      out[i] = q;
      const err = (old - q * step) * s;
      if (err === 0) continue;
      for (let e = 0; e < k.length; e++) {
        const xx = x + (rev ? -k[e][0] : k[e][0]);
        const yy = y + k[e][1];
        if (xx < 0 || xx >= w || yy >= h) continue;
        buf[yy * w + xx] += err * k[e][2];
      }
    }
  }
  return out;
}

// Palette: array of [r,g,b] from darkest level to lightest.
export function palette(levels, ink = [0, 0, 0], paper = [255, 255, 255]) {
  const p = [];
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    p.push(ink.map((c, j) => Math.round(c + (paper[j] - c) * t)));
  }
  return p;
}

export function paint(idx, pal, out) {
  const lut = new Uint32Array(pal.length);
  // Little-endian ABGR for Uint32 view over RGBA bytes.
  for (let i = 0; i < pal.length; i++) lut[i] = (255 << 24 | pal[i][2] << 16 | pal[i][1] << 8 | pal[i][0]) >>> 0;
  const u = new Uint32Array(out.buffer, out.byteOffset, idx.length);
  for (let i = 0; i < idx.length; i++) u[i] = lut[idx[i]];
  return out;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------- colour

export const PRESETS = {
  rgb: { name: 'RGB 8', colors: ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'] },
  cmyk: { name: 'CMY + K', colors: ['#000000', '#00aeef', '#ec008c', '#fff200', '#ffffff'] },
  cga: { name: 'CGA', colors: ['#000000', '#55ffff', '#ff55ff', '#ffffff'] },
  ega: { name: 'EGA 16', colors: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'] },
  green: { name: 'Green 4', colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  sepia: { name: 'Sepia 4', colors: ['#2b1d14', '#6b4a2f', '#b58b5e', '#f2e3c6'] },
  riso: { name: 'Riso pink + blue', colors: ['#f4f1ea', '#ff48b0', '#0078bf', '#3d2f7a'] },
  ice: { name: 'Ice', colors: ['#0b1026', '#24407a', '#4f8fc0', '#a8d8ea', '#f4fbff'] },
  ember: { name: 'Ember', colors: ['#120606', '#5c0f0b', '#c0361a', '#f39c34', '#ffe9b0'] },
};

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// RGBA -> adjusted RGB floats (same tone controls as toLuma, plus saturation).
export function toRGB(rgba, w, h, o, out = new Float32Array(w * h * 3)) {
  const b = (o.brightness ?? 0) * 2.55;
  const c = o.contrast ?? 0;
  const cf = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
  const g = 1 / (o.gamma ?? 1);
  const sat = 1 + (o.saturation ?? 0) / 100;
  const inv = !!o.invert;
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
    let r = rgba[p], gr = rgba[p + 1], bl = rgba[p + 2];
    if (sat !== 1) {
      const l = 0.2126 * r + 0.7152 * gr + 0.0722 * bl;
      r = l + (r - l) * sat; gr = l + (gr - l) * sat; bl = l + (bl - l) * sat;
    }
    let v = [r, gr, bl];
    for (let k = 0; k < 3; k++) {
      let x = clamp(cf * (v[k] + b - 128) + 128);
      if (g !== 1) x = 255 * Math.pow(x / 255, g);
      out[q + k] = inv ? 255 - x : x;
    }
  }
  return out;
}

function oklab(r, g, b) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Nearest palette entry (perceptual, OKLab) for every 6-bit-per-channel RGB.
const LUT_BITS = 6, LUT_N = 1 << LUT_BITS;
let lutCache = { key: '', lut: null };
export function nearestLut(pal) {
  const key = pal.join(';');
  if (lutCache.key === key) return lutCache.lut;
  const labs = pal.map((c) => oklab(...c));
  const lut = new Uint8Array(LUT_N ** 3);
  const step = 255 / (LUT_N - 1);
  for (let r = 0, i = 0; r < LUT_N; r++)
    for (let g = 0; g < LUT_N; g++)
      for (let b = 0; b < LUT_N; b++, i++) {
        const [L, A, B] = oklab(r * step, g * step, b * step);
        let best = 0, bd = Infinity;
        for (let k = 0; k < labs.length; k++) {
          const d = (L - labs[k][0]) ** 2 + (A - labs[k][1]) ** 2 + (B - labs[k][2]) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        lut[i] = best;
      }
  lutCache = { key, lut };
  return lut;
}
const LUT_K = (LUT_N - 1) / 255;
const cell = (v) => (clamp(v) * LUT_K + 0.5) | 0;
const lutIndex = (r, g, b) => (cell(r) << (2 * LUT_BITS)) | (cell(g) << LUT_BITS) | cell(b);

// rgb: Float32Array from toRGB. pal: [[r,g,b], ...] (2..16). Output: palette index per pixel.
export function ditherColor(rgb, w, h, o, pal, out = new Uint8Array(w * h)) {
  const lut = nearestLut(pal);
  const alg = o.algorithm in ALGORITHMS ? o.algorithm : 'atkinson';
  const bias = -((o.threshold ?? 128) - 128);
  const n = w * h;

  if (alg === 'threshold') {
    for (let i = 0, q = 0; i < n; i++, q += 3) out[i] = lut[lutIndex(rgb[q] + bias, rgb[q + 1] + bias, rgb[q + 2] + bias)];
    return out;
  }

  if (ORDERED.has(alg)) {
    // Knoll pattern dithering: per pixel, build a set of palette entries whose
    // mean approximates the source, sort by luma, and let the threshold map pick.
    const m = alg === 'bluenoise' ? (BLUE ??= blueNoise(64)) : MATRICES[alg];
    const M = m.size, t = m.t;
    const C = Math.min(16, M * M);
    const mult = o.strength ?? 1;
    const luma = pal.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
    const cand = new Uint8Array(C);
    const memo = new Map();
    for (let y = 0; y < h; y++) {
      const row = (y % M) * M;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, q = i * 3;
        const r0 = rgb[q] + bias, g0 = rgb[q + 1] + bias, b0 = rgb[q + 2] + bias;
        const key = lutIndex(r0, g0, b0);
        let list = memo.get(key);
        if (!list) {
          let er = 0, eg = 0, eb = 0;
          for (let c = 0; c < C; c++) {
            const k = lut[lutIndex(r0 + er * mult, g0 + eg * mult, b0 + eb * mult)];
            cand[c] = k;
            er += r0 - pal[k][0]; eg += g0 - pal[k][1]; eb += b0 - pal[k][2];
          }
          list = Array.from(cand).sort((a, b) => luma[a] - luma[b]);
          memo.set(key, list);
        }
        out[i] = list[(t[row + (x % M)] * C) | 0];
      }
    }
    return out;
  }

  const { d, k } = KERNELS[alg];
  const s = (o.strength ?? 1) / d;
  const buf = Float32Array.from(rgb);
  const serp = o.serpentine !== false;
  for (let y = 0; y < h; y++) {
    const rev = serp && (y & 1);
    for (let j = 0; j < w; j++) {
      const x = rev ? w - 1 - j : j;
      const i = y * w + x, q = i * 3;
      // Clamp accumulated error so one saturated region can't bleed across the frame.
      const r = Math.max(-64, Math.min(319, buf[q]));
      const g = Math.max(-64, Math.min(319, buf[q + 1]));
      const b = Math.max(-64, Math.min(319, buf[q + 2]));
      const c = lut[lutIndex(r + bias, g + bias, b + bias)];
      out[i] = c;
      const er = (r - pal[c][0]) * s, eg = (g - pal[c][1]) * s, eb = (b - pal[c][2]) * s;
      for (let e = 0; e < k.length; e++) {
        const xx = x + (rev ? -k[e][0] : k[e][0]);
        const yy = y + k[e][1];
        if (xx < 0 || xx >= w || yy >= h) continue;
        const z = (yy * w + xx) * 3, wt = k[e][2];
        buf[z] += er * wt; buf[z + 1] += eg * wt; buf[z + 2] += eb * wt;
      }
    }
  }
  return out;
}

export const sortByLuma = (pal) =>
  [...pal].sort((a, b) => (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) - (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]));
export const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
