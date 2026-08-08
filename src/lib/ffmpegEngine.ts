import { FFmpeg } from '@ffmpeg/ffmpeg';
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

export type FfmpegConvertOptions = {
  videoBitrate: number;
  audioBitrate: number;
  hasAudio: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
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
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
