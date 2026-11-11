import { canEncodeAudio } from 'mediabunny';

let ready: Promise<void> | null = null;

/**
 * Makes sure AAC can be encoded here. Chrome on Linux and Firefox ship no
 * AAC encoder, and without one Mediabunny drops the audio track and the
 * result comes out silent. For those browsers this loads a WebAssembly build
 * of FFmpeg's AAC encoder (about 1 MB) and hands it to Mediabunny; everywhere
 * else it does nothing and the download never happens.
 *
 * A failure to load it is logged and otherwise ignored, which leaves things
 * as they were before: a video with no sound rather than no video at all.
 */
export function ensureAacEncoder(): Promise<void> {
  ready ??= (async () => {
    try {
      if (await canEncodeAudio('aac')) return;
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
    } catch (err) {
      console.warn('[video-shrinker] Could not load the AAC encoder; the result may have no sound:', err);
    }
  })();
  return ready;
}
