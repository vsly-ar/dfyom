import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Process model and source layout: docs/architecture/overview.md
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
