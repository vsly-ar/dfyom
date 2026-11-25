import { defineConfig } from 'vitest/config'

// Spike E0 (docs/research/2026-11-25-engraved-patterns-and-lines.md#spike-e0): SVG strokes to
// depth-profiled lines and one variable-depth gCode program, outside `npm run check`.
export default defineConfig({
  test: {
    include: ['spikes/engrave/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
})
