import { FFMPEG_CORE_URL, FFMPEG_WASM_URL } from './ffmpegAssets';

/**
 * Reads a response to completion and throws the bytes away. The worker's
 * cache route only stores a response it saw finish, and reading in chunks
 * avoids holding all 32 MB in the page at once just to discard it.
 */
async function drain(url: string): Promise<void> {
  const response = await fetch(url);
  const reader = response.body?.getReader();
  if (!reader) return;
  while (!(await reader.read()).done);
}

/**
 * Pulls the ffmpeg.wasm core into the service worker's cache on the devices
 * that are going to need it.
 *
 * The core is deliberately kept out of the precache: it is 32 MB, and the
 * large majority of browsers encode through WebCodecs and never touch it.
 * Fetching it only on demand left a hole, though — a browser without WebCodecs
 * video encode that goes offline before its first conversion has no engine at
 * all, and offline is the case this app exists for. So the cost is paid up
 * front, but only by the browsers that will actually spend it.
 *
 * Failure is silent by design: the on-demand load still works while online,
 * and a warm-up that could not finish is not something to interrupt anyone
 * about.
 */
export async function warmFfmpegFallback(): Promise<void> {
  try {
    // Data Saver means the user asked to minimize background traffic, and
    // 32 MB is exactly the kind of traffic they meant.
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    // Without a controlling worker the fetches below would fill the HTTP cache
    // instead of the one the app reads offline, which is no guarantee at all.
    // Skipping is fine: this runs again on the next launch.
    const registration = await navigator.serviceWorker?.ready;
    if (!registration || !navigator.serviceWorker.controller) return;

    const { canEncodeAvc } = await import('./capabilities');
    if (await canEncodeAvc()) return;

    await Promise.all([FFMPEG_CORE_URL, FFMPEG_WASM_URL].map(drain));
  } catch {
    // Offline already, cache full, fetch rejected — all of it is survivable.
  }
}
