import { BufferTarget, Conversion, type Input, type InputAudioTrack, Mp4OutputFormat, Output } from 'mediabunny';
import { pickWebCodecsCodec } from './capabilities';

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
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  onProgress?: (info: ProgressInfo) => void;
};

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
  options: WebCodecsConvertOptions,
): Promise<WebCodecsOutcome> {
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('This file has no video track to convert.');

  const width = await videoTrack.getDisplayWidth();
  const height = await videoTrack.getDisplayHeight();

  // Some browsers (e.g. Brave) support hardware AVC encode in general but
  // reject specific resolution/bitrate/level combinations, so the probe must
  // match what's actually about to be requested, not a generic placeholder.
  const codec = await pickWebCodecsCodec(options.preferHevc, { width, height, bitrate: options.videoBitrate });
  if (!codec) return { ok: false, fallbackReason: 'No usable video codec available via WebCodecs in this browser.' };

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
      video: {
        codec,
        bitrate: options.videoBitrate,
        hardwareAcceleration,
      },
      audio: audioTrack ? { codec: 'aac', bitrate: options.audioBitrate } : { discard: true },
      // Descriptive tags (location, title, artist, etc.) are normally copied
      // over by Mediabunny by default; an empty object here replaces them
      // instead, so nothing from the source file's metadata survives.
      tags: options.stripMetadata ? {} : undefined,
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((t) => t.reason).join(', ');
      throw new Error(`This file's tracks can't be converted here (${reasons}).`);
    }

    conversion.onProgress = (progress, processedTime) => {
      options.onProgress?.({ progress, processedSeconds: processedTime, durationSeconds });
    };

    await conversion.execute();
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
