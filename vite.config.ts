import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

function getCommitHash(): string {
  // GitHub Actions checks out a detached HEAD, so prefer its own env var
  // (full SHA) when present; fall back to git locally.
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/video-shrinker/',
  define: {
    __BUILD_INFO__: JSON.stringify({ date: new Date().toISOString(), commit: getCommitHash() }),
  },
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
      registerType: 'prompt',
      // Registration is done manually via the useRegisterSW() hook
      // (src/UpdatePrompt.tsx) so updates can be applied on the user's
      // schedule instead of forcing a reload that could interrupt an
      // in-progress conversion.
      injectRegister: null,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Video Shrinker',
        short_name: 'Video Shrinker',
        description: 'Shrink video to a target file size, entirely in your browser. No uploads, no third-party APIs.',
        // @ts-expect-error - `version` is a valid manifest field (used for OS app-listing
        // metadata) but vite-plugin-pwa's types haven't caught up to the spec yet.
        version: pkg.version,
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
