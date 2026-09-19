import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Served from https://joao-delgado.github.io/perfboarding/ (a project page,
  // not a user/org page or custom domain), so asset URLs need this prefix.
  base: '/perfboarding/',
})
