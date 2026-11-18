import { defineConfig } from 'vitest/config'

// Testing strategy: docs/conventions/testing.md
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    environment: 'node',
    // bundles the test worker entry for the real worker_threads tests (docs/architecture/workers.md#testing)
    globalSetup: ['src/main/workers/global-setup.ts'],
  },
})
