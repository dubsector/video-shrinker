import { canEncodeVideo } from 'mediabunny';

export type WebCodecsCodec = 'avc' | 'hevc';

const PROBE_OPTIONS = { width: 1280, height: 720, bitrate: 4_000_000 } as const;

export async function detectHevcHardwareSupport(): Promise<boolean> {
  return canEncodeVideo('hevc', { ...PROBE_OPTIONS, hardwareAcceleration: 'prefer-hardware' });
}

/**
 * Picks the codec the WebCodecs (Mediabunny) path should target, or `null` if
 * neither codec can be encoded here at all, in which case callers should fall
 * back to the ffmpeg.wasm engine.
 */
export async function pickWebCodecsCodec(preferHevc: boolean): Promise<WebCodecsCodec | null> {
  if (preferHevc && (await detectHevcHardwareSupport())) return 'hevc';
  if (await canEncodeVideo('avc', PROBE_OPTIONS)) return 'avc';
  return null;
}
