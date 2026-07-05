import { FFmpeg } from '@ffmpeg/ffmpeg';

const CORE_URL = '/ffmpeg-core/ffmpeg-core.js';
const WASM_URL = '/ffmpeg-core/ffmpeg-core.wasm';

let ffmpegPromise: Promise<FFmpeg> | null = null;

// FFmpeg core is loaded once and reused; it's self-hosted from this site's
// own static assets, never fetched from a third-party CDN.
function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export type FfmpegResult = {
  blob: Blob;
};

export type FfmpegConvertOptions = {
  videoBitrate: number;
  audioBitrate: number;
  hasAudio: boolean;
  /** Strips GPS location and all other metadata from the output. */
  stripMetadata: boolean;
  onProgress?: (ratio: number) => void;
};

/**
 * CPU-only fallback conversion path using ffmpeg.wasm (libx264), used when
 * this browser can't encode video via WebCodecs at all.
 */
export async function convertWithFfmpeg(file: File, options: FfmpegConvertOptions): Promise<FfmpegResult> {
  const { videoBitrate, audioBitrate, hasAudio, stripMetadata, onProgress } = options;

  const ffmpeg = await getFFmpeg();

  const onProgressEvent = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on('progress', onProgressEvent);

  const inputName = 'input' + (file.name.match(/\.[^.]+$/)?.[0] ?? '.mp4');
  const outputName = 'output.mp4';

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

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
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
    ];
    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', `${audioBitrate}`);
    } else {
      args.push('-an');
    }
    // Strips GPS location and all other format/stream metadata (ffmpeg
    // otherwise copies it from the input by default).
    if (stripMetadata) args.push('-map_metadata', '-1');
    args.push(outputName);

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);

    const data = await ffmpeg.readFile(outputName);
    const bytes = new Uint8Array(data as Uint8Array);
    return { blob: new Blob([bytes], { type: 'video/mp4' }) };
  } finally {
    ffmpeg.off('progress', onProgressEvent);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
