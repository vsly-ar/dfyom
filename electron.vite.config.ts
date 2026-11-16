import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Process model and source layout: docs/architecture/overview.md
export default defineConfig({
  main: {
    // `dependencies` (pino, pino-roll) are externalized by default; pino-pretty is a dev
    // dependency loaded only in unpackaged runs, so keep it out of the bundle too.
    // Logging: docs/conventions/logging.md#development
    build: { externalizeDeps: { include: ['pino-pretty'] } },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
