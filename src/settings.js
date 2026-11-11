// App settings shared by the page and the command-line exporter. Pure, no DOM.
// Settings are stored with hex colours; toRender() turns them into the renderer's RGB form.
import { DEFAULTS, PRESETS, hexToRgb } from './dither.js';

export const APP_DEFAULTS = {
  ...DEFAULTS,
  ink: '#000000', paper: '#ffffff',
  mode: 'mono', preset: 'cga', colors: [...PRESETS.cga.colors], count: 8, chLevels: 2,
  aspect: 'original', fit: 'crop',
  width: 320, scale: 4, fps: 24,
  format: 'mp4', audio: true, loop: true,
  look: 'square', bg: null, embed: 'page', embedFit: 'contain',
  glow: 0, glowSize: 2, twinkle: 0,
};

// Keys a look preset owns: applying one resets these to the defaults first, so nothing
// from the previous look is left behind.
export const LOOK_KEYS = ['look', 'bg', 'mode', 'ink', 'paper', 'levels', 'algorithm', 'invert', 'brightness', 'contrast', 'gamma', 'saturation', 'threshold', 'strength', 'chLevels', 'glow', 'glowSize', 'twinkle'];

// The settings that make up "how it looks" (what Copy settings shares), without the
// per-session ones like format or trim.
export const SHARE_KEYS = [...LOOK_KEYS, 'preset', 'colors', 'serpentine', 'aspect', 'fit', 'width', 'scale'];

// Glow and twinkles draw at full size and add colours beyond the palette.
export const hasEffects = (o) => o.glow > 0 || o.twinkle > 0;

const clone = (o) => JSON.parse(JSON.stringify(o));

export function withPreset(S, p) {
  // A full copy: a preset without its own colours must not share the caller's arrays.
  const o = clone(S);
  for (const k of LOOK_KEYS) o[k] = clone(APP_DEFAULTS[k]);
  Object.assign(o, clone(p.settings));
  if (p.settings.colors && !p.settings.preset) o.preset = 'custom';
  return o;
}

// ASCII glyphs need room: a 5×7 font is unreadable below ~8 px cells.
export function roomForGlyphs(o) {
  if (o.look !== 'ascii') return o;
  return { ...o, scale: Math.max(8, o.scale), width: Math.min(160, o.width) };
}

export const toRender = (o) => ({
  ...o, ink: hexToRgb(o.ink), paper: hexToRgb(o.paper), colors: o.colors.map(hexToRgb), bg: o.bg ? hexToRgb(o.bg) : null,
});
