import { defineConfig } from 'vitest/config'

// Testing strategy: docs/conventions/testing.md. Two projects: `node` for everything headless,
// `ui` (jsdom, Testing Library, axe-core) for renderer component tests (docs/conventions/ui.md#testing).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
          environment: 'node',
          // bundles the test worker entry for the real worker_threads tests (docs/architecture/workers.md#testing)
          globalSetup: ['src/main/workers/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          include: ['src/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/src/test/setup.ts'],
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
    ],
  },
})
