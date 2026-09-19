import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import * as store from './model/store'
import App from './ui/App.tsx'

declare global {
  interface Window {
    /** Dev-only hook, so the app can be driven and inspected over CDP. */
    __perf?: typeof store
  }
}

if (import.meta.env.DEV) window.__perf = store

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
