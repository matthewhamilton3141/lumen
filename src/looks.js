// Looks: how each dithered cell is drawn at export scale. Pure, no DOM.
// A look is a set of K binary s×s stamps; a cell picks one by how far its colour is
// from the background, so output stays exactly indexed (palette + one bg entry).

export const LOOKS = {
  square: { label: 'Pixels', K: 1 },
  led: { label: 'LED dots', K: 1 },
  halftone: { label: 'Halftone', K: 8 },
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

export function makeStamps(look, s) {
  s = Math.max(1, s | 0);
  if (!LOOKS[look]) look = 'square';
  const K = LOOKS[look].K;
  let masks;
  if (look === 'led') {
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
  return { K, s, masks };
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

export function makeLook(pal, s, settings = {}) {
  const look = LOOKS[settings.look] ? settings.look : 'square';
  const st = makeStamps(look, s);
  const bg = resolveBg(settings);
  const rule = (settings.mode || 'mono') === 'mono' && st.K > 1 ? 'ink' : 'cell';
  const { cov, col, bgIndex } = lookTables(pal, bg, st.K, rule);
  return { s: st.s, K: st.K, masks: st.masks, cov, col, bgIndex, outPal: [...pal, bg], square: look === 'square' };
}
