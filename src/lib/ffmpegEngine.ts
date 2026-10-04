import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg';
import type { OutputGeometry } from './bitrate';
import { FFMPEG_CORE_URL as CORE_URL, FFMPEG_WASM_URL as WASM_URL } from './ffmpegAssets';

let ffmpegPromise: Promise<FFmpeg> | null = null;

/**
 * Fetches an asset here in the page and hands back a blob URL for it.
 *
 * Handing @ffmpeg/ffmpeg a plain URL makes it load the core inside a worker it
 * creates from a blob URL, and such a worker is outside the service worker's
 * control: its import goes straight to the network and fails offline, even
 * with the file sitting in the cache. Fetching from here goes through the
 * service worker as normal, and a blob URL needs no network at all to import.
 */
async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load ${url} (${response.status}).`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
}

// FFmpeg core is loaded once and reused; it's self-hosted from this site's
// own static assets, never fetched from a third-party CDN.
function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(CORE_URL, 'text/javascript'),
        toBlobURL(WASM_URL, 'application/wasm'),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export type FfmpegResult = {
  blob: Blob;
};

// Where the source is mounted. WORKERFS reads straight from the File as
// ffmpeg asks for bytes, so the source never gets copied into the wasm heap:
// the multi-hundred-MB files this app is built for, on the devices slow
// enough to need this engine, used to cost their full size in memory up front
// (and anything near 2 GB couldn't be loaded at all). The mount stays across
// refinement passes; convertVideo() calls releaseFfmpegInput() once it is
// finished with the file.
const INPUT_DIR = '/input';
let mountedInput: { file: File; path: string } | null = null;

async function mountInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  if (mountedInput?.file === file) return mountedInput.path;
  await releaseFfmpegInput();
  // A fixed name rather than the user's: theirs can hold anything, and only
  // the extension matters to ffmpeg's format probing.
  const name = 'input' + (file.name.match(/\.[^.]+$/)?.[0] ?? '.mp4');
  await ffmpeg.createDir(INPUT_DIR).catch(() => {});
  await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name, data: file }] }, INPUT_DIR);
  mountedInput = { file, path: `${INPUT_DIR}/${name}` };
  return mountedInput.path;
}

/** Unmounts the source. Safe to call when nothing is mounted. */
export async function releaseFfmpegInput(): Promise<void> {
  if (!mountedInput || !ffmpegPromise) return;
  mountedInput = null;
  await (await ffmpegPromise).unmount(INPUT_DIR).catch(() => {});
}

export type FfmpegConvertOptions = {
  videoBitrate: number;
  audioBitrate: number;
  hasAudio: boolean;
  /** Copies the source's audio across untouched rather than re-encoding it. */
  copyAudio: boolean;
  geometry: OutputGeometry;
  /** Whether the geometry differs from the source's picture size. */
  resize: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  onProgress?: (ratio: number) => void;
};

/**
 * CPU-only fallback conversion path using ffmpeg.wasm (libx264), used when
 * this browser can't encode video via WebCodecs at all.
 */
export async function convertWithFfmpeg(file: File, options: FfmpegConvertOptions): Promise<FfmpegResult> {
  const { videoBitrate, audioBitrate, hasAudio, copyAudio, geometry, resize, stripMetadata, onProgress } = options;

  const ffmpeg = await getFFmpeg();

  const onProgressEvent = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on('progress', onProgressEvent);

  const outputName = 'output.mp4';

  try {
    const inputName = await mountInput(ffmpeg, file);

    const args = [
      '-i',
      inputName,
      '-c:v',
      'libx264',
      '-b:v',
      `${videoBitrate}`,
      // Caps peaks around the target average so short/high-motion clips
      // don't blow past the requested output size.
      '-maxrate',
      `${Math.round(videoBitrate * 1.2)}`,
      '-bufsize',
      `${Math.round(videoBitrate * 2)}`,
      // This engine only runs where WebCodecs can't encode, which in practice
      // means the slowest devices, executing x264 in wasm on the CPU — the
      // worst place to spend cycles chasing compression efficiency. Measured
      // on 15s of 1440p60 at a fixed bitrate: medium 13.9s at 33.4 dB PSNR,
      // faster 11.0s at 32.3 dB, veryfast 8.0s at 31.1 dB. `faster` buys most
      // of the time back for about a decibel; veryfast costs more picture than
      // it is worth.
      '-preset',
      'faster',
      '-pix_fmt',
      'yuv420p',
    ];
    // ffmpeg applies rotation before filters run, so these are the same
    // display dimensions the WebCodecs path gets. setsar=1 squares the pixels
    // of anamorphic sources so the new size is the size that plays.
    if (resize) args.push('-vf', `scale=${geometry.width}:${geometry.height},setsar=1`);
    if (geometry.frameRate !== null) args.push('-r', `${geometry.frameRate}`);
    if (hasAudio && copyAudio) {
      args.push('-c:a', 'copy');
    } else if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', `${audioBitrate}`);
    } else {
      args.push('-an');
    }
    // Strips all format/stream metadata (ffmpeg otherwise copies it from
    // the input by default).
    if (stripMetadata) args.push('-map_metadata', '-1');
    args.push(outputName);

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);

    const data = await ffmpeg.readFile(outputName);
    const bytes = new Uint8Array(data as Uint8Array);
    return { blob: new Blob([bytes], { type: 'video/mp4' }) };
  } finally {
    ffmpeg.off('progress', onProgressEvent);
    // The input deliberately stays for the next refinement pass; the caller
    // releases it when the conversion as a whole is done.
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
