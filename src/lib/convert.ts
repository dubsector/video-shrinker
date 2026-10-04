import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  MPEG_TS,
  Output,
  QTFF,
  WEBM,
} from 'mediabunny';
import {
  type BitratePlan,
  MIN_UPWARD_GROWTH,
  type OutputGeometry,
  planBitrates,
  planBitratesWithCopiedAudio,
  planOutputGeometry,
  refinedPassMargin,
  refineVideoBitrate,
  type SourceGeometry,
  sourceVideoBitrateCeiling,
  UNDERSHOOT_RETRY_RATIO,
  UPWARD_PASS_MARGIN,
} from './bitrate';
import { detectHevcHardwareSupport } from './capabilities';
import type { PauseGate } from './pauseGate';
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
  /** Output picture size, or null when encoding was skipped and the source's picture is untouched. */
  width: number | null;
  height: number | null;
};

export type ConvertOptions = {
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  /** Lets the caller pause and resume. Only the WebCodecs engine can stop mid-encode. */
  pauseGate?: PauseGate;
  /** Resolves once the page is in view; an encode the browser cut short waits on it before running again. */
  whenVisible?: () => Promise<void>;
  /** `pausable` is false while the ffmpeg.wasm engine runs, which has no way to pause. */
  onProgress?: (progress: number, phase: ConversionPhase, pausable: boolean) => void;
};

type Attempt = {
  blob: Blob;
  engine: EngineUsed;
  codec: string;
  hardwareAccelerated: boolean;
  width: number;
  height: number;
};

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
  try {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      // 'forced' drops a track that can't be copied instead of transcoding it,
      // so nothing here can quietly re-encode. Any shift keeps audio and video
      // in sync with each other and only moves them off the source's absolute
      // timestamps, which an MP4 often can't hold as they are anyway.
      copy: { mode: 'forced', shiftTolerance: Infinity },
      tags: {},
    });
    // A dropped track means the copy would lose the picture or the sound.
    if (!conversion.isValid || conversion.discardedTracks.length > 0) return null;
    await conversion.execute();
    return output.target.buffer ? new Blob([output.target.buffer], { type: 'video/mp4' }) : null;
  } catch (err) {
    console.warn('[video-shrinker] Metadata-only remux failed, falling back to a re-encode:', err);
    return null;
  }
}

// Set when a conversion touched the ffmpeg engine, so the source can be
// dropped from the wasm filesystem afterwards without importing that module
// (and its 32 MB core) on the WebCodecs path that never used it.
let usedFfmpeg = false;

function isImprovement(candidate: Attempt, baseline: Attempt, targetSizeBytes: number): boolean {
  const candidateOver = candidate.blob.size > targetSizeBytes;
  const baselineOver = baseline.blob.size > targetSizeBytes;

  if (candidateOver !== baselineOver) return !candidateOver; // prefer whichever is at-or-under target
  if (!candidateOver) return candidate.blob.size > baseline.blob.size; // both under: prefer using more of the budget
  return candidate.blob.size < baseline.blob.size; // both over: prefer the smaller overshoot
}

// Packets read to estimate the source audio's bitrate: about 20 seconds of
// AAC, enough to average out its variation without reading through the file.
const AUDIO_STATS_PACKETS = 1000;

/**
 * The bitrate to budget for the source's audio if it can be copied across
 * untouched, or null if it should be re-encoded. Copying skips an encode and
 * the generation loss that comes with one, so it wins whenever the source is
 * AAC (which MP4 holds natively) and no bigger than a re-encode would be.
 */
async function copiableAudioBitrate(audioTrack: InputAudioTrack, plannedAudioBitrate: number): Promise<number | null> {
  try {
    if ((await audioTrack.getCodec()) !== 'aac') return null;
    const { averageBitrate } = await audioTrack.computePacketStats(AUDIO_STATS_PACKETS);
    // Budgeted slightly high: the estimate comes from the first stretch only.
    const budgeted = Math.ceil(averageBitrate * 1.05);
    return Number.isFinite(budgeted) && budgeted > 0 && budgeted <= plannedAudioBitrate ? budgeted : null;
  } catch {
    return null;
  }
}

