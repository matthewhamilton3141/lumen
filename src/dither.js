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
};

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
    for (let y = 0; y < h; y++) {
      const row = (y % n) * n;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = (lum[i] / 255) * L;
        const f = Math.floor(v);
        const q = f + (v - f > t[row + (x % n)] + bias ? 1 : 0);
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
