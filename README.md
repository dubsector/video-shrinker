# Video Shrinker

[![PR Checks](https://github.com/dubsector/video-shrinker/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/dubsector/video-shrinker/actions/workflows/pr-checks.yml)
[![Deploy to GitHub Pages](https://github.com/dubsector/video-shrinker/actions/workflows/deploy.yml/badge.svg)](https://github.com/dubsector/video-shrinker/actions/workflows/deploy.yml)

[GitHub Pages Deployment](https://dubsector.github.io/video-shrinker/)

Shrinks a video to a target file size, entirely in the browser. Nothing gets uploaded. Encoding happens locally via WebCodecs (hardware-accelerated when the browser/GPU support it), with an ffmpeg.wasm fallback for browsers that don't.

It's installable as an app. An in-page banner offers to install it directly, or you can use your browser's own "Install app" and/or "Add to Home screen" option. After the first load it works fully offline, and when a new version ships, a small banner offers to reload and update on your own schedule instead of forcing it mid-conversion.

## How it works

- Pick a target size (defaults to 25MB, Discord's non-Nitro upload limit). Duration and target size get turned into a bitrate request for the encoder.
- That request is approximate, not exact: actual output size depends on content complexity and how closely the browser's encoder honors the request. The first pass aims a bit under target; if it overshoots anyway, a second pass re-encodes with a corrected bitrate. Landing under target on the first try is accepted as-is, however far under.
- H.265 gets used instead of H.264 automatically when the browser reports hardware HEVC encode support, since it's meaningfully smaller at the same quality. There's a toggle if you'd rather force H.264 for compatibility.
- Metadata (location, title, artist, comments, embedded images) gets stripped by default. Toggleable if you want to keep it.

## Stack

- [Mediabunny](https://mediabunny.dev/) for the WebCodecs demux/decode/encode/mux pipeline
- [ffmpeg.wasm](https://ffmpegwasm.netlify.app/), self-hosted rather than loaded from a CDN, as the CPU fallback
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) for the installable/offline bits
- React + Vite, deployed to GitHub Pages via Actions

## License

video-shrinker's own source is [MIT](LICENSE).

The CPU-fallback encoder (`@ffmpeg/core`, only loaded when a browser can't do
WebCodecs hardware encoding) is a separately-distributed FFmpeg build compiled
with `--enable-gpl --enable-libx264 --enable-libx265`, which makes that binary
**GPL-2.0-or-later**, not MIT/LGPL. It's self-hosted from this repo as a static
asset. Its corresponding source is the upstream project at the exact version
in use: [ffmpegwasm/ffmpeg.wasm @ v0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10)
([build config](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v0.12.10/Dockerfile)).

Everything else shipped to the browser is permissive: React and React-DOM
(MIT), `@ffmpeg/ffmpeg`'s JS wrapper and `@ffmpeg/types` (MIT), and Mediabunny
(MPL-2.0). Build-only tooling (Vite, TypeScript, oxlint, the PWA/static-copy
plugins) isn't distributed with the app and isn't covered here.

## Development

```
npm install
npm run dev
```

## Build

```
npm run build
```
