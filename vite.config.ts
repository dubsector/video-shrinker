import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'

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

const buildDate = new Date()

// https://vite.dev/config/
export default defineConfig({
  base: '/video-shrinker/',
  define: {
    __BUILD_INFO__: JSON.stringify({ date: buildDate.toISOString(), commit: getCommitHash() }),
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
      // 'prompt' here only means the plugin never force-reloads on its own.
      // src/UpdatePrompt.tsx decides what actually happens: updates apply
      // automatically while the app is idle, and only fall back to a prompt
      // when a reload would kill a conversion or an undownloaded result.
      injectRegister: null,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Video Shrinker',
        short_name: 'Video Shrinker',
        description: 'Shrink video to a target file size, entirely in your browser. No uploads, no third-party APIs.',
        // Explicit, permanent app identity. Set to the existing implicit id
        // (the resolved start_url) so already-installed PWAs are unaffected.
        // Never change this value once shipped.
        id: '/video-shrinker/',
        categories: ['utilities', 'photo', 'productivity'],
        theme_color: '#5865F2',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        screenshots: [
          {
            src: 'screenshot-wide.png',
            sizes: '1280x800',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Video Shrinker on the desktop',
          },
          {
            src: 'screenshot-narrow.png',
            sizes: '448x998',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Video Shrinker on mobile',
          },
        ],
        share_target: {
          action: '/video-shrinker/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            files: [
              {
                name: 'video',
                accept: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/3gpp'],
              },
            ],
          },
        },
      },
    }),
  ],
})
