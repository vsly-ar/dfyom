import { defineConfig } from 'vitest/config'

// Spike S8 (docs/research/2026-11-25-spike-s8-patterns.md): pattern-sized pockets through the real
// design, evaluation, plan and export, outside `npm run check`. A named shape holds at most
// SHAPE_ITEMS_MAX (1 000) items; the spike lifts it to 10 000 at load time so 2 000+ cells can go
// through the same commands (a pattern item would not be bound by it).
export default defineConfig({
  plugins: [
    {
      name: 's8-shape-items-max',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('src/core/design/shape.dto.ts'))
          return code.replace('SHAPE_ITEMS_MAX = 1000', 'SHAPE_ITEMS_MAX = 10_000')
        return undefined
      },
    },
  ],
  test: {
    include: ['spikes/patterns/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
})
