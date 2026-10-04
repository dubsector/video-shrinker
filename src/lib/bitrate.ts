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

/**
 * Bits per pixel per frame below which an encoder visibly starves: blocking,
 * smeared motion, detail turning to mush. Below this, a smaller picture at the
 * same bitrate looks better than a bigger one, because every pixel gets enough
 * bits to look like something. HEVC gets by on noticeably less than AVC.
 */
const MIN_BITS_PER_PIXEL = { avc: 0.045, hevc: 0.03 } as const;

// Steps to shrink through, by the picture's short side. Stopping on common
// sizes keeps the result looking like a normal video to players and upload
// targets rather than an odd one-off resolution.
const SHORT_SIDE_LADDER = [2160, 1440, 1080, 720, 540, 480, 360] as const;

// Frame rates above this are never kept: phones record slow motion at 120 or
// 240 fps, and no one shrinking a video wants to spend the budget on frames
// that only play back at normal speed anyway.
const MAX_FRAME_RATE = 60;

// Only rates high enough that halving them still plays smoothly get halved:
// 60 to 30 and 50 to 25 are invisible to most people, 30 to 15 is not.
const MIN_FRAME_RATE_TO_HALVE = 48;

export type SourceGeometry = {
  width: number;
  height: number;
  /** Null when the source's frame rate couldn't be determined. */
  frameRate: number | null;
};

export type OutputGeometry = {
  width: number;
  height: number;
  /** The rate to encode at, or null when the source's is unknown and its own timing should be kept. */
  frameRate: number | null;
};

function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Picks the picture size and frame rate to encode at for a given bitrate.
 * Encoding a 1080p60 phone clip at under a megabit keeps every pixel and
 * frame and gives each one almost nothing, which looks far worse than the
 * same bitrate spent on 720p30. So frame rate goes first (it costs the least
 * to lose), then the resolution steps down the ladder until each pixel gets
 * enough bits. Never upscales, and never drops below the ladder's last rung.
 */
export function planOutputGeometry(
  source: SourceGeometry,
  videoBitrate: number,
  codec: keyof typeof MIN_BITS_PER_PIXEL,
): OutputGeometry {
  const minBitsPerPixel = MIN_BITS_PER_PIXEL[codec];
  const bitsPerPixel = (width: number, height: number, fps: number) => videoBitrate / (width * height * fps);

  let frameRate = source.frameRate;
  if (frameRate !== null && frameRate > MAX_FRAME_RATE) {
    frameRate /= Math.ceil(frameRate / MAX_FRAME_RATE);
  }
  // Unknown rates are budgeted as 30, the most common one.
  const budgetedFrameRate = frameRate ?? 30;
  if (
    frameRate !== null &&
    frameRate >= MIN_FRAME_RATE_TO_HALVE &&
    bitsPerPixel(source.width, source.height, budgetedFrameRate) < minBitsPerPixel
  ) {
    frameRate /= 2;
  }

  const fps = frameRate ?? budgetedFrameRate;
  const shortSide = Math.min(source.width, source.height);
  let scale = 1;
  if (bitsPerPixel(source.width, source.height, fps) < minBitsPerPixel) {
    const rungs = SHORT_SIDE_LADDER.filter((rung) => rung < shortSide);
    const fitting = rungs.find((rung) => {
      const s = rung / shortSide;
      return bitsPerPixel(source.width * s, source.height * s, fps) >= minBitsPerPixel;
    });
    const rung = fitting ?? rungs[rungs.length - 1];
    if (rung !== undefined) scale = rung / shortSide;
  }

  return {
    width: scale === 1 ? source.width : toEven(source.width * scale),
    height: scale === 1 ? source.height : toEven(source.height * scale),
    frameRate,
  };
}

/**
 * The plan when the source's audio is copied across as it is rather than
 * re-encoded: the audio's size is already fixed, so the video gets whatever
 * the target leaves after it.
 */
export function planBitratesWithCopiedAudio(
  durationSeconds: number,
  targetSizeBytes: number,
  copiedAudioBitrate: number,
  marginRatio: number = FIRST_PASS_MARGIN,
): BitratePlan {
  if (durationSeconds <= 0) throw new Error('Duration must be greater than 0');
  const totalBitrate = (targetSizeBytes * 8 * marginRatio) / durationSeconds;
  return {
    videoBitrate: Math.max(MIN_VIDEO_BITRATE, Math.round(totalBitrate - copiedAudioBitrate)),
    audioBitrate: copiedAudioBitrate,
  };
}
