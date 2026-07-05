# Video Shrinker

Shrinks a video to a target file size, entirely in the browser. Nothing gets uploaded — encoding happens locally via WebCodecs (hardware-accelerated when the browser/GPU support it), with an ffmpeg.wasm fallback for browsers that don't.

https://dubsector.github.io/video-shrinker/

It's installable as a PWA — Chrome offers "Install app" / "Add to Home screen," and after the first load it works fully offline.

## How it works

- Pick a target size (defaults to 25MB — Discord's non-Nitro upload limit). Duration and target size get turned into a bitrate request for the encoder.
- That request is approximate, not exact: actual output size depends on content complexity and how closely the browser's encoder honors the request. The first pass aims a bit under target; if it overshoots anyway, a second pass re-encodes with a corrected bitrate. Landing under target on the first try is accepted as-is, however far under.
- H.265 gets used instead of H.264 automatically when the browser reports hardware HEVC encode support, since it's meaningfully smaller at the same quality. There's a toggle if you'd rather force H.264 for compatibility.
- Metadata (location, title, artist, comments, embedded images) gets stripped by default. Toggleable if you want to keep it.

## Stack

- [Mediabunny](https://mediabunny.dev/) for the WebCodecs demux/decode/encode/mux pipeline
- [ffmpeg.wasm](https://ffmpegwasm.netlify.app/), self-hosted rather than loaded from a CDN, as the CPU fallback
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) for the installable/offline bits
- React + Vite, deployed to GitHub Pages via Actions

## Development

```
npm install
npm run dev
```

## Build

```
npm run build
```
