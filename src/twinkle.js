// Twinkles: now and then a lit cell flares, a bright core with a small four-point star
// and a soft halo, then fades. Which cells and when come from hashing the cell index
// and the frame time, so a given moment looks the same in the preview, every export
// and the HTML player, and nothing flickers frame to frame.
//
// findTwinkles reads the frame before glow (so halos don't count as lit cells);
// drawTwinkles paints after glow. Both must stay self-contained: the HTML player
// embeds their source text.

// Returns a flat list [cx, cy, r, g, b, strength, ...] of the twinkles showing at time t.
export function findTwinkles(px, W, H, s, bg, t, amount) {
  if (!(amount > 0)) return null;
  const w = Math.floor(W / s), h = Math.floor(H / s), out = [];
  // Share of cells that flare once per cycle; each flare lasts 30% of its cycle.
  const density = 0.004 + 0.02 * amount, ON = 0.3;
  const dark = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 128;
  for (let c = 0, n = w * h; c < n; c++) {
    let a = Math.imul(c ^ 0x5bd1e995, 0x85ebca6b); a ^= a >>> 13; a = Math.imul(a, 0xc2b2ae35); a ^= a >>> 16;
    const period = 1.2 + 2 * ((a >>> 0) / 4294967296), phase = ((a >>> 4) & 1023) / 1024;
    const u = t / period + phase, k = Math.floor(u), f = u - k;
    if (f >= ON) continue;
    // A fresh draw per cycle, so different cells take turns.
    let b = Math.imul((c + Math.imul(k, 0x27d4eb2d)) | 0, 0x165667b1); b ^= b >>> 15; b = Math.imul(b, 0x85ebca77); b ^= b >>> 13;
    if ((b >>> 0) / 4294967296 >= density) continue;
    // The cell's ink: its pixel furthest from the background. Unlit cells don't twinkle.
    const x0 = (c % w) * s, y0 = ((c / w) | 0) * s;
    let best = 0, p0 = -1;
    for (let y = y0; y < y0 + s; y++) {
      for (let x = x0, p = (y * W + x0) * 4; x < x0 + s; x++, p += 4) {
        const d = Math.abs(px[p] - bg[0]) + Math.abs(px[p + 1] - bg[1]) + Math.abs(px[p + 2] - bg[2]);
        if (d > best) { best = d; p0 = p; }
      }
    }
    if (best < 60) continue;
    const e = Math.sin((Math.PI * f) / ON);
    // White-hot on a dark background; deeper ink on a light one.
    const to = dark ? 255 : 0, m = 0.55;
    out.push(x0 + s / 2, y0 + s / 2, px[p0] + (to - px[p0]) * m, px[p0 + 1] + (to - px[p0 + 1]) * m, px[p0 + 2] + (to - px[p0 + 2]) * m,
      e * e * (0.55 + 0.45 * amount));
  }
  return out;
}

export function drawTwinkles(px, W, H, s, list) {
  if (!list) return px;
  const sig = 0.8 * s, th = Math.max(0.5, s / 9);
  for (let i = 0; i < list.length; i += 6) {
    const cx = list[i], cy = list[i + 1], tr = list[i + 2], tg = list[i + 3], tb = list[i + 4], tw = list[i + 5];
    const L = 2.4 * s * tw + 1, rc = 0.4 * s * (0.5 + 0.5 * tw), R = Math.ceil(Math.max(2.5 * sig, L));
    const xa = Math.max(0, Math.floor(cx - R)), xb = Math.min(W, Math.ceil(cx + R));
    const ya = Math.max(0, Math.floor(cy - R)), yb = Math.min(H, Math.ceil(cy + R));
    for (let y = ya; y < yb; y++) {
      const dy = y + 0.5 - cy, ay = Math.abs(dy);
      for (let x = xa, p = (y * W + xa) * 4; x < xb; x++, p += 4) {
        const dx = x + 0.5 - cx, ax = Math.abs(dx), d2 = dx * dx + dy * dy;
        let a = 0.5 * tw * Math.exp(-d2 / (2 * sig * sig));
        if (d2 <= rc * rc && tw > a) a = tw;
        if (ay < th && ax < L) { const r = 1 - ax / L, v = 0.9 * tw * r * r; if (v > a) a = v; }
        if (ax < th && ay < L) { const r = 1 - ay / L, v = 0.9 * tw * r * r; if (v > a) a = v; }
        if (a < 0.004) continue;
        if (a > 1) a = 1;
        px[p] += (tr - px[p]) * a;
        px[p + 1] += (tg - px[p + 1]) * a;
        px[p + 2] += (tb - px[p + 2]) * a;
      }
    }
  }
  return px;
}
