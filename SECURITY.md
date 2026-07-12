# Security Policy

## Reporting a Vulnerability

If you discover a security issue in Video Shrinker — the web app, the service worker, the share-target flow, the Android TWA wrapper, or the build and release pipeline — please report it privately rather than opening a public issue:

- Open a [GitHub Security Advisory](https://github.com/dubsector/video-shrinker/security/advisories/new) in this repository.

Please include steps to reproduce and, where relevant, the browser or Android version affected.

## Scope

Video Shrinker processes video entirely on the device — nothing is uploaded, and encoding happens locally via WebCodecs (with an ffmpeg.wasm fallback). Reports that are especially in scope:

- Any path by which a selected video, its metadata, or its contents could leave the device.
- Cross-site scripting, service-worker cache poisoning, or share-target handling that could be abused.
- Supply-chain risks in the GitHub Actions workflows or published artifacts.

For vulnerabilities in the upstream encoding libraries themselves (mediabunny or ffmpeg.wasm), please also report to those projects.
