import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n.ts'
import App from './App.tsx'
import ThemeToggle from './ThemeToggle.tsx'
import LanguagePicker from './LanguagePicker.tsx'
import UpdatePrompt from './UpdatePrompt.tsx'
import InstallPrompt from './InstallPrompt.tsx'

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
