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
};

export type WebCodecsConvertOptions = {
  videoBitrate: number;
  audioBitrate: number;
  preferHevc: boolean;
  /** Strips GPS location and all other descriptive metadata tags from the output. */
  stripMetadata: boolean;
  onProgress?: (info: ProgressInfo) => void;
};

/**
 * Converts a video file entirely in the browser using WebCodecs (via
 * Mediabunny), which decodes/encodes through the browser's native media
 * pipeline and uses hardware acceleration whenever the browser/GPU offers it.
 *
 * Returns `null` when no usable video codec could be encoded in this browser,
 * signaling the caller to fall back to the ffmpeg.wasm engine.
 */
export async function convertWithWebCodecs(
  input: Input,
  durationSeconds: number,
  audioTrack: InputAudioTrack | null,
  options: WebCodecsConvertOptions,
): Promise<WebCodecsResult | null> {
  const codec = await pickWebCodecsCodec(options.preferHevc);
  if (!codec) return null;

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec,
      bitrate: options.videoBitrate,
      hardwareAcceleration: 'prefer-hardware',
    },
    audio: audioTrack ? { codec: 'aac', bitrate: options.audioBitrate } : { discard: true },
    // GPS location (e.g. QuickTime's udta location atom) and other descriptive
    // tags are normally copied over by Mediabunny by default; an empty object
    // here replaces them instead, so nothing from the source file's metadata
    // survives into the output.
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

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Conversion finished without producing output data.');

  return { blob: new Blob([buffer], { type: 'video/mp4' }), codec };
}
