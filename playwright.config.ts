import { defineConfig } from '@playwright/test'

// End-to-end tests of the built Electron app: docs/conventions/testing.md#end-to-end
// `npm run e2e` builds first (electron-vite → out/); no browsers are downloaded, Electron is the target.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: 'node_modules/.cache/playwright',
  workers: 1,
  timeout: 60_000,
  // Web-first assertions wait on UI state that follows main-process work (library and project
  // writes, evaluations). Under a loaded machine (load ≥ 70, e.g. `npm run check` beside the suite)
  // a step that takes ≈ 0.2 s idle was measured to need over 5 s (P3, "Add tool" dialog still busy),
  // so the default 5 s budget became a flake source. Waits stay on state, never on time
  // (docs/conventions/testing.md#load-stable-tests).
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env['CI'],
  // CI also writes the HTML report (playwright-report/), uploaded with the traces when the job fails.
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
})
