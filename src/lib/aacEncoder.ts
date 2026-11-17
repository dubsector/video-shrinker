import { canEncodeAudio } from 'mediabunny';

let ready: Promise<void> | undefined;

/**
 * Makes sure Mediabunny can encode AAC sound. Chrome on Linux and Firefox have
 * no AAC encoder of their own, and without one Mediabunny drops the audio
 * track, so the shrunk video comes out silent. Only on those browsers is
 * FFmpeg's AAC encoder (WebAssembly, about 590 KB gzipped) downloaded and
 * registered; browsers with their own encoder never fetch it. If loading
 * fails, the conversion goes ahead as before.
 */
export function ensureAacEncoder(): Promise<void> {
  ready ??= (async () => {
    try {
      if (await canEncodeAudio('aac')) return;
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
    } catch (err) {
      console.warn('Could not load the AAC encoder; the video may have no sound.', err);
      // Lets a later conversion try again, e.g. after a dropped connection.
      ready = undefined;
    }
  })();
  return ready;
}
