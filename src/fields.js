// Typed values for sliders. Pure, no DOM.
// Accepts what the value labels show ("55%", "1.5 cells", "8 px", "4×", "24 fps",
// "1-bit", "4 levels", "Off") or a plain number, then clamps and snaps to the slider.

export function clampSnap(v, { min, max, step = 1 }) {
  if (!Number.isFinite(v)) return null;
  const s = step > 0 ? step : 1;
  let x = min + Math.round((v - min) / s) * s;
  x = Math.min(max, Math.max(min, x));
  // Trim float noise from the step arithmetic (0.1 + 0.2 and friends).
  const dp = (String(s).split('.')[1] || '').length;
  return +x.toFixed(Math.min(10, dp + 2));
}

// percent: the slider runs 0..1 but shows a percentage, so "55" and "55%" both mean 0.55.
export function parseField(text, { min, max, step = 1, percent = false }) {
  const t = String(text).trim().toLowerCase().replace(/,/g, '.').replace(/−/g, '-');
  if (!t) return null;
  if (t === 'off' || t === 'none') return clampSnap(min, { min, max, step });
  const bits = t.match(/^(\d+)\s*-?\s*bits?$/);
  if (bits) return clampSnap(2 ** +bits[1], { min, max, step });
  const m = t.match(/^[+-]?(\d+\.?\d*|\.\d+)/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (percent && (t.includes('%') || Math.abs(v) > 1)) v /= 100;
  return clampSnap(v, { min, max, step });
}
