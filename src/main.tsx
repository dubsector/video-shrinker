import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ThemeToggle from './ThemeToggle.tsx'
import UpdatePrompt from './UpdatePrompt.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeToggle />
    <App />
    <UpdatePrompt />
  </StrictMode>,
)
