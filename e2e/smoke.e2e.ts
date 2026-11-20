// Smoke tests (task 0.9): the built app starts, renders its first window without errors, runs
// the bundled compute worker, and quits. Selectors rely only on the window title, `#root` and the
// preload bridge (`window.dfyom`), so they survive UI rewrites.
// Doc: docs/conventions/testing.md#end-to-end
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { len } from '../src/core/library/library.fixture'
import { expect, test } from './app.fixture'

test('app opens its window, renders without console errors and quits', async ({ dfyom }) => {
  const { app, dataDir, rendererErrors } = dfyom
  const page = await app.firstWindow()

  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveTitle('DFYOM')
  await expect(page.locator('#root > *').first()).toBeAttached()
  // Main-process view: the window was shown (ready-to-show fired).
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true)
  expect(rendererErrors).toEqual([])

  // Isolation: Electron's userData and the logs are in the temp data dir, not the developer's.
  expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(dataDir)
  expect(await readdir(join(dataDir, 'logs'))).not.toHaveLength(0)
})

test('the bundled geometry worker evaluates a part', async ({ dfyom }) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The window's bridge, as the UI calls it (docs/architecture/llm-api.md).
  const call = async <T>(name: string, args: object = {}): Promise<T> => {
    // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
    const r = await page.evaluate(
      ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
      [name, args] as const,
    )
    expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
    return (r as Extract<CallReply, { ok: true }>).value as T
  }

  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Smoke block',
      shape: 'block',
      length: len('100'),
      width: len('60'),
      thickness: len('20'),
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await call('project.create', { name: 'Smoke', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Smoke',
    stockLibraryItemId: stock.id,
  })
  await call('design.pocket.add', {
    partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '25' },
    depth: '8',
  })
  const { jobId } = await call<{ jobId: string }>('design.part.evaluate', { partId })
  const job = await call<{ state: string; outcome?: unknown }>('job.wait', {
    jobId,
    timeoutSeconds: 30,
  })
  expect(job).toMatchObject({
    state: 'finished',
    outcome: { ok: true, value: { evaluation: 'done' } },
  })
  expect(dfyom.rendererErrors).toEqual([])
})
