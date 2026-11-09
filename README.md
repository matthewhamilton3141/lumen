# vid-dith

Turn a video into a dithered one in the browser, then export it as MP4, MOV, GIF or a self-contained HTML player.

```
npm install
npm run dev     # open the printed URL, drop a video in
npm test        # dither core + frame packing
```

Nothing is uploaded: decoding, dithering and encoding all run locally (WebCodecs via [Mediabunny](https://mediabunny.dev), GIFs via gifenc).

## Controls

- **Dither:** threshold, Bayer 2/4/8, blue noise (void-and-cluster), Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Sierra lite. 2–8 levels, diffusion amount, serpentine scan.
- **Tone:** brightness, contrast, gamma, threshold (also biases ordered and diffusion dithers), invert.
- **Colour:** ink and paper; extra levels are blended between them.
- **Size:** "dots across" is the dither resolution. Export scale multiplies it with nearest-neighbour, so dots stay square.
- **Time:** output frame rate, trim start/end (Set takes the playhead).

Keys: space plays/pauses, `o` toggles the original.

## Exports

| Format | Notes |
| --- | --- |
| MP4 / MOV | H.264, keeps audio. Use a scale of 3× or more, or chroma subsampling and compression soften single-pixel dots. Most encoders cap at 4096 px. |
| GIF | Exact palette (2–8 colours), no quantisation. Delays carry their remainder so long clips stay in sync. |
| HTML | One file, no dependencies. Frames are packed at 1–3 bits per pixel, XORed against the previous frame, deflated and base64'd; a ~1 KB canvas runtime plays them. Usually smaller than the GIF. Click to pause. Embed with an `<iframe>`. |

## Layout

- `src/dither.js`: pure dither core (luma, algorithms, palette), shared by preview and export
- `src/bluenoise.js`: 64×64 blue-noise threshold map, generated on first use (~50 ms)
- `src/export.js`: probe, MP4/MOV via `Conversion` with a `process` hook, GIF/HTML via `CanvasSink`
- `src/pack.js`, `src/player.js`: HTML export format and player
- `?test` exposes `window.__vd` for headless runs
