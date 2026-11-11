# Lumen

Turn a video or an image into a dithered, halftone, LED, ASCII or scanline version in the browser, then export it as MP4, MOV, GIF, PNG, a self-contained HTML page or a snippet to paste into your own site.

```
npm install
npm run dev     # open the printed URL, drop a video or image in
npm test        # dither core, looks, glow, twinkle, clips, renderer, player, frame packing
```

The page loads a ~40 KB script; the codecs (Mediabunny, gifenc) load on first use. Nothing is uploaded: decoding, dithering and encoding all run locally (WebCodecs via [Mediabunny](https://mediabunny.dev), GIFs via gifenc).

Before a file is loaded the page runs a built-in demo animation, so the looks can be tried straight away. Export needs a real file.

## Looks

The strip under the preview shows every preset drawn live from the current frame; click one to apply it. There are five: Bayer (8×8 ordered dither in the source's colours), Pocket (four grey shades in a 4×4 Bayer pattern; recolour with Ink and Paper), Neon ASCII, LED wall and CRT. Presets reset the look, colour, dither and tone settings, then set their own.

- **Shape:** Pixels (square dots, the classic dither), LED dots, Halftone (dot size follows tone), ASCII (a 10-step character ramp from a built-in bitmap font) and Scanlines.
- **Cell size:** pixels per cell in the export. For Pixels this is the export scale.
- **Background:** the colour between dots or characters. Auto uses the paper colour in mono and black otherwise.
- **Glow:** bloom on top of any look. Whatever differs from the background spreads light around it: on a dark background dots and characters glow, on a light one dark ink bleeds. *Glow size* (under More) is in cells, so the preview and every export match. The glowing presets are Neon ASCII, LED wall and CRT.
- **Twinkle:** now and then a lit cell flares, a bright core with a small four-point star and a soft halo about a cell or two across, then fades over a fraction of a second. The slider sets how many and how bright. Which cells flare, and when, follows from the cell and the moment in the source, so the preview, every export and the HTML player twinkle identically, and a paused frame or a still image stays still. On light backgrounds the flare deepens the ink instead. Neon ASCII has some by default.

Every look is a set of 1-bit stamps over the same indexed dither, so GIFs stay exact and the HTML embed stays small. Glow and twinkles are the exception: they add in-between colours (see Exports).

## Controls

- **Dither:** threshold, Bayer 2/4/8, blue noise (void-and-cluster), Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Sierra lite. 2–8 levels, amount (error carried, or ordered pattern strength), serpentine scan.
- **Tone:** brightness, contrast, gamma, threshold (also biases ordered and diffusion dithers), invert.
- **Colour, mono:** ink and paper; extra levels are blended between them.
- **Colour, original:** R, G and B are each dithered on their own with 2–6 levels per channel (8–216 colours), so the video keeps its own colours.
- **Colour, palette:** 2–16 colours. Presets (RGB 8, CMY + K, CGA, EGA 16, Green 4, Sepia 4, Riso, Ice, Ember), editable swatches, or *Pick colours from source*, which samples 12 frames across the trim range (after tone controls) and quantises them. Nearest colour is matched in OKLab through a 64³ lookup table. Diffusion carries RGB error; ordered dithers use Knoll pattern dithering so mixes average to the right colour on any palette. Saturation slider appears in this mode.
- **Size:** frame (original, 16:9, 9:16, 1:1, 4:5, 4:3, 21:9) with crop to fill or fit with black bars. "Dots on long side" is the dither resolution, so portrait and landscape behave the same. Export scale multiplies it with nearest-neighbour, so dots stay square. Rotation metadata (phone videos) is applied and baked into exports.
- **Time:** output frame rate (set to the source's rate when a video loads). Video only.

## Clips

Cut several snippets from one video and export each as its own file, in the current look and format.

- **I** / **O** (or the Set buttons) put In and Out at the playhead. Times are to the millisecond (`0:03.250`), as is the playhead readout. Setting one past the other moves the other out of the way.
- **A** (Add clip) keeps In → Out in the list and resets the selection to the whole video. Clips are sorted by start; exact duplicates are skipped.
- Clips show on the seek bar, and the current selection is outlined. Click a clip in the list to play it on a loop; touching the seek bar stops the loop.
- Export writes one file per clip (`name-clip01-ascii.gif`, …). With an empty list it exports In → Out. PNG always saves the frame at the playhead. The browser may ask once to allow several downloads.

The list is per video and clears when another file is loaded. **Copy as command** copies an `npm run cut` command with the clips, format and every look setting, for the command-line exporter below.

## Command line

`npm run cut` exports with the same looks, dither and glow as the app, using ffmpeg (`brew install ffmpeg`) to decode and encode. One file per `--clip`, written next to the input unless `-o` says otherwise; existing files are left alone without `--force`.

```
npm run cut -- trip.mp4 --clip 0:01.250-0:02.500 --clip 12-14.5 --preset phosphor --format gif
npm run cut -- trip.mp4 --clip 3-7 --settings '{…}'       # pasted from Copy as command
npm run cut -- trip.mp4 --preset led --set glow=0.8 --scale 6 --aspect 9:16
npm run cut -- --presets                                    # preset ids
npm run cut -- --help
```

Name a clip to name its file: `--clip lilies=2:47.779-2:55.749` writes `lilies-<preset>.mp4`. `--tag` changes the suffix, `--crf` the H.264 quality (default 14; lower is better and bigger).

**Grids** put several looks side by side in one video (MP4, MOV or PNG). Each `--tile` is a preset and/or settings; tiles fill rows left to right. Every tile is drawn at the smallest whole cell size that covers `--tile-size`, then centre-cropped, so dots stay sharp (no resampling). The source is decoded once per tile and the grid encoded once.

```
npm run cut -- flowers.mp4 -c lilies=2:47.779-2:55.749 --tile-size 1920x1080 \
  --tile led,width=160 --tile bayer,width=390 --tile neonascii,width=160 --tile crt,algorithm=atkinson
```

Clips cut on whole frames: at 30 fps a range can come out up to one frame (33 ms) shorter than asked. MP4/MOV are H.264 (CRF 14) with AAC audio; GIF, HTML and PNG match the app's exports.

Images (PNG, JPEG, WebP and so on) work the same way, without the transport, Time group or MP4/MOV.

Keys: space plays/pauses, `s` toggles the unprocessed source, `m` mutes, `i` / `o` set In / Out, `a` adds a clip.

## Exports

| Format | Notes |
| --- | --- |
| MP4 / MOV | H.264, keeps audio. Use a scale of 3× or more, or chroma subsampling and compression soften single-pixel dots. Most encoders cap at 4096 px. |
| GIF | Exact palette (up to 216 colours in Original mode), no quantisation. With glow or twinkles on, the look's own colours stay exact and the remaining slots of 256 are quantised per frame for them. Delays carry their remainder so long clips stay in sync. |
| PNG | The frame at the playhead (or the image), lossless. |
| HTML | Standalone page or embed snippet. The snippet is a canvas plus a small script that can be pasted into a page more than once; it pauses off screen, honours reduced motion, and fits its container with contain or cover. The size is shown after export, with a button to copy the snippet. One file, no dependencies. Frames are packed at 1–8 bits per pixel, XORed against the previous frame, deflated and base64'd; a ~1 KB canvas runtime plays them. Usually smaller than the GIF. With glow or twinkles on, the player draws them itself (about 2.5 KB more for glow, 2 KB for twinkles) and draws square pixels at full size. Click to pause. Embed with an `<iframe>`. |

## Showcase site

`site/` is a one-page showcase: a piece fills the screen, an index switches works and looks, and the HTML pieces carry a lens. Build it with `npm run site` and open `/site/` on the dev server. Pieces are embed snippets in `site/pieces/` named `<work>-<n>-<look>-embed.html` (made with `npm run cut … -f html --embed snippet --set embedFit=cover --lens …`). Both the pieces and the built `site/index.html` are git-ignored.

- `?edit` or **E** turns on a temporary text editor: drag the headline per piece, **A** cycles alignment, **+ / −** or the wheel resize, **Copy all positions** gives JSON to bake into `POSITIONS` in `site/template.html`.

**Lens:** HTML exports can show a second look inside a circle that follows the pointer (drifting on its own when idle; a tap moves it on touch screens). From the CLI: `--lens ascii` (or `led`, `halftone`, `scan`, `square`) and `--lens-size 0.22` (fraction of the shorter side).

## Layout

- `src/frame.js`: output geometry (aspect, crop/fit, long side)
- `src/clips.js`: clip list logic (in/out, sorting, times, file names)
- `src/settings.js`, `src/encode.js`: app defaults and presets, GIF and HTML writers; shared by the page and the CLI
- `scripts/cut.js`: the command-line exporter
- `src/dither.js`: pure dither core (luma, algorithms, palette), shared by preview and export
- `src/bluenoise.js`: 64×64 blue-noise threshold map, generated on first use (~50 ms)
- `src/export.js`: probe, MP4/MOV via `Conversion` with a `process` hook, GIF/HTML via `CanvasSink`
- `src/looks.js`, `src/presets.js`: stamps for each look, and the one-click presets
- `src/glow.js`: bloom on the painted frame, blurred on a coarse grid and upsampled; the HTML player embeds its source
- `src/twinkle.js`: twinkles, scheduled by hashing cell and time; also embedded in the player
- `src/render.js`, `src/source.js`: dither + look renderer, image decoding
- `src/preview.js`, `src/preview-worker.js`: the live preview and looks strip, drawn in a worker on transferred canvases (main-thread fallback). The page sends one frame at a time and skips frames while the worker is busy.
- `src/pack.js`, `src/player.js`: HTML export format, player and embed snippet
- `?test` exposes `window.__vd` for headless runs
