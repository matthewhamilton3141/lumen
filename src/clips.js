// Clips: in/out ranges cut from one video, exported one file each. Pure, no DOM.

export const MIN_CLIP = 0.01; // seconds

// Times are kept to the millisecond.

const ms = (v) => Math.round(v * 1000) / 1000;

// Clamp an in/out pair to the video. Throws if nothing is left.
export function normalise({ start, end }, duration) {
  const a = ms(Math.max(0, Math.min(+start || 0, duration)));
  const b = ms(Math.max(0, Math.min(Number.isFinite(+end) && end !== '' ? +end : duration, duration)));
  if (!(b - a >= MIN_CLIP)) throw new Error('Out must be after In.');
  return { start: a, end: b };
}

// Returns a new list, sorted by start; an exact duplicate is not added twice.
export function addClip(clips, clip, duration) {
  const c = normalise(clip, duration);
  if (clips.some((x) => x.start === c.start && x.end === c.end)) return clips;
  return [...clips, c].sort((x, y) => x.start - y.start || x.end - y.end);
}

export const removeClip = (clips, i) => clips.filter((_, j) => j !== i);

// Setting one edge past the other moves the other out of the way.
export function setIn(sel, t, duration) {
  const start = ms(Math.max(0, Math.min(t, duration)));
  return { start, end: sel.end > start ? sel.end : ms(duration) };
}
export function setOut(sel, t, duration) {
  const end = ms(Math.max(0, Math.min(t, duration)));
  return { start: sel.start < end ? sel.start : 0, end };
}

// 0:03.250 (and 1:02:03.250 past an hour)
export function clipTime(s) {
  const t = Math.round(Math.max(0, s) * 1000);
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, sec = (t % 60000) / 1000;
  const ss = sec.toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// "83.25", "1:23.250" or "1:01:23.25" → seconds.
export function parseTime(str) {
  const parts = String(str).trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d*)?$|^\.\d+$/.test(p))) throw new Error(`Can't read the time "${str}".`);
  return ms(parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0));
}

// "1.25-2.5", "0:01.250-0:02.500" → { start, end }.
export function parseRange(str) {
  const m = String(str).match(/^\s*([\d:.]+)\s*(?:-|–|\.\.|to)\s*([\d:.]+)\s*$/);
  if (!m) throw new Error(`Can't read the clip "${str}". Use start-end, e.g. 0:01.250-0:02.500.`);
  return { start: parseTime(m[1]), end: parseTime(m[2]) };
}

// photo-clip03-ascii.gif — numbered with enough digits to sort, only when there are several.
export function clipFileName(base, i, n, tag, ext) {
  const num = n > 1 ? `-clip${String(i + 1).padStart(String(n).length, '0')}` : '';
  return `${base}${num}-${tag}.${ext}`;
}
