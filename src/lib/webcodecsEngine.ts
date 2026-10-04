import { BufferTarget, Conversion, type Input, type InputAudioTrack, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import type { OutputGeometry } from './bitrate';
import { pickWebCodecsCodec, supportsConstantBitrate } from './capabilities';
import type { PauseGate } from './pauseGate';

export type ProgressInfo = {
  progress: number;
  processedSeconds: number;
  durationSeconds: number;
};

export type WebCodecsResult = {
  blob: Blob;
  codec: 'avc' | 'hevc';
  /**
   * Whether the encode was requested with `prefer-hardware`. WebCodecs gives
   * no way to confirm a hardware encoder actually ran, only whether one was
   * asked for: HEVC is only chosen after a hardware HEVC probe succeeds, so
   * `true` there is a reliable signal, but AVC deliberately requests
   * `no-preference` (see below) and so may silently run in software.
   */
  hardwareAccelerated: boolean;
};

export type WebCodecsConvertOptions = {
  videoBitrate: number;
  audioBitrate: number;
  /**
   * Asks the encoder to hold the bitrate steady instead of letting it float.
   * Variable bitrate spends bits where the picture needs them, so it looks
   * better at a given size, but hardware encoders drift from the requested
   * average by more than a target size can absorb. Correction passes trade
   * that bit of quality for landing on target. Falls back to variable when
   * the encoder doesn't offer constant.
   */
  constantBitrate: boolean;
  /** Copies the source's audio across untouched rather than re-encoding it. */
  copyAudio: boolean;
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  pauseGate?: PauseGate;
  onProgress?: (info: ProgressInfo) => void;
};

// Mediabunny's default is a key frame every 5 seconds. Each one costs several
// times what an ordinary frame does, and this app's output gets played start
// to finish far more than it gets scrubbed through, so spacing them out hands
// those bytes back to the picture.
const KEY_FRAME_INTERVAL_SECONDS = 10;

/**
 * Result of a WebCodecs attempt: either a successful encode, or a failure
 * carrying the reason, so a caller that subsequently also fails on the
 * ffmpeg.wasm fallback can report both causes instead of just the last one.
 */
export type WebCodecsOutcome =
  | { ok: true; result: WebCodecsResult }
  | { ok: false; fallbackReason: string };

/**
 * Converts a video file entirely in the browser using WebCodecs (via
 * Mediabunny), which decodes/encodes through the browser's native media
 * pipeline and uses hardware acceleration whenever the browser/GPU offers it.
 *
 * Resolves to `ok: false` when this browser can't encode the file here (no
 * usable codec, or the encoder rejects the specific resolution/bitrate at
 * configure/encode time), signaling the caller to fall back to ffmpeg.wasm.
 */
export async function convertWithWebCodecs(
  input: Input,
  durationSeconds: number,
  audioTrack: InputAudioTrack | null,
  geometry: OutputGeometry,
  resize: boolean,
  options: WebCodecsConvertOptions,
): Promise<WebCodecsOutcome> {
  const { width, height } = geometry;
  const frameRate = geometry.frameRate ?? undefined;

  // Some browsers (e.g. Brave) support hardware AVC encode in general but
  // reject specific resolution/bitrate/level combinations, so the probe must
  // match what's actually about to be requested, not a generic placeholder.
  // This one stays per-attempt for that reason: the bitrate changes each pass.
  const probe = { width, height, bitrate: options.videoBitrate, frameRate };
  const codec = await pickWebCodecsCodec(options.preferHevc, probe);
  if (!codec) return { ok: false, fallbackReason: 'No usable video codec available via WebCodecs in this browser.' };
  // Checked for the codec already picked, so a correction pass never switches
  // codec just because only the other one offers constant bitrate.
  const bitrateMode =
    options.constantBitrate && (await supportsConstantBitrate(codec, probe)) ? 'constant' : 'variable';

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

  // HEVC is only ever chosen after detectHevcHardwareSupport() confirmed a
  // hardware HEVC encoder (software HEVC is too slow to want), so keep
  // prefer-hardware there. AVC must NOT force prefer-hardware: Mediabunny
  // decides AVC is encodable by probing with no hardware preference, so the
  // browser may report a High-profile config (e.g. avc1.640032 at 1440p) as
  // supported via its software encoder, then throw at configure() time when we
  // demand hardware the GPU can't provide — needlessly collapsing to the slow
  // ffmpeg.wasm CPU path. Leaving AVC at no-preference lets that same software
  // encoder actually run, matching what was probed.
  const hardwareAcceleration = codec === 'hevc' ? 'prefer-hardware' : 'no-preference';

  try {
    const conversion = await Conversion.init({
      input,
      output,
      // The size budget covers one picture and one soundtrack. Extra tracks
      // (a second language, a commentary track) would be encoded on top of it.
      tracks: 'primary',
      video: {
        codec,
        quality: new Quality({ bitrate: options.videoBitrate, bitrateMode }),
        hardwareAcceleration,
        keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
        // Only one of the two is needed: Mediabunny keeps the aspect ratio.
        width: resize ? width : undefined,
        // Set even when it matches the source. Without it the encoder isn't
        // told the frame rate and assumes one, and a rate controller budgeting
        // for 30 fps on 60 fps footage spends each frame's share twice.
        frameRate,
      },
      // Left without a codec or quality, the audio is copied as it is. That is
      // only chosen for AAC already within budget, which MP4 holds natively.
      audio: !audioTrack
        ? { discard: true }
        : options.copyAudio
          ? {}
          : { codec: 'aac', quality: new Quality(options.audioBitrate) },
      // Any shift keeps audio and video in sync with each other; it only moves
      // both off the source's absolute timestamps, which nothing here needs.
      // Without it, sources that start at an offset MP4 can't express (common
      // with AAC priming) would have their audio silently re-encoded at a
      // default quality instead of copied.
      copy: { shiftTolerance: Infinity },
      // Descriptive tags (location, title, artist, etc.) are normally copied
      // over by Mediabunny by default; an empty object here replaces them
      // instead, so nothing from the source file's metadata survives.
      tags: options.stripMetadata ? {} : undefined,
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((t) => t.reason).join(', ');
      throw new Error(`This file's tracks can't be converted here (${reasons}).`);
    }

    // Mediabunny drops a track it can't handle instead of failing, and the
    // conversion stays valid as long as whatever remains makes a playable
    // file. Losing the video track therefore produces an audio-only MP4 that
    // looks like a successful shrink — which is what a browser without HEVC
    // decode does to every HEVC recording. Treat it as a WebCodecs failure so
    // the ffmpeg.wasm fallback, which brings its own decoders, gets a turn.
    const discardedVideo = conversion.discardedTracks.find((track) => track.track.isVideoTrack());
    if (discardedVideo) {
      throw new Error(`This browser can't handle this file's video track (${discardedVideo.reason}).`);
    }

    conversion.onProgress = (progress, processedTime) => {
      options.onProgress?.({ progress, processedSeconds: processedTime, durationSeconds });
    };

    // A paused execute() returns early with the conversion still 'idle', and
    // the next call carries on from where it stopped.
    const gate = options.pauseGate;
    await gate?.whenResumed();
    await conversion.execute({ pauseSignal: gate?.signal });
    while (gate && conversion.state !== 'done') {
      await gate.whenResumed();
      await conversion.execute({ pauseSignal: gate.signal });
    }
  } catch (err) {
    // Neither isConfigSupported() nor Conversion.init() is a perfect predictor
    // of what the encoder accepts once configured (init can also reject a track
    // outright); in any of those cases, degrade to the CPU fallback instead of
    // surfacing a raw encoder error.
    console.warn('[video-shrinker] WebCodecs encode failed, falling back to ffmpeg.wasm:', err);
    return { ok: false, fallbackReason: err instanceof Error ? err.message : String(err) };
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Conversion finished without producing output data.');

  return {
    ok: true,
    result: {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      codec,
      hardwareAccelerated: hardwareAcceleration === 'prefer-hardware',
    },
  };
}
