import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  type InputAudioTrack,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  MPEG_TS,
  Output,
  QTFF,
  WEBM,
} from 'mediabunny';
import {
  MIN_UPWARD_GROWTH,
  planBitrates,
  refinedPassMargin,
  refineVideoBitrate,
  sourceVideoBitrateCeiling,
  UNDERSHOOT_RETRY_RATIO,
  UPWARD_PASS_MARGIN,
} from './bitrate';
import { convertWithWebCodecs } from './webcodecsEngine';

/**
 * Beyond the two encoders, three outcomes skip encoding: 'original' hands back
 * a file that was already under target untouched, 'remux' repackages such a
 * file to drop metadata without re-encoding the picture, and 'unshrinkable'
 * means encoding was tried but never beat the source's own size.
 */
export type EngineUsed = 'webcodecs' | 'ffmpeg' | 'original' | 'remux' | 'unshrinkable';

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

// Only the video containers this app can actually be handed. ALL_FORMATS also
// registers the audio-only demuxers (WAVE, OGG, FLAC, MP3, ADTS) and HLS,
// which no file passing the video/* check can ever match.
//
// AVI and MPEG-PS are deliberately absent even though the share target accepts
// them: mediabunny ships no demuxer for either, so they always take the
// ffmpeg.wasm path. They stay advertised so the system share sheet keeps
// offering this app for them, at the cost of the slower engine.
const INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM, MPEG_TS];

/**
 * Repackages the file without re-encoding it, dropping its metadata on the
 * way. Used when the source is already under target and the only thing left
 * to do is honor `stripMetadata` — copying the encoded samples costs a fraction
 * of an encode and leaves the picture untouched.
 *
 * Returns `null` when the streams can't be copied into MP4 as they are, since
 * Mediabunny would silently transcode them at a default quality instead;
 * callers fall back to a normal encode in that case.
 */
async function remuxWithoutMetadata(input: Input): Promise<Blob | null> {
  const format = new Mp4OutputFormat();
  const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);

  const videoCodec = await videoTrack?.getCodec();
  if (!videoCodec || !format.getSupportedVideoCodecs().includes(videoCodec)) return null;
  if (audioTrack) {
    const audioCodec = await audioTrack.getCodec();
    if (!audioCodec || !format.getSupportedAudioCodecs().includes(audioCodec)) return null;
  }

  try {
    const output = new Output({ format, target: new BufferTarget() });
    // No codec, quality or bitrate on either track: that is what lets
    // Mediabunny copy the encoded samples across rather than re-encode them.
    const conversion = await Conversion.init({ input, output, tags: {} });
    if (!conversion.isValid) return null;
    await conversion.execute();
    return output.target.buffer ? new Blob([output.target.buffer], { type: 'video/mp4' }) : null;
  } catch (err) {
    console.warn('[video-shrinker] Metadata-only remux failed, falling back to a re-encode:', err);
    return null;
  }
}

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
 * encoder honors the request. A corrective pass runs in either direction —
 * down when an attempt overshoots the target, up when one lands so far under
 * that most of the budget went unspent — for up to MAX_REFINEMENT_PASSES,
 * each scaled by the previous measured result. The best attempt is returned:
 * the largest one at or under target, or the smallest overshoot if none made
 * it under.
 */
export async function convertVideo(file: File, targetSizeBytes: number, options: ConvertOptions): Promise<ConvertResult> {
  const input = new Input({ formats: INPUT_FORMATS, source: new BlobSource(file) });

  try {
    const duration = await input.computeDuration();
    if (duration <= 0) throw new Error("Couldn't determine this file's duration.");
    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = !!audioTrack;

    // Already under target, so an encode could only spend time to make the
    // picture worse. Metadata stripping is the one thing still owed, and a
    // stream copy delivers that without touching the video.
    if (file.size <= targetSizeBytes) {
      const untouched = {
        engine: 'original' as const,
        codec: 'original',
        hardwareAccelerated: false,
        videoBitrate: 0,
        audioBitrate: 0,
      };
      if (!options.stripMetadata) return { ...untouched, blob: file };

      const stripped = await remuxWithoutMetadata(input);
      // A remux that somehow came back over target is no longer a free win, so
      // it goes down the normal path along with sources that can't be copied.
      // Coming back a fraction of a percent above the *source* is fine and
      // expected — container overhead differs — because the size the user
      // asked for is still met and the metadata they asked to drop is gone.
      if (stripped && stripped.size <= targetSizeBytes) {
        return { ...untouched, engine: 'remux', blob: stripped };
      }
    }

    const plan = planBitrates(duration, targetSizeBytes, hasAudio);
    // Asking for more than the source itself carries would inflate the file
    // rather than shrink it, so no pass may exceed this.
    const bitrateCeiling = sourceVideoBitrateCeiling(file.size, duration, plan.audioBitrate);

    let videoBitrate = Math.min(plan.videoBitrate, bitrateCeiling);
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

    for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass++) {
      const overshot = attempt.blob.size > targetSizeBytes;
      // Under target is acceptable at any distance, but leaving most of the
      // budget unspent hands back less quality than the user asked for.
      const underused = attempt.blob.size < targetSizeBytes * UNDERSHOOT_RETRY_RATIO;
      if (!overshot && !underused) break;
      // Nothing left to spend: the request is already at what the source has.
      if (!overshot && videoBitrate >= bitrateCeiling) break;

      // Scale from the most recent attempt's measured size — this is the
      // feedback that makes it converge even when the encoder ignores the exact
      // requested bitrate.
      const nextBitrate = Math.min(
        bitrateCeiling,
        refineVideoBitrate(
          videoBitrate,
          plan.audioBitrate,
          attempt.blob.size,
          duration,
          targetSizeBytes,
          overshot ? refinedPassMargin(pass) : UPWARD_PASS_MARGIN,
        ),
      );
      // The correction has nowhere to go — floor, ceiling, or a step the wrong
      // way — so another pass would just re-encode the same thing.
      if (overshot ? nextBitrate >= videoBitrate : nextBitrate <= videoBitrate) break;

      const sizeBeforePass = attempt.blob.size;
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

      // Raising the bitrate barely moved the output, so this footage is
      // already at its natural size and another pass would just be waiting.
      if (!overshot && attempt.blob.size < sizeBeforePass * MIN_UPWARD_GROWTH) break;
    }

    // Every attempt came back bigger than the file we were handed. Encoders
    // can blow past a requested bitrate on footage they can't compress (heavy
    // grain, confetti, rain), and returning that is worse than doing nothing.
    // A metadata-stripping copy is still an improvement if one is available.
    if (best.blob.size >= file.size) {
      const stripped = options.stripMetadata ? await remuxWithoutMetadata(input) : null;
      return {
        blob: stripped && stripped.size <= file.size ? stripped : file,
        engine: 'unshrinkable',
        codec: 'original',
        hardwareAccelerated: false,
        videoBitrate: 0,
        audioBitrate: 0,
      };
    }

    return { ...best, videoBitrate: bestVideoBitrate, audioBitrate: plan.audioBitrate };
  } finally {
    input.dispose();
  }
}
