import { defineConfig } from 'vitest/config'

// Performance budgets, outside `npm run check` (timings are flaky in CI): docs/conventions/testing.md
export default defineConfig({
  test: {
    include: ['src/**/*.perf.ts'],
    environment: 'node',
    // bundles the test worker entry for the real worker_threads tests (docs/architecture/workers.md#testing)
    globalSetup: ['src/main/workers/global-setup.ts'],
    testTimeout: 300_000,
  },
})
