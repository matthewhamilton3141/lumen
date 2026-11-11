// GIF and HTML writers, fed one source frame at a time. Shared by the in-browser
// exporters and the command-line one, so both produce the same files.
import * as gifenc from 'gifenc';
import { FramePacker, toBase64 } from './pack.js';
import { buildPlayer } from './player.js';
import { makeLook } from './looks.js';

// Vite resolves gifenc's ESM build (named exports); Node gets its CommonJS object.
const G = gifenc.GIFEncoder ? gifenc : gifenc.default;
export const quantize = G.quantize;

export function gifWriter(ren, fps) {
  const gif = G.GIFEncoder();
  const delay = 1000 / (fps || 1);
  const rgba = ren.effects && new Uint8ClampedArray(ren.W * ren.H * 4);
  let t = 0;
  return {
    add(src, time = 0) {
      let out = ren.run(src), palette = ren.pal;
      if (rgba) {
        // Glow and twinkles add in-between colours. Keep the look's own colours exact and give the
        // rest of the 256 slots to the halo, quantised per frame.
        ren.paint(rgba, time);
        const room = 256 - ren.pal.length;
        palette = room > 0 ? [...ren.pal, ...G.quantize(rgba, room, { format: 'rgb444' })] : ren.pal;
        out = G.applyPalette(rgba, palette, 'rgb565');
      }
      // GIF delays are whole centiseconds; carry the remainder so long clips stay in sync.
      const d = Math.round((t + delay) / 10) * 10 - Math.round(t / 10) * 10;
      t += delay;
      gif.writeFrame(out, ren.W, ren.H, { palette, delay: d });
    },
    finish({ loop = true } = {}) {
      gif.finish();
      return loop ? gif.bytes() : playOnce(gif.bytes());
    },
  };
}

// gifenc always writes "loop forever"; dropping the NETSCAPE block makes a GIF play once.
export function playOnce(b) {
  for (let i = 0; i < b.length - 16; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xff && b[i + 2] === 0x0b && String.fromCharCode(...b.subarray(i + 3, i + 11)) === 'NETSCAPE') {
      const out = new Uint8Array(b.length - 19);
      out.set(b.subarray(0, i));
      out.set(b.subarray(i + 19), i);
      return out;
    }
  }
  return b;
}

// Cells are packed, not pixels: the player stamps the look itself, so files stay small.
// t0: source time of the first frame, so the player's twinkles match the other exports.
// opts.lens: { look, size, settings } adds a cursor lens drawing `look` over the same cells;
// size is the radius as a fraction of the shorter side (default 0.22), settings the render
// settings (for the colour rule of the alternate look).
export function htmlWriter(ren, w, h, t0 = 0, opts = {}) {
  const lens = opts.lens && (() => {
    const alt = makeLook(ren.cellPal, ren.look.s, { ...(opts.lens.settings || {}), look: opts.lens.look, bg: ren.pal[ren.bgIndex] });
    const size = Math.max(0.05, Math.min(0.6, +opts.lens.size || 0.22));
    return { masks: alt.masks, cov: alt.cov, col: alt.col, off: alt.off, r: Math.max(2, Math.round(size * Math.min(w, h) * 10) / 10) };
  })();
  const packer = new FramePacker(w, h, ren.cellPal.length);
  return {
    add(src) { ren.run(src); packer.add(ren.cells); },
    async finish({ fps, loop = true, title, embed = 'page', fit = 'contain' }) {
      const data = toBase64(await packer.compress());
      const L = ren.look;
      return buildPlayer({
        w, h, fps: fps || 1, frames: packer.count, levels: ren.cellPal.length, bits: packer.bits,
        palette: ren.cellPal, loop, data, title, embed, fit,
        // Glow, twinkles and the lens need the canvas at full size, so square pixels are stamped too.
        look: L.square && !ren.effects && !lens ? null : { s: L.s, masks: L.masks, off: L.off, cov: L.cov, col: L.col, bg: ren.pal[ren.bgIndex] },
        glow: ren.glow, twinkle: ren.twinkle && { ...ren.twinkle, t0 }, lens,
      });
    },
  };
}
