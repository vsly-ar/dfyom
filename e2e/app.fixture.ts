// Launches the built app (out/main/index.js) isolated from the developer's app data.
// Doc: docs/conventions/testing.md#end-to-end
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

export interface AppFixture {
  readonly app: ElectronApplication
  /** The temp `--data-dir`: app data, Chromium profile and logs (docs/architecture/persistence.md#files-and-folders). */
  readonly dataDir: string
  /** Console errors and uncaught exceptions of every window, collected from creation on. */
  readonly rendererErrors: readonly string[]
}

/**
 * Launches the built app on `dataDir` and collects its windows' console errors. The fixture uses
 * it; a test may launch again on the same data dir to close and reopen the app.
 */
export async function launchApp(
  dataDir: string,
): Promise<{ app: ElectronApplication; rendererErrors: string[] }> {
  // Without ELECTRON_RENDERER_URL the app loads the built renderer, not a dev server.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== 'ELECTRON_RENDERER_URL' && e[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  const app = await electron.launch({ args: ['out/main/index.js', `--data-dir=${dataDir}`], env })
  const rendererErrors: string[] = []
  const watched = new WeakSet<Page>()
  const watch = (page: Page) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('console', (m) => {
      if (m.type() === 'error') rendererErrors.push(`${page.url()}: ${m.text()}`)
    })
    page.on('pageerror', (e) => rendererErrors.push(`${page.url()}: ${e.message}`))
  }
  app.on('window', watch)
  app.windows().forEach(watch)
  return { app, rendererErrors }
}

export const test = base.extend<{ dfyom: AppFixture }>({
  // Playwright requires the destructuring pattern for fixture dependencies, even when empty.
  // eslint-disable-next-line no-empty-pattern
  dfyom: async ({}, use) => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dfyom-e2e-')))
    const { app, rendererErrors } = await launchApp(dataDir)
    try {
      await use({ app, dataDir, rendererErrors })
    } finally {
      await app.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  },
})

export { expect } from '@playwright/test'
