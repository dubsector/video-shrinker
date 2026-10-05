import { clientsClaim } from 'workbox-core'
import { type PrecacheEntry, cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | PrecacheEntry>
}

cleanupOutdatedCaches()
// The share handoff below redirects to /?share-target=1, and Workbox appends
// its directory index to the *unstripped* URL when looking for a precache
// match — so without listing the parameter here it searches for
// `index.html?share-target=1`, misses, and falls through to the network.
// That breaks every shared video while offline, which is exactly when this
// app is most useful.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^share-target$/],
})

// registerType is 'prompt', so this worker only activates once the user
// clicks "Reload to update" (see src/UpdatePrompt.tsx), which posts
// SKIP_WAITING below. clientsClaim() then hands control of already-open
// tabs to this worker immediately on activation, firing the
// `controllerchange` event that useRegisterSW() waits on to reload the
// page — without it, skipWaiting() alone activates the new worker but
// never hands off the open tab, so the reload never happens.
clientsClaim()

// Shared files used to be relayed through Cache Storage; a large video may
// still be sitting in that cache from an old version, so drop it.
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(caches.delete('share-target'))
})

const shareReadyResolvers: Array<(client: Client) => void> = []

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
  if (event.data === 'share-ready' && event.source) {
    const client = event.source as Client
    for (const resolve of shareReadyResolvers.splice(0)) resolve(client)
  }
})

registerRoute(
  ({ url }) => /\/ffmpeg-core\/ffmpeg-core\.(js|wasm)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'ffmpeg-core',
    plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
)

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return

  // Chrome aborts navigations the service worker takes too long to answer,
  // and parsing a large video's multipart body (plus the old Cache Storage
  // write) can exceed that budget. Respond with the redirect immediately,
  // then hand the file to the page once it signals it is listening.
  const formDataPromise = event.request.formData()
  const referrer = event.request.referrer
  event.respondWith(Response.redirect(`${url.origin}/video-shrinker/?share-target=1`, 303))
  event.waitUntil(
    (async () => {
      const client = await new Promise<Client>((resolve) => shareReadyResolvers.push(resolve))
      // Ack right away so the page can tell "worker is streaming the body"
      // (slow is normal — the sharing app may be pulling the file from the
      // cloud) apart from "handshake never happened" (fail fast).
      client.postMessage({ type: 'SHARE_TARGET_RECEIVING' })
      try {
        const formData = await formDataPromise
        const file = formData.get('video')
        if (file instanceof File) {
          client.postMessage({ type: 'SHARE_TARGET_FILE', file })
        } else {
          client.postMessage({
            type: 'SHARE_TARGET_ERROR',
            message: `No video found in the shared data. ${describeShare(formData, referrer)}`,
          })
        }
      } catch (err) {
        client.postMessage({
          type: 'SHARE_TARGET_ERROR',
          message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        })
      }
    })(),
  )
})

// Says what the browser actually sent and which app opened it, so a
// screenshot of a failed share shows where the video went missing. The
// Android app's relay copies the video to a local file before the browser
// sees it (referrer android-app://<package>/), while a home-screen install
// of the site hands the sender's file straight to the browser, which drops
// it silently when it can't read it, e.g. a Google Photos item that is only
// in the cloud.
function describeShare(formData: FormData, referrer: string): string {
  const fields = [...formData.entries()].map(([name, value]) =>
    value instanceof File ? `${name}: ${value.type || 'untyped'} file, ${value.size} bytes` : `${name}: text`,
  )
  const from = referrer.startsWith('android-app://') ? new URL(referrer).host : 'browser'
  return `[received ${fields.length ? fields.join('; ') : 'nothing'}; from ${from}]`
}