/** The source's frame rate as measured from its frame timing, or null if it can't be pinned down. */
async function measureFrameRate(videoTrack: InputVideoTrack): Promise<number | null> {
  try {
    const { bestGuessFrameRate } = await videoTrack.computeFrameRateMetrics();
    return Number.isFinite(bestGuessFrameRate) && bestGuessFrameRate > 0 ? bestGuessFrameRate : null;
  } catch {
    return null;
  }
}

/** What every attempt of one conversion shares; only the bitrate and phase change between passes. */
type ConversionContext = {
  file: File;
  input: Input;
  durationSeconds: number;
  audioTrack: InputAudioTrack | null;
  copyAudio: boolean;
  geometry: OutputGeometry;
  /** Whether the geometry differs from the source's picture size. */
  resize: boolean;
  source: SourceGeometry;
  options: ConvertOptions;
};

async function attemptConversion(
  context: ConversionContext,
  videoBitrate: number,
  audioBitrate: number,
  phase: ConversionPhase,
): Promise<Attempt> {
  const { file, input, durationSeconds, audioTrack, copyAudio, resize, source, options } = context;
  let { geometry } = context;
  const encodeWithWebCodecs = (atGeometry: OutputGeometry, atResize: boolean) =>
    convertWithWebCodecs(input, durationSeconds, audioTrack, atGeometry, atResize, {
      videoBitrate,
      audioBitrate,
      // The first pass keeps variable bitrate for its better picture; a pass
      // that exists to correct the size is the one that needs precision.
      constantBitrate: phase === 'refining',
      copyAudio,
      preferHevc: options.preferHevc,
      stripMetadata: options.stripMetadata,
      pauseGate: options.pauseGate,
      onProgress: (info) => options.onProgress?.(info.progress, phase, true),
    });

  let webCodecsOutcome = await encodeWithWebCodecs(geometry, resize);
  // An encode that was already under way has shown WebCodecs can handle this
  // file, so failing partway is the browser taking the encoder back, not a
  // reason to drop to ffmpeg.wasm (many times slower, and unpausable). Chrome
  // does this to pages left in the background, behind a lock screen or
  // another app. The pass runs again on WebCodecs once the page is back in
  // view; only a second failure goes on to ffmpeg.
  if (!webCodecsOutcome.ok && webCodecsOutcome.interrupted) {
    console.warn('[video-shrinker] WebCodecs encode was interrupted, retrying it:', webCodecsOutcome.fallbackReason);
    await options.whenVisible?.();
    webCodecsOutcome = await encodeWithWebCodecs(geometry, resize);
  }
  // The first downscaling attempt (#74) shipped a resize that made every
  // WebCodecs encode fail, and it had to be reverted. If resizing is ever what
  // breaks an encode again, the cost is the smaller picture rather than the
  // conversion: the source size gets one more try before ffmpeg.wasm.
  if (!webCodecsOutcome.ok && resize) {
    console.warn('[video-shrinker] Resized WebCodecs encode failed, retrying at the source size:', webCodecsOutcome.fallbackReason);
    const unresized = { ...geometry, width: source.width, height: source.height };
    const retry = await encodeWithWebCodecs(unresized, false);
    if (retry.ok) {
      geometry = unresized;
      webCodecsOutcome = retry;
    }
  }

  if (webCodecsOutcome.ok) {
    const { blob, codec, hardwareAccelerated } = webCodecsOutcome.result;
    return { blob, engine: 'webcodecs', codec, hardwareAccelerated, width: geometry.width, height: geometry.height };
  }

  // Lazy-loaded: most browsers can use WebCodecs, so the ffmpeg.wasm
  // wrapper (and its wasm binary) should only be fetched when needed.
  const { convertWithFfmpeg } = await import('./ffmpegEngine');
  usedFfmpeg = true;
  // ffmpeg can't stop mid-encode, but a pause asked for before it starts holds.
  await options.pauseGate?.whenResumed();
  options.onProgress?.(0, phase, false);
  try {
    const ffmpegResult = await convertWithFfmpeg(file, {
      videoBitrate,
      audioBitrate,
      hasAudio: !!audioTrack,
      copyAudio,
      geometry,
      resize,
      stripMetadata: options.stripMetadata,
      onProgress: (ratio) => options.onProgress?.(ratio, phase, false),
    });
    return {
      blob: ffmpegResult.blob,
      engine: 'ffmpeg',
      codec: 'avc',
      hardwareAccelerated: false,
      width: geometry.width,
      height: geometry.height,
    };
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
 * When the budget is too thin for the source's picture, the frame rate and
 * then the resolution come down until each pixel gets enough bits to look
 * clean (see planOutputGeometry).
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
  const input = new Input({
    formats: INPUT_FORMATS,
    source: new BlobSource(file, {
      // Read-ahead runs in the background, and a file that goes unreadable
      // mid-way (a shared video whose sending app revoked access, say) would
      // otherwise surface as an unhandled rejection on top of the real error.
      handleUnhandledError: (err) => console.warn('[video-shrinker] Background read failed:', err),
    }),
  });

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
        width: null,
        height: null,
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

    // Resolved once here rather than inside each attempt: none of it changes
    // between passes, and reading it means seeking around the file.
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('This file has no video track to convert.');
    const source: SourceGeometry = {
      width: await videoTrack.getDisplayWidth(),
      height: await videoTrack.getDisplayHeight(),
      frameRate: await measureFrameRate(videoTrack),
    };

    let plan: BitratePlan = planBitrates(duration, targetSizeBytes, hasAudio);
    const copiedAudioBitrate = audioTrack ? await copiableAudioBitrate(audioTrack, plan.audioBitrate) : null;
    if (copiedAudioBitrate !== null) plan = planBitratesWithCopiedAudio(duration, targetSizeBytes, copiedAudioBitrate);

    // HEVC needs fewer bits per pixel, so it keeps a bigger picture at the
    // same budget. Probed at the source size: if the GPU encodes HEVC there,
    // it encodes it at anything smaller too.
    const likelyHevc =
      options.preferHevc &&
      (await detectHevcHardwareSupport({ width: source.width, height: source.height, bitrate: plan.videoBitrate }));
    const geometry = planOutputGeometry(source, plan.videoBitrate, likelyHevc ? 'hevc' : 'avc');
    const resize = geometry.width !== source.width || geometry.height !== source.height;

    // Asking for more than the source itself carries would inflate the file
    // rather than shrink it, so no pass may exceed this.
    const bitrateCeiling = sourceVideoBitrateCeiling(file.size, duration, plan.audioBitrate);

    const context: ConversionContext = {
      file,
      input,
      durationSeconds: duration,
      audioTrack,
      copyAudio: copiedAudioBitrate !== null,
      geometry,
      resize,
      source,
      options,
    };

    let videoBitrate = Math.min(plan.videoBitrate, bitrateCeiling);
    let attempt = await attemptConversion(context, videoBitrate, plan.audioBitrate, 'encoding');
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
      attempt = await attemptConversion(context, videoBitrate, plan.audioBitrate, 'refining');

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
        width: null,
        height: null,
      };
    }

    return {
      ...best,
      videoBitrate: bestVideoBitrate,
      audioBitrate: plan.audioBitrate,
    };
  } finally {
    if (usedFfmpeg) {
      usedFfmpeg = false;
      // Already loaded by the time this runs, so the import is immediate.
      await import('./ffmpegEngine').then(({ releaseFfmpegInput }) => releaseFfmpegInput());
    }
    input.dispose();
  }
}
