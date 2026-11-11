// Draws the live preview and the looks strip onto canvases. Runs inside the preview
// worker (on transferred OffscreenCanvases) or, as a fallback, on the main thread.
import { makeProcessor, makeRenderer } from './render.js';

export function createPreview(out, tileCanvases) {
  const octx = out.getContext('2d');
  let pc = { key: '', p: null }, rc = { key: '', r: null, img: null };
  const size = (c, w, h) => { if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; };
  const tiles = tileCanvases.map((c) => ({ c, ctx: c.getContext('2d'), key: '', r: null, img: null }));

  return {
    // rgba: the framed source at w×h cells. Square pixels without effects are drawn at cell
    // size and scaled by CSS; everything else is stamped at `cell` px per cell.
    // t: source time in seconds (drives twinkles).
    frame({ rgba, w, h, settings, cell, orig, t = 0 }) {
      if (orig || (settings.look === 'square' && !(settings.glow > 0 || settings.twinkle > 0))) {
        const img = new ImageData(rgba, w, h);
        if (!orig) {
          const key = JSON.stringify([w, h, settings]);
          if (pc.key !== key) pc = { key, p: makeProcessor(w, h, settings) };
          pc.p.run(rgba);
          pc.p.paint(rgba);
        }
        size(out, w, h);
        octx.putImageData(img, 0, 0);
        return;
      }
      const key = JSON.stringify([w, h, cell, settings]);
      if (rc.key !== key) {
        const r = makeRenderer(w, h, cell, settings);
        rc = { key, r, img: new ImageData(r.W, r.H) };
      }
      rc.r.run(rgba);
      rc.r.paint(rc.img.data, t);
      size(out, rc.r.W, rc.r.H);
      octx.putImageData(rc.img, 0, 0);
    },

    // sources: { fine, cell } as { rgba, w, h, s }; list[i]: { settings, grid: 'fine' | 'cell' } per tile.
    thumbs({ sources, list, t: time = 0 }) {
      list.forEach(({ settings, grid }, i) => {
        const t = tiles[i], g = sources[grid];
        if (!t || !g) return;
        try {
          const key = JSON.stringify([grid, settings]);
          if (t.key !== key) {
            t.r = makeRenderer(g.w, g.h, g.s, settings);
            size(t.c, t.r.W, t.r.H);
            t.img = new ImageData(t.r.W, t.r.H);
            t.key = key;
          }
          // run() only reads its input, so one source serves every tile.
          t.r.run(g.rgba);
          t.r.paint(t.img.data, time);
          t.ctx.putImageData(t.img, 0, 0);
        } catch (err) {
          if (!t.failed) { t.failed = true; console.warn(`Preset ${i} failed`, err); }
        }
      });
    },
  };
}
