import { defineConfig } from 'vitest/config'

// Performance budgets, outside `npm run check` (timings are flaky in CI): docs/conventions/testing.md
export default defineConfig({
  test: {
    include: ['src/**/*.perf.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
})
