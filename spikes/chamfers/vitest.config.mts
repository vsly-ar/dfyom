import { defineConfig } from 'vitest/config'

// Spike S7 (docs/research/2026-11-25-spike-s7-edge-chamfers.md): correctness and cost, outside
// `npm run check`.
export default defineConfig({
  test: {
    include: ['spikes/chamfers/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
})
