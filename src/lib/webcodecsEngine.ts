import { BufferTarget, canEncodeVideo, Conversion, type Input, type InputAudioTrack, Mp4OutputFormat, Output } from 'mediabunny';
import { pickWebCodecsCodec } from './capabilities';
import { planScale, type SourceVideo } from './resolution';

export type ProgressInfo = {
  progress: number;
  processedSeconds: number;
  durationSeconds: number;
};

export type WebCodecsResult = {
  blob: Blob;
  codec: 'avc' | 'hevc';
  /** Dimensions of the produced video (may be smaller than the source). */
  width: number;
  height: number;
};

export type WebCodecsConvertOptions = {
  source: SourceVideo;
  videoBitrate: number;
  audioBitrate: number;
  preferHevc: boolean;
  /** Strips metadata (location, title, artist, etc.) from the output. */
  stripMetadata: boolean;
  onProgress?: (info: ProgressInfo) => void;
};

/**
 * Converts a video file entirely in the browser using WebCodecs (via
 * Mediabunny), which decodes/encodes through the browser's native media
 * pipeline and uses hardware acceleration whenever the browser/GPU offers it.
 *
 * Returns `null` when this browser can't encode the file here (no usable
 * codec, or the encoder rejects the specific resolution/bitrate at
 * configure/encode time), signaling the caller to fall back to ffmpeg.wasm.
 */
export async function convertWithWebCodecs(
  input: Input,
  durationSeconds: number,
  audioTrack: InputAudioTrack | null,
  options: WebCodecsConvertOptions,
): Promise<WebCodecsResult | null> {
  const { width, height } = options.source;

  // Some browsers (e.g. Brave) support hardware AVC encode in general but
  // reject specific resolution/bitrate/level combinations, so the probe must
  // match what's actually about to be requested, not a generic placeholder.
  const codec = await pickWebCodecsCodec(options.preferHevc, { width, height, bitrate: options.videoBitrate });
  if (!codec) return null;

  // Spend the bitrate more effectively by downscaling when the source
  // resolution is too high for it; the source resolution is kept otherwise.
  // Verify the encoder actually accepts the smaller size before committing to
  // it (a downscale should never make an encode fail, but stay defensive and
  // fall back to the source resolution if it somehow does).
  const scaled = planScale(options.source, options.videoBitrate, codec);
  const scaledOk =
    scaled !== null &&
    (await canEncodeVideo(codec, {
      width: scaled.width,
      height: scaled.height,
      bitrate: options.videoBitrate,
      hardwareAcceleration: 'prefer-hardware',
    }));
  const outputWidth = scaledOk ? scaled.width : width;
  const outputHeight = scaledOk ? scaled.height : height;

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec,
      bitrate: options.videoBitrate,
      hardwareAcceleration: 'prefer-hardware',
      ...(scaledOk ? { width: outputWidth, height: outputHeight } : {}),
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

  try {
    await conversion.execute();
  } catch (err) {
    // isConfigSupported() isn't always a perfect predictor of what the
    // encoder will actually accept once configured; if it still fails here,
    // degrade to the CPU fallback instead of surfacing a raw encoder error.
    console.warn('[video-shrinker] WebCodecs encode failed, falling back to ffmpeg.wasm:', err);
    return null;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Conversion finished without producing output data.');

  return { blob: new Blob([buffer], { type: 'video/mp4' }), codec, width: outputWidth, height: outputHeight };
}
