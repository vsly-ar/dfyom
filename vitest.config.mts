import { defineConfig } from 'vitest/config'

// Testing strategy: docs/conventions/testing.md
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
})
