import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Spike S4 (docs/research/s4-offset-clearing.md): runs against S1's WASM build and S1's npm
// dependencies (spikes/2d/node_modules), outside `npm run check`.
export default defineConfig({
  resolve: {
    alias: { 'clipper2-ts': join(import.meta.dirname, '..', '2d', 'node_modules', 'clipper2-ts') },
  },
  test: {
    include: ['spikes/clearing/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
})
