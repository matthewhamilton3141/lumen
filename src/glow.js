// Glow: whatever differs from the background spreads light into its surroundings.
//   out = img + amount * (near + wide), near/wide = blurs of (img - bg)
// On a dark background bright dots bloom; on a light one, dark ink bleeds.
// The blur runs on a grid ~radius/1.5 times coarser than the image and is bilinearly
// upsampled, so cost barely depends on the radius.
//
// glowFrame must stay self-contained (no outer references): the HTML player embeds its
// source text with Function.prototype.toString.
// px: RGBA Uint8ClampedArray, changed in place.
export function glowFrame(px, W, H, bg, amount, radius, ws) {
  if (!(amount > 0) || !(radius > 0)) return px;
  ws = ws || {};
  const f = radius < 1.5 ? 1 : Math.max(2, Math.round(radius / 1.5));
  const gw = Math.ceil(W / f), gh = Math.ceil(H / f), gn = gw * gh, key = W + 'x' + H + '/' + f;
  if (ws.key !== key) {
    ws.key = key;
    ws.e = new Float32Array(gn * 3); ws.sum = new Int32Array(gn * 3); ws.a = new Float32Array(gn * 3); ws.b = new Float32Array(gn * 3);
    ws.t = new Float32Array(Math.max(gw, gh) * 3); ws.row = new Float32Array(gw * 3);
    // Per output column: its grid cell (for the downsample) and the two grid cells and weight it interpolates.
    ws.gx = new Int32Array(W); ws.x0 = new Int32Array(W); ws.x1 = new Int32Array(W); ws.wx = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      ws.gx[x] = ((x / f) | 0) * 3;
      const g = Math.max(0, (x + 0.5) / f - 0.5), x0 = Math.min(gw - 1, g | 0);
      ws.x0[x] = x0 * 3; ws.x1[x] = Math.min(gw - 1, x0 + 1) * 3; ws.wx[x] = g - x0;
    }
  }
  const e = ws.e, a = ws.a, b = ws.b, row = ws.row, GX = ws.gx, X0 = ws.x0, X1 = ws.x1, WX = ws.wx;
  const sum = ws.sum;
  sum.fill(0);
  // Downsample by block averaging (edge blocks may be partial), then subtract the background.
  // Full-size loops live in small inner functions, which V8 optimises far better.
  const down = (p, o) => {
    for (let x = 0; x < W; x++, p += 4) {
      const q = o + GX[x];
      sum[q] += px[p]; sum[q + 1] += px[p + 1]; sum[q + 2] += px[p + 2];
    }
  };
  for (let y = 0; y < H; y++) down(y * W * 4, ((y / f) | 0) * gw * 3);
  for (let gy = 0; gy < gh; gy++) {
    const rh = Math.min(f, H - gy * f);
    for (let gx = 0; gx < gw; gx++) {
      const k = 1 / (rh * Math.min(f, W - gx * f)), q = (gy * gw + gx) * 3;
      e[q] = sum[q] * k - bg[0]; e[q + 1] = sum[q + 1] * k - bg[1]; e[q + 2] = sum[q + 2] * k - bg[2];
    }
  }
  // Box blur along one axis (running sum, averaged over the cells that exist at edges).
  const tmp = ws.t;
  const box = (src, dst, len, lines, stride, step, r) => {
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      for (let i = 0; i < len; i++) { const q = (base + i * step) * 3; tmp[i * 3] = src[q]; tmp[i * 3 + 1] = src[q + 1]; tmp[i * 3 + 2] = src[q + 2]; }
      let s0 = 0, s1 = 0, s2 = 0, lo = 0, hi = -1;
      for (let i = 0; i < len; i++) {
        const want = Math.min(len - 1, i + r);
        while (hi < want) { hi++; s0 += tmp[hi * 3]; s1 += tmp[hi * 3 + 1]; s2 += tmp[hi * 3 + 2]; }
        while (lo < i - r) { s0 -= tmp[lo * 3]; s1 -= tmp[lo * 3 + 1]; s2 -= tmp[lo * 3 + 2]; lo++; }
        const k = 1 / (hi - lo + 1), q = (base + i * step) * 3;
        dst[q] = s0 * k; dst[q + 1] = s1 * k; dst[q + 2] = s2 * k;
      }
    }
  };
  // Repeated box passes per axis ≈ a gaussian.
  const blur = (src, dst, r, n) => {
    let s = src;
    for (let k = 0; k < n; k++) { box(s, dst, gw, gh, gw, 1, r); box(dst, dst, gh, gw, 1, gw, r); s = dst; }
  };
  // Near halo hugs the shapes; the wide one (blurred again from it) gives the bloom.
  const rg = radius / f;
  blur(e, a, Math.max(1, Math.round(rg / 2)), 2);
  blur(a, b, Math.max(1, Math.round(rg * 1.5)), 3);
  // Upsample: per output row interpolate vertically into a row buffer, then horizontally.
  // px is a Uint8ClampedArray, so stores clamp and round.
  const up = (p) => {
    for (let x = 0; x < W; x++, p += 4) {
      const o0 = X0[x], o1 = X1[x], wx = WX[x];
      px[p] += row[o0] + (row[o1] - row[o0]) * wx;
      px[p + 1] += row[o0 + 1] + (row[o1 + 1] - row[o0 + 1]) * wx;
      px[p + 2] += row[o0 + 2] + (row[o1 + 2] - row[o0 + 2]) * wx;
    }
  };
  const ka = amount * 1.1, kb = amount * 1.4;
  for (let y = 0; y < H; y++) {
    let gy = (y + 0.5) / f - 0.5;
    if (gy < 0) gy = 0;
    const y0 = Math.min(gh - 1, gy | 0), y1 = Math.min(gh - 1, y0 + 1), wy = gy - y0;
    for (let i = 0, o0 = y0 * gw * 3, o1 = y1 * gw * 3; i < gw * 3; i++)
      row[i] = ka * (a[o0 + i] + (a[o1 + i] - a[o0 + i]) * wy) + kb * (b[o0 + i] + (b[o1 + i] - b[o0 + i]) * wy);
    up(y * W * 4);
  }
  return px;
}

// Glow settings → pixels at cell size s. glowSize is in cells, so preview and export match.
export function glowParams(settings, s, bg) {
  const amount = +settings.glow || 0;
  if (amount <= 0) return null;
  return { amount, radius: Math.max(1, (+settings.glowSize || 2) * s), bg };
}
