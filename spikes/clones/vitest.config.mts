import { defineConfig } from 'vitest/config'

// Spike S6 (docs/research/s6-clone-budgets.md): clone instance budgets, outside `npm run check`.
export default defineConfig({
  test: {
    include: ['spikes/clones/*.test.ts'],
    environment: 'node',
    testTimeout: 1_800_000,
    fileParallelism: false,
  },
})
