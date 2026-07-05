import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ThemeToggle from './ThemeToggle.tsx'
import UpdatePrompt from './UpdatePrompt.tsx'
import InstallPrompt from './InstallPrompt.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InstallPrompt />
    <ThemeToggle />
    <App />
    <UpdatePrompt />
  </StrictMode>,
)
