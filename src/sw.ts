import { type PrecacheEntry, cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | PrecacheEntry>
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

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

  event.respondWith(
    (async () => {
      const formData = await event.request.formData()
      const file = formData.get('video') as File | null
      if (file) {
        const cache = await caches.open('share-target')
        await cache.put(
          '/share-target-file',
          new Response(file, {
            headers: {
              'Content-Type': file.type,
              'X-File-Name': encodeURIComponent(file.name),
            },
          }),
        )
      }
      return Response.redirect(`${url.origin}/video-shrinker/?share-target=1`, 303)
    })(),
  )
})
