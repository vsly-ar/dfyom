import { defineConfig } from 'vitest/config'

// Testing strategy: docs/conventions/testing.md. Two projects: `node` for everything headless,
// `ui` (jsdom, Testing Library, axe-core) for renderer component tests (docs/conventions/ui.md#testing).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          // spikes/biarc: spike S5's fitting checks (docs/research/s5-biarc-fitting.md)
          include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'spikes/biarc/*.test.ts'],
          environment: 'node',
          // bundles the test worker entry for the real worker_threads tests (docs/architecture/workers.md#testing)
          globalSetup: ['src/main/workers/global-setup.ts'],
          // Not Vitest's 5 s: on a loaded, swapping machine (load 100–300, 13 GB swap in use) every
          // worker froze for ≈ 5 s at once, and a 40 ms test failed at 5.5 s. 15 s rides out such a
          // stall and still ends a hang quickly; heavy tests keep their own 60 s
          // (docs/conventions/testing.md#load-stable-tests).
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'ui',
          include: ['src/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/src/test/setup.ts'],
          // UI tests are multi-step flows through the whole app in jsdom: 1–2 s each when idle, 5–12 s
          // under heavy load. One budget for the project instead of per-test numbers
          // (docs/conventions/testing.md#commands, Timeouts).
          testTimeout: 30_000,
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
    ],
  },
})
