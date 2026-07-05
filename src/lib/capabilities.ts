import { canEncodeVideo } from 'mediabunny';

export type WebCodecsCodec = 'avc' | 'hevc';

export type EncodeProbe = {
  width: number;
  height: number;
  bitrate: number;
};

// Used only for the up-front "does this browser support H.265 hardware
// encode at all" toggle visibility check, before a file is even loaded.
const GENERIC_HEVC_PROBE: EncodeProbe = { width: 1280, height: 720, bitrate: 4_000_000 };

export async function detectHevcHardwareSupport(probe: EncodeProbe = GENERIC_HEVC_PROBE): Promise<boolean> {
  return canEncodeVideo('hevc', { ...probe, hardwareAcceleration: 'prefer-hardware' });
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
  if (await canEncodeVideo('avc', probe)) return 'avc';
  return null;
}
