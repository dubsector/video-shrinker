import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import { planBitrates, refinedPassMargin, refineVideoBitrate } from './bitrate';
import { convertWithWebCodecs } from './webcodecsEngine';

export type EngineUsed = 'webcodecs' | 'ffmpeg';

export type ConversionPhase = 'encoding' | 'refining';

export type ConvertResult = {
  blob: Blob;
  engine: EngineUsed;
  codec: string;
  /** Only meaningful when engine is 'webcodecs'; ffmpeg.wasm is always CPU-only. */
  hardwareAccelerated: boolean;
  videoBitrate: number;
  audioBitrate: number;
};

export type ConvertOptions = {
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  onProgress?: (progress: number, phase: ConversionPhase) => void;
};

type Attempt = { blob: Blob; engine: EngineUsed; codec: string; hardwareAccelerated: boolean };

// Each corrective pass is a full re-encode, so cap how many we run after the
// initial one. Hardware encoders don't honor a requested bitrate exactly
// (WebCodecs exposes no hard bitrate ceiling), so a single correction can still
// land just over target; a couple of measured retries reliably converge under.
const MAX_REFINEMENT_PASSES = 2;

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
  const webCodecsOutcome = await convertWithWebCodecs(input, durationSeconds, audioTrack, {
    videoBitrate,
    audioBitrate,
    preferHevc: options.preferHevc,
    stripMetadata: options.stripMetadata,
    onProgress: (info) => options.onProgress?.(info.progress, phase),
  });

  if (webCodecsOutcome.ok) {
    const { blob, codec, hardwareAccelerated } = webCodecsOutcome.result;
    return { blob, engine: 'webcodecs', codec, hardwareAccelerated };
  }

  // Lazy-loaded: most browsers can use WebCodecs, so the ffmpeg.wasm
  // wrapper (and its wasm binary) should only be fetched when needed.
  const { convertWithFfmpeg } = await import('./ffmpegEngine');
  try {
    const ffmpegResult = await convertWithFfmpeg(file, {
      videoBitrate,
      audioBitrate,
      hasAudio: !!audioTrack,
      stripMetadata: options.stripMetadata,
      onProgress: (ratio) => options.onProgress?.(ratio, phase),
    });
    return { blob: ffmpegResult.blob, engine: 'ffmpeg', codec: 'avc', hardwareAccelerated: false };
  } catch (err) {
    // The WebCodecs failure reason would otherwise be lost here (it only ever
    // reached console.warn), leaving just ffmpeg's generic error on screen
    // when both engines fail. Surface both.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (WebCodecs also failed: ${webCodecsOutcome.fallbackReason})`);
  }
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
 * as-is; an overshoot triggers up to MAX_REFINEMENT_PASSES corrective passes,
 * each re-encoding with a bitrate scaled down by the previous measured result,
 * stopping as soon as one lands under target. The smallest-overshoot attempt is
 * returned if none make it under.
 */
export async function convertVideo(file: File, targetSizeBytes: number, options: ConvertOptions): Promise<ConvertResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    const duration = await input.computeDuration();
    if (duration <= 0) throw new Error("Couldn't determine this file's duration.");
    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = !!audioTrack;

    const plan = planBitrates(duration, targetSizeBytes, hasAudio);

    let videoBitrate = plan.videoBitrate;
    let attempt = await attemptConversion(
      file,
      input,
      duration,
      audioTrack,
      videoBitrate,
      plan.audioBitrate,
      'encoding',
      options,
    );
    let best = attempt;
    let bestVideoBitrate = videoBitrate;

    for (let pass = 0; pass < MAX_REFINEMENT_PASSES && best.blob.size > targetSizeBytes; pass++) {
      // Scale down from the most recent attempt's measured size — this is the
      // feedback that makes it converge even when the encoder ignores the exact
      // requested bitrate.
      const nextBitrate = refineVideoBitrate(
        videoBitrate,
        plan.audioBitrate,
        attempt.blob.size,
        duration,
        targetSizeBytes,
        refinedPassMargin(pass),
      );
      // The bitrate floor is already hit and can't drop further, so another
      // pass would just re-encode the same thing.
      if (nextBitrate >= videoBitrate) break;

      videoBitrate = nextBitrate;
      attempt = await attemptConversion(
        file,
        input,
        duration,
        audioTrack,
        videoBitrate,
        plan.audioBitrate,
        'refining',
        options,
      );

      if (isImprovement(attempt, best, targetSizeBytes)) {
        best = attempt;
        bestVideoBitrate = videoBitrate;
      }
    }

    return { ...best, videoBitrate: bestVideoBitrate, audioBitrate: plan.audioBitrate };
  } finally {
    input.dispose();
  }
}
