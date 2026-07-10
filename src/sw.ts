import { clientsClaim } from 'workbox-core'
import { type PrecacheEntry, cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | PrecacheEntry>
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

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
  event.respondWith(Response.redirect(`${url.origin}/video-shrinker/?share-target=1`, 303))
  event.waitUntil(
    (async () => {
      const client = await new Promise<Client>((resolve) => shareReadyResolvers.push(resolve))
      try {
        const file = (await formDataPromise).get('video')
        if (file instanceof File) {
          client.postMessage({ type: 'SHARE_TARGET_FILE', file })
        } else {
          client.postMessage({ type: 'SHARE_TARGET_ERROR', message: 'No video found in the shared data.' })
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
