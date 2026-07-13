import type { WebCodecsCodec } from './capabilities';

export type SourceVideo = {
  width: number;
  height: number;
  /** Average frame rate of the source, in hertz. */
  frameRate: number;
};

export type ScaleTarget = {
  width: number;
  height: number;
};

// Standard resolutions (keyed by the video's shorter dimension) the output may
// be downscaled to, largest to smallest. The source's own resolution is always
// the preferred choice; these are only fallbacks for when the bitrate can't
// support it.
const RESOLUTION_LADDER = [1440, 1080, 720, 540, 480, 360] as const;

// Never downscale below this shorter-dimension size, however small the target.
// Past this point the resolution loss outweighs what the freed-up bitrate buys.
const MIN_DIMENSION = 360;

// Target bits per pixel per frame. When the source resolution falls below this
// for the requested bitrate, each pixel is starved and the output blocks up;
// the same bitrate at a lower resolution looks noticeably sharper. H.265
// reaches the same quality at roughly half the bitrate, so it tolerates a lower
// value before a downscale starts to pay off.
const TARGET_BPP: Record<WebCodecsCodec, number> = {
  avc: 0.07,
  hevc: 0.04,
};

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function bitsPerPixel(bitrate: number, width: number, height: number, frameRate: number): number {
  return bitrate / (width * height * frameRate);
}

/**
 * Decides whether the output should be downscaled so the target bitrate is
 * spent more effectively, returning the target dimensions or `null` to keep the
 * source resolution.
 *
 * The source resolution is always preferred and is kept whenever the bitrate
 * can render it well; downscaling only kicks in once the bitrate is too thin
 * for the native resolution (measured as bits per pixel per frame). Aspect
 * ratio and orientation are preserved, and the frame rate is left untouched.
 */
export function planScale(source: SourceVideo, videoBitrate: number, codec: WebCodecsCodec): ScaleTarget | null {
  const { width: sourceWidth, height: sourceHeight, frameRate } = source;
  if (sourceWidth <= 0 || sourceHeight <= 0 || frameRate <= 0 || videoBitrate <= 0) return null;

  const target = TARGET_BPP[codec];
  const minor = Math.min(sourceWidth, sourceHeight);
  const nativeWidth = even(sourceWidth);
  const nativeHeight = even(sourceHeight);

  // The source resolution first, then each smaller ladder rung in turn.
  const candidateMinors = [minor, ...RESOLUTION_LADDER.filter((rung) => rung < minor)];

  let chosen: ScaleTarget = { width: nativeWidth, height: nativeHeight };
  for (const candidateMinor of candidateMinors) {
    const scale = candidateMinor / minor;
    chosen = { width: even(sourceWidth * scale), height: even(sourceHeight * scale) };
    if (bitsPerPixel(videoBitrate, chosen.width, chosen.height, frameRate) >= target) break;
    if (candidateMinor <= MIN_DIMENSION) break; // don't go below the floor
  }

  // The source resolution already clears the target (or can't be improved on):
  // keep it untouched.
  if (chosen.width >= nativeWidth && chosen.height >= nativeHeight) return null;
  return chosen;
}
