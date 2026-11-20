import { defineConfig } from '@playwright/test'

// End-to-end tests of the built Electron app: docs/conventions/testing.md#end-to-end
// `npm run e2e` builds first (electron-vite → out/); no browsers are downloaded, Electron is the target.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: 'node_modules/.cache/playwright',
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
})
