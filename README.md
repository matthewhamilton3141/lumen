# vid-dith

Turn a video into a dithered one in the browser, then export it as MP4, MOV, GIF or a self-contained HTML player.

```
npm install
npm run dev     # open the printed URL, drop a video in
npm test        # dither core + frame packing
```

Nothing is uploaded: decoding, dithering and encoding all run locally (WebCodecs via [Mediabunny](https://mediabunny.dev), GIFs via gifenc).

## Controls

- **Dither:** threshold, Bayer 2/4/8, blue noise (void-and-cluster), Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Sierra lite. 2–8 levels, amount (error carried, or ordered pattern strength), serpentine scan.
- **Tone:** brightness, contrast, gamma, threshold (also biases ordered and diffusion dithers), invert.
- **Colour, mono:** ink and paper; extra levels are blended between them.
- **Colour, original:** R, G and B are each dithered on their own with 2–6 levels per channel (8–216 colours), so the video keeps its own colours.
- **Colour, palette:** 2–16 colours. Presets (RGB 8, CMY + K, CGA, EGA 16, Green 4, Sepia 4, Riso, Ice, Ember), editable swatches, or *Pick colours from video*, which samples 12 frames across the trim range (after tone controls) and quantises them. Nearest colour is matched in OKLab through a 64³ lookup table. Diffusion carries RGB error; ordered dithers use Knoll pattern dithering so mixes average to the right colour on any palette. Saturation slider appears in this mode.
- **Size:** frame (original, 16:9, 9:16, 1:1, 4:5, 4:3, 21:9) with crop to fill or fit with black bars. "Dots on long side" is the dither resolution, so portrait and landscape behave the same. Export scale multiplies it with nearest-neighbour, so dots stay square. Rotation metadata (phone videos) is applied and baked into exports.
- **Time:** output frame rate, trim start/end (Set takes the playhead).

Keys: space plays/pauses, `o` toggles the undithered source, `m` mutes.

## Exports

| Format | Notes |
| --- | --- |
| MP4 / MOV | H.264, keeps audio. Use a scale of 3× or more, or chroma subsampling and compression soften single-pixel dots. Most encoders cap at 4096 px. |
| GIF | Exact palette (up to 216 colours in Original mode), no quantisation. Delays carry their remainder so long clips stay in sync. |
| HTML | One file, no dependencies. Frames are packed at 1–8 bits per pixel, XORed against the previous frame, deflated and base64'd; a ~1 KB canvas runtime plays them. Usually smaller than the GIF. Click to pause. Embed with an `<iframe>`. |

## Layout

- `src/frame.js`: output geometry (aspect, crop/fit, long side)
- `src/dither.js`: pure dither core (luma, algorithms, palette), shared by preview and export
- `src/bluenoise.js`: 64×64 blue-noise threshold map, generated on first use (~50 ms)
- `src/export.js`: probe, MP4/MOV via `Conversion` with a `process` hook, GIF/HTML via `CanvasSink`
- `src/pack.js`, `src/player.js`: HTML export format and player
- `?test` exposes `window.__vd` for headless runs
