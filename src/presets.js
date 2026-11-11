// One-click looks. Each preset sets the same group of keys so switching between them
// never leaves a stale value behind. Colours are hex; `bg: null` means "paper in mono,
// black otherwise" (see resolveBg in looks.js).
import { PRESETS } from './dither.js';

const base = {
  look: 'square', bg: null, mode: 'mono', algorithm: 'atkinson', levels: 2, chLevels: 2,
  ink: '#000000', paper: '#ffffff', strength: 1, invert: false,
  brightness: 0, contrast: 0, gamma: 1, saturation: 0, threshold: 128, glow: 0, glowSize: 2, twinkle: 0,
};
const pal = (id) => ({ mode: 'color', preset: id, colors: [...PRESETS[id].colors] });
const make = (id, name, settings) => ({ id, name, settings: { ...base, ...settings } });

// One tile per distinct treatment: recolours of another tile are left to the colour controls.
export const LOOK_PRESETS = [
  make('bayer', 'Bayer', { mode: 'original', chLevels: 3, algorithm: 'bayer8', saturation: 15 }),
  // Four grey shades in a 4×4 Bayer pattern, the handheld-screen look; recolour with Ink and Paper.
  make('pocket', 'Pocket', { algorithm: 'bayer4', levels: 4, contrast: 10 }),
  make('neonascii', 'Neon ASCII', {
    look: 'ascii', mode: 'original', chLevels: 3, algorithm: 'threshold', bg: '#000000',
    contrast: 20, saturation: 40, glow: 0.55, glowSize: 1.5, twinkle: 0.5,
  }),
  make('led', 'LED wall', {
    look: 'led', mode: 'original', chLevels: 4, algorithm: 'bayer4', bg: '#000000', saturation: 30, glow: 0.5, glowSize: 2,
  }),
  make('crt', 'CRT', { look: 'scan', mode: 'original', chLevels: 3, algorithm: 'bayer8', bg: '#000000', saturation: 15, glow: 0.35, glowSize: 1 }),
];
