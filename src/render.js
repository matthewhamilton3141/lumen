// Pure render pipeline (no DOM, no codecs): dither to cell indices, then stamp the
// look at cell size. Shared by preview and every exporter; importable in Node.
import { toLuma, dither, palette as makePalette, paint, toRGB, ditherColor } from './dither.js';
import { makeLook, stampFrame, resolveBg } from './looks.js';
import { glowFrame, glowParams } from './glow.js';
import { findTwinkles, drawTwinkles } from './twinkle.js';

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

// Nearest-neighbour upscale of an index frame by an integer factor.
export function upscaleIdx(idx, w, h, s, out) {
  if (s === 1) return idx;
  const W = w * s;
  for (let y = 0; y < h; y++) {
    const row = out.subarray(y * s * W, y * s * W + W);
    for (let x = 0; x < w; x++) row.fill(idx[y * w + x], x * s, x * s + s);
    for (let k = 1; k < s; k++) out.copyWithin((y * s + k) * W, y * s * W, y * s * W + W);
  }
  return out;
}

// Processor + look: RGBA cells in, indexed W×H frame out (W = w*s). `pal` is the output
// palette (cell palette + background); `cells` is the last cell-index frame and `look`
// the stamp tables, for exporters that store cells rather than pixels (HTML).
// With glow or twinkle on, paint(rgba, t) adds them (t: source time in seconds, which
// drives the twinkles), so its RGBA is no longer exactly indexed. `effects` tells
// exporters that; `glow` ({ amount, radius, bg }) and `twinkle` ({ amount, bg }) say how.
export function makeRenderer(w, h, s, settings) {
  s = Math.max(1, s | 0);
  const proc = makeProcessor(w, h, settings);
  const look = makeLook(proc.pal, s, settings);
  const W = w * s, H = h * s;
  const big = new Uint8Array(W * H);
  let out = big;
  // Square pixels have no background entry; glow against the auto background.
  const bg = look.square ? resolveBg({ ...settings, bg: null }) : look.outPal[look.bgIndex];
  const glow = glowParams(settings, s, bg);
  const twinkle = +settings.twinkle > 0 ? { amount: +settings.twinkle, bg } : null;
  const ws = {};
  return {
    W, H, pal: look.outPal, bgIndex: look.bgIndex, cellPal: proc.pal, look, cells: null, glow, twinkle, effects: !!(glow || twinkle),
    run(rgba) {
      const idx = this.cells = proc.run(rgba);
      out = look.square
        ? upscaleIdx(idx, w, h, s, big)
        : stampFrame(idx, w, h, s, look.masks, look.cov, look.col, look.bgIndex, big);
      return out;
    },
    paint(rgbaOut, t = 0) {
      paint(out, look.outPal, rgbaOut);
      const tw = twinkle && findTwinkles(rgbaOut, W, H, s, bg, t, twinkle.amount);
      if (glow) glowFrame(rgbaOut, W, H, glow.bg, glow.amount, glow.radius, ws);
      return tw ? drawTwinkles(rgbaOut, W, H, s, tw) : rgbaOut;
    },
  };
}
