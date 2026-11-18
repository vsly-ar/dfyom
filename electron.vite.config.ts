import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Process model and source layout: docs/architecture/overview.md
export default defineConfig({
  main: {
    // `dependencies` (pino, pino-roll) are externalized by default; pino-pretty is a dev
    // dependency loaded only in unpackaged runs, so keep it out of the bundle too.
    // Logging: docs/conventions/logging.md#development
    build: {
      externalizeDeps: { include: ['pino-pretty'] },
      // Two entries: the Electron main process and the headless CLI/MCP entry (no Electron
      // import; run with ELECTRON_RUN_AS_NODE when packaged). docs/architecture/llm-api.md#processes-and-hosting
      rolldownOptions: {
        input: { index: 'src/main/index.ts', cli: 'src/main/cli/index.ts' },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
