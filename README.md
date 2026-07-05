# Video Shrinker

Shrink a video to a target file size, entirely in your browser. No uploads, no servers, no third-party APIs — the file never leaves your device.

- Hardware-accelerated encoding via [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) (through [Mediabunny](https://mediabunny.dev/)), with an [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) CPU fallback for browsers without WebCodecs support.
- Configurable target size (defaults to 25MB).
- Optional H.265 encoding when your GPU supports it, for smaller files at the same quality.
- Strips GPS location and other metadata by default.

Live at: https://dubsector.github.io/video-shrinker/

## Development

```
npm install
npm run dev
```

## Build

```
npm run build
```
