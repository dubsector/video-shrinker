// Kept apart from ffmpegEngine.ts so the warm-up can name these files without
// importing the engine, which would pull @ffmpeg/ffmpeg into the entry bundle.
//
// Root-absolute paths would resolve against the domain root, but the site is
// served from a subpath, so these must go through the configured base.
export const FFMPEG_CORE_URL = `${import.meta.env.BASE_URL}ffmpeg-core/ffmpeg-core.js`;
export const FFMPEG_WASM_URL = `${import.meta.env.BASE_URL}ffmpeg-core/ffmpeg-core.wasm`;
