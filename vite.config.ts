import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * GitHub Pages has no SPA rewrite: `/perfboarding/single-board` is a static
 * miss, and Pages answers a miss with `404.html`. Shipping the built page under
 * that name as well makes the app itself answer, and it then reads the slug off
 * `location.pathname`. Asset URLs are absolute (see `base`), so the copy works
 * whatever depth the URL was. Vite's dev server already falls back to
 * index.html, so this is build-only.
 */
function pagesSpaFallback() {
  return {
    name: 'pages-spa-fallback',
    apply: 'build' as const,
    closeBundle() {
      const dist = resolve(import.meta.dirname, 'dist')
      copyFileSync(resolve(dist, 'index.html'), resolve(dist, '404.html'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pagesSpaFallback()],
  // Served from https://joao-delgado.github.io/perfboarding/ (a project page,
  // not a user/org page or custom domain), so asset URLs need this prefix.
  base: '/perfboarding/',
})
