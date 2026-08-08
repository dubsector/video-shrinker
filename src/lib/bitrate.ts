export const MIN_VIDEO_BITRATE = 100_000;

const AUDIO_BITRATE_CANDIDATES = [128_000, 96_000, 64_000, 32_000] as const;

// The first pass is a blind guess (bitrate requested from the encoder isn't
// the same as bytes actually produced, which depends on content
// compressibility and how closely this browser's encoder honors the
// request), so it aims just under the target rather than dead-on.
const FIRST_PASS_MARGIN = 0.93;

// A corrective pass only runs when the previous pass overshot the target
// (landing under is always accepted, however far under). It uses the previous
// pass's measured output size to scale the bitrate down accurately. Headroom
// tightens on each successive pass: a VBR hardware encoder's overshoot ratio
// can drift between encodes, so a fixed margin can still land just over target
// after one correction — aiming progressively lower absorbs that drift.
const REFINED_PASS_MARGINS = [0.97, 0.93] as const;

// Landing under target is fine, but a pass this far under spent so little of
// the budget that the user got noticeably less quality than they asked for.
// Kept low enough that an ordinary conversion still finishes in one pass.
export const UNDERSHOOT_RETRY_RATIO = 0.75;

// Correcting upward can turn an under-target result into an overshoot, which
// costs another pass to undo, so it aims lower than a downward pass does.
export const UPWARD_PASS_MARGIN = 0.9;

// How much an upward pass has to grow the output to be worth continuing.
// Simple footage can be at its natural size already, where raising the bitrate
// produces the same bytes back and further passes are pure waiting.
export const MIN_UPWARD_GROWTH = 1.05;

export function refinedPassMargin(pass: number): number {
  return REFINED_PASS_MARGINS[Math.min(pass, REFINED_PASS_MARGINS.length - 1)];
}

/**
 * The highest video bitrate worth asking for from a given source. Requesting
 * more than the file already carries just re-encodes its existing artifacts
 * into more bytes, which is how a small input ends up with a larger output.
 *
 * Estimated from the container's overall average (size over duration) rather
 * than measured per-track: mediabunny can compute exact packet stats, but only
 * by reading through the file, which is far too expensive for a ceiling.
 */
export function sourceVideoBitrateCeiling(
  fileBytes: number,
  durationSeconds: number,
  audioBitrate: number,
): number {
  if (durationSeconds <= 0) throw new Error('Duration must be greater than 0');
  const sourceTotalBitrate = (fileBytes * 8) / durationSeconds;
  return Math.max(MIN_VIDEO_BITRATE, Math.round(sourceTotalBitrate - audioBitrate));
}

export type BitratePlan = {
  videoBitrate: number;
  audioBitrate: number;
};

export function planBitrates(
  durationSeconds: number,
  targetSizeBytes: number,
  hasAudio: boolean,
  marginRatio: number = FIRST_PASS_MARGIN,
): BitratePlan {
  if (durationSeconds <= 0) throw new Error('Duration must be greater than 0');

  const totalBitrate = (targetSizeBytes * 8 * marginRatio) / durationSeconds;

  if (!hasAudio) {
    return { videoBitrate: Math.max(MIN_VIDEO_BITRATE, Math.round(totalBitrate)), audioBitrate: 0 };
  }

  for (const audioBitrate of AUDIO_BITRATE_CANDIDATES) {
    const videoBitrate = totalBitrate - audioBitrate;
    if (videoBitrate >= MIN_VIDEO_BITRATE) {
      return { videoBitrate: Math.round(videoBitrate), audioBitrate };
    }
  }

  const minAudioBitrate = AUDIO_BITRATE_CANDIDATES[AUDIO_BITRATE_CANDIDATES.length - 1];
  return { videoBitrate: MIN_VIDEO_BITRATE, audioBitrate: minAudioBitrate };
}

/**
 * Scales `previousVideoBitrate` based on how far off `actualBytes` landed
 * from `targetSizeBytes`, for a corrective second encoding pass.
 */
export function refineVideoBitrate(
  previousVideoBitrate: number,
  audioBitrate: number,
  actualBytes: number,
  durationSeconds: number,
  targetSizeBytes: number,
  marginRatio: number = REFINED_PASS_MARGINS[0],
): number {
  const targetBytes = targetSizeBytes * marginRatio;
  const audioBytes = (audioBitrate * durationSeconds) / 8;
  const actualVideoBytes = Math.max(1, actualBytes - audioBytes);
  const targetVideoBytes = Math.max(1, targetBytes - audioBytes);
  const ratio = Math.min(5, Math.max(0.15, targetVideoBytes / actualVideoBytes));
  return Math.max(MIN_VIDEO_BITRATE, Math.round(previousVideoBitrate * ratio));
}
