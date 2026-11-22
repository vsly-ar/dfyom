import { defineConfig } from 'vitest/config'

// Spike S3 (spikes/prisms/results.md): correctness tests and the cost table, outside `npm run check`.
export default defineConfig({
  test: {
    include: ['spikes/prisms/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
})
