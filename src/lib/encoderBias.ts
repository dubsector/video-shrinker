// How far this device's encoder tends to land from the size it is asked for.
// A requested bitrate is only a request: hardware encoders in particular run
// consistently over or under it, by an amount that differs from phone to
// phone, and every miss costs a whole extra pass. Remembering how the last
// conversions came out lets the next one ask for the right amount up front.
//
// Kept in localStorage, on this device only, as two numbers.
export type BiasCodec = 'avc' | 'hevc';

/** Size produced over size requested, for one codec's first pass. */
export type EncoderObservation = { codec: BiasCodec; ratio: number };

export type EncoderBias = Partial<Record<BiasCodec, number>>;

const STORAGE_KEY = 'encoder-bias';

// One odd video shouldn't swing the next conversion, so each new result only
// moves the remembered figure part of the way.
const LEARNING_RATE = 0.5;

// Outside this the result says more about the footage than the encoder: far
// under is a simple video that had no use for the bits, far over is one that
// can't be compressed. Neither should be learned from.
const MIN_RATIO_TO_LEARN = 0.8;
const MAX_RATIO_TO_LEARN = 1.6;

// The correction is applied only within this range. Asking for more than
// planned risks an overshoot, the costlier mistake, so the upward side is
// kept tight.
const MIN_APPLIED_BIAS = 0.92;
const MAX_APPLIED_BIAS = 1.5;

function isRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function loadEncoderBias(): EncoderBias {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof stored !== 'object' || stored === null) return {};
    const { avc, hevc } = stored as Record<string, unknown>;
    return { ...(isRatio(avc) ? { avc } : {}), ...(isRatio(hevc) ? { hevc } : {}) };
  } catch {
    return {};
  }
}

export function rememberEncoderObservation(observation: EncoderObservation): void {
  const { codec, ratio } = observation;
  if (!isRatio(ratio) || ratio < MIN_RATIO_TO_LEARN || ratio > MAX_RATIO_TO_LEARN) return;
  try {
    const bias = loadEncoderBias();
    const previous = bias[codec] ?? 1;
    bias[codec] = previous + (ratio - previous) * LEARNING_RATE;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bias));
  } catch {
    // No storage here (a private window, say); every conversion starts fresh.
  }
}

/** The bitrate to request so that an encoder with this bias produces `bitrate`. */
export function correctForBias(bitrate: number, bias: number | undefined): number {
  if (!isRatio(bias)) return bitrate;
  return Math.round(bitrate / Math.min(MAX_APPLIED_BIAS, Math.max(MIN_APPLIED_BIAS, bias)));
}
