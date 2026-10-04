import { canEncodeVideo, Quality } from 'mediabunny';

export type WebCodecsCodec = 'avc' | 'hevc';

export type EncodeProbe = {
  width: number;
  height: number;
  bitrate: number;
  /** Rate control to probe for. Defaults to variable, the encoders' own default. */
  bitrateMode?: 'constant' | 'variable';
  frameRate?: number;
};

// Used for the up-front capability questions asked before a file is even
// loaded, where there are no real dimensions to probe with yet: whether to
// show the H.265 toggle, and whether this browser will need the CPU fallback.
export const GENERIC_ENCODE_PROBE: EncodeProbe = { width: 1280, height: 720, bitrate: 4_000_000 };

function toEncodeOptions(probe: EncodeProbe) {
  const { bitrate, bitrateMode, ...rest } = probe;
  return { ...rest, quality: new Quality({ bitrate, bitrateMode }) };
}

export async function detectHevcHardwareSupport(probe: EncodeProbe = GENERIC_ENCODE_PROBE): Promise<boolean> {
  return canEncodeVideo('hevc', { ...toEncodeOptions(probe), hardwareAcceleration: 'prefer-hardware' });
}

/**
 * Whether this browser can encode H.264 through WebCodecs at all. A `false`
 * here means every conversion will land on the ffmpeg.wasm fallback, since
 * AVC is the last codec `pickWebCodecsCodec` tries.
 */
export async function canEncodeAvc(probe: EncodeProbe = GENERIC_ENCODE_PROBE): Promise<boolean> {
  return canEncodeVideo('avc', toEncodeOptions(probe));
}

/**
 * Picks the codec the WebCodecs (Mediabunny) path should target, or `null` if
 * neither codec can be encoded here at all, in which case callers should fall
 * back to the ffmpeg.wasm engine.
 *
 * `probe` must reflect the actual resolution/bitrate about to be requested:
 * some browsers (e.g. Brave) support hardware AVC encode in general but
 * reject specific resolution/bitrate/level combinations, so a generic
 * low-res capability check isn't enough to predict whether the real encode
 * will succeed.
 */
export async function pickWebCodecsCodec(preferHevc: boolean, probe: EncodeProbe): Promise<WebCodecsCodec | null> {
  if (preferHevc && (await detectHevcHardwareSupport(probe))) return 'hevc';
  if (await canEncodeAvc(probe)) return 'avc';
  return null;
}

/** Whether `codec` can also be encoded at a constant bitrate with the given probe. */
export async function supportsConstantBitrate(codec: WebCodecsCodec, probe: EncodeProbe): Promise<boolean> {
  const options = toEncodeOptions({ ...probe, bitrateMode: 'constant' });
  // Matches how each codec is actually encoded: HEVC on hardware only.
  return canEncodeVideo(codec, codec === 'hevc' ? { ...options, hardwareAcceleration: 'prefer-hardware' } : options);
}
