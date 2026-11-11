// Looks: how each dithered cell is drawn at export scale. Pure, no DOM.
// A look is a set of K binary s×s stamps; a cell picks one by how far its colour is
// from the background, so output stays exactly indexed (palette + one bg entry).
// Overlapping looks (off > 0) have (s + 2·off)² stamps centred on their cell, so a dot can
// reach into its neighbours; spreadFrame draws those.

export const LOOKS = {
  square: { label: 'Pixels', K: 1 },
  led: { label: 'LED dots', K: 1 },
  halftone: { label: 'Halftone', K: 8 },
  // tone: in mono the cells keep K grey levels (the dot size is the tone), whatever Levels says.
  diamond: { label: 'Diamond halftone', K: 16, tone: true, spread: true },
  ascii: { label: 'ASCII', K: 10 },
  scan: { label: 'Scanlines', K: 1 },
};

// 5×7 bitmap font for the density ramp ` .:-=+*#%@`. The last row is left empty so the
// glyphs survive being squeezed into 6 rows.
const RAMP = [
  ['.....', '.....', '.....', '.....', '.....', '.....', '.....'], // ' '
  ['.....', '.....', '.....', '.....', '.....', '..#..', '.....'], // .
  ['.....', '..#..', '.....', '.....', '..#..', '.....', '.....'], // :
  ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'], // -
  ['.....', '.###.', '.....', '.###.', '.....', '.....', '.....'], // =
  ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'], // +
  ['.....', '..#..', '#.#.#', '.###.', '#.#.#', '..#..', '.....'], // *
  ['.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.', '.....'], // #
  ['##.##', '##.##', '..###', '###..', '##.##', '##.##', '.....'], // %
  ['.###.', '#####', '##.##', '#####', '#####', '.###.', '.....'], // @
];

const ones = (s) => new Uint8Array(s * s).fill(1);

function circle(s, r) {
  const m = new Uint8Array(s * s);
  const c = s / 2, r2 = r * r;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      if (dx * dx + dy * dy <= r2 + 1e-9) m[y * s + x] = 1;
    }
  }
  return m;
}

// Too small for a glyph: fill n pixels from the centre outwards.
function blob(s, n) {
  const c = s / 2;
  const order = Array.from({ length: s * s }, (_, i) => i).sort((a, b) => {
    const da = ((a % s) + 0.5 - c) ** 2 + (Math.floor(a / s) + 0.5 - c) ** 2;
    const db = ((b % s) + 0.5 - c) ** 2 + (Math.floor(b / s) + 0.5 - c) ** 2;
    return da - db || a - b;
  });
  const m = new Uint8Array(s * s);
  for (let i = 0; i < n; i++) m[order[i]] = 1;
  return m;
}

function glyph(s, rows) {
  const m = new Uint8Array(s * s);
  const pad = s >= 8 ? 1 : 0, n = s - pad * 2;
  for (let y = 0; y < n; y++) {
    const row = rows[Math.floor((y * 7) / n)];
    for (let x = 0; x < n; x++) if (row[Math.floor((x * 5) / n)] === '#') m[(y + pad) * s + x + pad] = 1;
  }
  return m;
}

// Ink area of a diamond dot of L1 radius r (in cells) on a square grid is 2r² until the dots
// meet at 50%; past that the paper left over is diamond holes, 1 − 2(1 − r)². Inverted here.
export function diamondRadius(c) {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.5 ? Math.sqrt(c / 2) : 1 - Math.sqrt((1 - c) / 2);
}

// Diamond dots on a (3s)² canvas centred on the cell. gain grows every dot (ink spread),
// up to 50%, which is exactly what the canvas can hold. A plain distance threshold only
// gives about s sizes (pixel centres sit at whole L1 distances), so dots grow pixel by
// pixel instead: by L1 distance, then nearest the centre first, in symmetric groups,
// stopping at the group boundary closest to the diamond's area.
function diamonds(s, K, gain) {
  const n = 3 * s, c = n / 2, g = 1 + Math.max(0, Math.min(0.5, +gain || 0));
  const px = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.abs(x + 0.5 - c), dy = Math.abs(y + 0.5 - c);
      px.push([dx + dy, dx * dx + dy * dy, y * n + x]);
    }
  }
  px.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ends = [0];
  for (let i = 1; i <= px.length; i++) {
    if (i === px.length || px[i][0] - px[i - 1][0] > 1e-9 || px[i][1] - px[i - 1][1] > 1e-9) ends.push(i);
  }
  return Array.from({ length: K }, (_, k) => {
    const m = new Uint8Array(n * n);
    const want = 2 * (diamondRadius(k / (K - 1)) * g * s) ** 2;
    let e = 0;
    for (const v of ends) if (Math.abs(v - want) < Math.abs(e - want)) e = v;
    for (let i = 0; i < e; i++) m[px[i][2]] = 1;
    return m;
  });
}

