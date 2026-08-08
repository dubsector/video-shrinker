import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n.ts'
import App from './App.tsx'
import ThemeToggle from './ThemeToggle.tsx'
import LanguagePicker from './LanguagePicker.tsx'
import UpdatePrompt from './UpdatePrompt.tsx'
import InstallPrompt from './InstallPrompt.tsx'
import { warmFfmpegFallback } from './lib/warmFallback.ts'

// Idle time only: on a browser that needs the CPU fallback this fetches 32 MB,
// which has no business competing with startup.
const warmWhenIdle = () => void warmFfmpegFallback()
if ('requestIdleCallback' in window) {
  requestIdleCallback(warmWhenIdle, { timeout: 10_000 })
} else {
  setTimeout(warmWhenIdle, 5_000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <InstallPrompt />
      <LanguagePicker />
      <ThemeToggle />
      <App />
      <UpdatePrompt />
    </Suspense>
  </StrictMode>,
)
