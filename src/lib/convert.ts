import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import { planBitrates, refineVideoBitrate } from './bitrate';
import { convertWithWebCodecs } from './webcodecsEngine';

export type EngineUsed = 'webcodecs' | 'ffmpeg';

export type ConversionPhase = 'encoding' | 'refining';

export type ConvertResult = {
  blob: Blob;
  engine: EngineUsed;
  codec: string;
  videoBitrate: number;
  audioBitrate: number;
};

export type ConvertOptions = {
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  onProgress?: (progress: number, phase: ConversionPhase) => void;
};

type Attempt = { blob: Blob; engine: EngineUsed; codec: string };

function isImprovement(candidate: Attempt, baseline: Attempt, targetSizeBytes: number): boolean {
  const candidateOver = candidate.blob.size > targetSizeBytes;
  const baselineOver = baseline.blob.size > targetSizeBytes;

  if (candidateOver !== baselineOver) return !candidateOver; // prefer whichever is at-or-under target
  if (!candidateOver) return candidate.blob.size > baseline.blob.size; // both under: prefer using more of the budget
  return candidate.blob.size < baseline.blob.size; // both over: prefer the smaller overshoot
}

async function attemptConversion(
  file: File,
  input: Input,
  durationSeconds: number,
  audioTrack: InputAudioTrack | null,
  videoBitrate: number,
  audioBitrate: number,
  phase: ConversionPhase,
  options: ConvertOptions,
): Promise<Attempt> {
  const webCodecsResult = await convertWithWebCodecs(input, durationSeconds, audioTrack, {
    videoBitrate,
    audioBitrate,
    preferHevc: options.preferHevc,
    stripMetadata: options.stripMetadata,
    onProgress: (info) => options.onProgress?.(info.progress, phase),
  });

  if (webCodecsResult) {
    return { blob: webCodecsResult.blob, engine: 'webcodecs', codec: webCodecsResult.codec };
  }

  // Lazy-loaded: most browsers can use WebCodecs, so the ffmpeg.wasm
  // wrapper (and its wasm binary) should only be fetched when needed.
  const { convertWithFfmpeg } = await import('./ffmpegEngine');
  const ffmpegResult = await convertWithFfmpeg(file, {
    videoBitrate,
    audioBitrate,
    hasAudio: !!audioTrack,
    stripMetadata: options.stripMetadata,
    onProgress: (ratio) => options.onProgress?.(ratio, phase),
  });
  return { blob: ffmpegResult.blob, engine: 'ffmpeg', codec: 'avc' };
}

/**
 * Converts `file` to roughly `targetSizeBytes`, entirely in the browser.
 * Tries hardware-accelerated WebCodecs first, and falls back to the
 * ffmpeg.wasm (CPU) engine when this browser can't encode video via
 * WebCodecs at all. Nothing here ever leaves the browser.
 *
 * The requested bitrate is only a request to the encoder; how many bytes it
 * actually produces depends on the content and how closely this browser's
 * encoder honors the request. Landing under the target is always accepted
 * as-is; only an overshoot triggers a corrective second pass, re-encoding
 * with a bitrate scaled down by the measured result.
 */
export async function convertVideo(file: File, targetSizeBytes: number, options: ConvertOptions): Promise<ConvertResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    const duration = await input.computeDuration();
    if (duration <= 0) throw new Error("Couldn't determine this file's duration.");
    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = !!audioTrack;

    const plan = planBitrates(duration, targetSizeBytes, hasAudio);
    const first = await attemptConversion(
      file,
      input,
      duration,
      audioTrack,
      plan.videoBitrate,
      plan.audioBitrate,
      'encoding',
      options,
    );

    if (first.blob.size <= targetSizeBytes) {
      return { ...first, videoBitrate: plan.videoBitrate, audioBitrate: plan.audioBitrate };
    }

    const refinedVideoBitrate = refineVideoBitrate(
      plan.videoBitrate,
      plan.audioBitrate,
      first.blob.size,
      duration,
      targetSizeBytes,
    );
    const second = await attemptConversion(
      file,
      input,
      duration,
      audioTrack,
      refinedVideoBitrate,
      plan.audioBitrate,
      'refining',
      options,
    );

    return isImprovement(second, first, targetSizeBytes)
      ? { ...second, videoBitrate: refinedVideoBitrate, audioBitrate: plan.audioBitrate }
      : { ...first, videoBitrate: plan.videoBitrate, audioBitrate: plan.audioBitrate };
  } finally {
    input.dispose();
  }
}