// opts.gain: dot gain for overlapping looks (0–0.5).
export function makeStamps(look, s, opts = {}) {
  s = Math.max(1, s | 0);
  if (!LOOKS[look]) look = 'square';
  const K = LOOKS[look].K;
  let masks, off = 0;
  if (look === 'diamond') {
    masks = diamonds(s, K, opts.gain);
    off = s;
  } else if (look === 'led') {
    masks = [s < 3 ? ones(s) : circle(s, s * 0.4)];
  } else if (look === 'halftone') {
    // Top level reaches the cell corners, so solid areas read as solid.
    const full = s * Math.SQRT1_2;
    masks = Array.from({ length: K }, (_, k) => (k === 0 ? new Uint8Array(s * s) : circle(s, (full * k) / (K - 1))));
  } else if (look === 'ascii') {
    masks = s < 6
      ? Array.from({ length: K }, (_, k) => blob(s, Math.round((s * s * k) / (K - 1))))
      // Nearest-neighbour scaling can make a lighter glyph out-weigh the next one at some
      // sizes, so order by actual ink to keep the ramp monotone.
      : RAMP.map((rows) => glyph(s, rows)).map((m) => [m, m.reduce((a, b) => a + b, 0)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
  } else if (look === 'scan') {
    const m = ones(s);
    if (s >= 2) m.fill(0, (s - Math.max(1, Math.round(s / 3))) * s);
    masks = [m];
  } else {
    masks = [ones(s)];
  }
  return { K, s, masks, off };
}

const toRgb = (c) => {
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') {
    const n = parseInt(c.replace('#', ''), 16);
    if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
};

// null bg → mono: the paper colour; other modes: black.
export function resolveBg(settings = {}) {
  const bg = toRgb(settings.bg);
  if (bg) return bg;
  if ((settings.mode || 'mono') === 'mono') return toRgb(settings.paper) || [255, 255, 255];
  return [0, 0, 0];
}

const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function lookTables(pal, bg, K, rule = 'cell') {
  const n = pal.length;
  const cov = new Uint8Array(n), col = new Uint8Array(n);
  const lb = luma(bg);
  const d = pal.map((c) => Math.abs(luma(c) - lb));
  let max = 0, min = Infinity, far = 0;
  for (let i = 0; i < n; i++) {
    if (d[i] > max) { max = d[i]; far = i; }
    if (d[i] < min) min = d[i];
  }
  const flat = max - min < 1e-6;
  for (let i = 0; i < n; i++) {
    cov[i] = flat ? K - 1 : Math.round((d[i] / max) * (K - 1));
    col[i] = rule === 'ink' ? far : i;
  }
  return { cov, col, bgIndex: n };
}

// Hot path. Builds one row table per palette entry, then copies rows per cell.
export function stampFrame(idx, w, h, s, masks, cov, col, bgIndex, out = new Uint8Array(w * s * h * s)) {
  const n = cov.length, ss = s * s, W = w * s;
  const tab = new Uint8Array(n * ss);
  for (let i = 0; i < n; i++) {
    const m = masks[cov[i]], c = col[i], o = i * ss;
    for (let j = 0; j < ss; j++) tab[o + j] = m[j] ? c : bgIndex;
  }
  if (s === 1) {
    for (let i = 0, N = w * h; i < N; i++) out[i] = tab[idx[i]];
    return out;
  }
  for (let y = 0; y < h; y++) {
    const yo = y * w;
    for (let sy = 0; sy < s; sy++) {
      let p = (y * s + sy) * W;
      const ro = sy * s;
      for (let x = 0; x < w; x++) {
        const t = idx[yo + x] * ss + ro;
        for (let sx = 0; sx < s; sx++) out[p++] = tab[t + sx];
      }
    }
  }
  return out;
}

// Runs of ones in an n×n mask, as [y, x0, x1, …] (x1 exclusive). Ships in the HTML player.
export function maskSpans(m, n) {
  const r = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n;) {
      if (!m[y * n + x]) { x++; continue; }
      const x0 = x;
      while (x < n && m[y * n + x]) x++;
      r.push(y, x0, x);
    }
  }
  return Int16Array.from(r);
}

// Overlapping stamps: each cell draws its dot, which may reach past its own cell. Where dots
// meet, the bigger one wins and a cell wins ties on its own ground, so the output stays
// indexed. looks[sel[i]] draws cell i (sel null: looks[0]); a look is { spans (per stamp,
// from maskSpans), off (how far stamps reach past the cell, px), cov, col }. pri: W·H scratch.
// Ships in the HTML player.
export function spreadFrame(idx, w, h, s, looks, sel, bgIndex, out, pri) {
  const W = w * s, H = h * s;
  out.fill(bgIndex, 0, W * H);
  pri.fill(0, 0, W * H);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cy * w + cx, L = looks[sel ? sel[i] : 0], v = idx[i], k = L.cov[v], sp = L.spans[k];
      if (!sp.length) continue;
      const c = L.col[v], x0 = cx * s, y0 = cy * s, X0 = x0 - L.off, Y0 = y0 - L.off, p = 2 * k + 2;
      for (let j = 0; j < sp.length; j += 3) {
        const Y = Y0 + sp[j];
        if (Y < 0 || Y >= H) continue;
        const a = Math.max(0, X0 + sp[j + 1]), b = Math.min(W, X0 + sp[j + 2]), mine = Y >= y0 && Y < y0 + s, row = Y * W;
        for (let X = a; X < b; X++) {
          const q = row + X, pr = mine && X >= x0 && X < x0 + s ? p + 1 : p;
          if (pr > pri[q]) { pri[q] = pr; out[q] = c; }
        }
      }
    }
  }
  return out;
}

export function makeLook(pal, s, settings = {}) {
  const look = LOOKS[settings.look] ? settings.look : 'square';
  const st = makeStamps(look, s, { gain: settings.dotGain });
  const bg = resolveBg(settings);
  const rule = (settings.mode || 'mono') === 'mono' && st.K > 1 ? 'ink' : 'cell';
  const { cov, col, bgIndex } = lookTables(pal, bg, st.K, rule);
  const L = { s: st.s, K: st.K, masks: st.masks, off: st.off, cov, col, bgIndex, outPal: [...pal, bg], square: look === 'square' };
  if (st.off) L.spans = st.masks.map((m) => maskSpans(m, st.s + 2 * st.off));
  return L;
}

// Tone looks keep K grey levels in mono, so the dot size carries the tone.
export function lookLevels(settings = {}) {
  const L = LOOKS[settings.look];
  return L?.tone && (settings.mode || 'mono') === 'mono' ? L.K : settings.levels;
}
