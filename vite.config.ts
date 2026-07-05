import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/video-shrinker/',
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.*',
          dest: 'ffmpeg-core',
        },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Video Shrinker',
        short_name: 'Vid Shrinker',
        description: 'Shrink video to a target file size, entirely in your browser. No uploads, no third-party APIs.',
        theme_color: '#5865F2',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The ffmpeg.wasm binary (~32MB) is only needed by the rare CPU
        // fallback path, so it's cached at runtime on first use (below)
        // rather than bloating the initial install with a large precache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: /\/ffmpeg-core\/ffmpeg-core\.(js|wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ffmpeg-core',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
})
