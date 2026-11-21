// Smoke tests (task 0.9): the built app starts, renders its first window without errors, runs
// the bundled compute worker, and quits. With the UI shell (3.3b): the three modes switch, the
// theme setting applies and persists, and closing an edited project's last window asks first.
// Quitting with unsaved changes asks once for every project (Cancel, Quit without saving, Save all).
// UI selectors are roles and accessible names (docs/conventions/ui.md#testing).
// Doc: docs/conventions/testing.md#end-to-end
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { len } from '../src/core/library/library.fixture'
import { answerMessageBoxes, askedMessageBoxes, expect, test } from './app.fixture'
import type { Page } from '@playwright/test'

/** One call through the window's bridge, as the UI makes it (docs/architecture/llm-api.md). */
async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/** A project with a part: unsaved changes. */
async function editedProject(page: Page, name: string): Promise<{ partId: string }> {
  const stock = await bridgeCall<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: `${name} block`,
      shape: 'block',
      length: len('100'),
      width: len('60'),
      thickness: len('20'),
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  await bridgeCall(page, 'project.create', { name, unitSystem: 'mm' })
  return bridgeCall<{ partId: string }>(page, 'design.part.add', {
    name,
    stockLibraryItemId: stock.id,
  })
}

test('app opens its window, renders without console errors and quits', async ({ dfyom }) => {
  const { app, dataDir, rendererErrors } = dfyom
  const page = await app.firstWindow()

  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveTitle('DFYOM')
  await expect(page.locator('#root > *').first()).toBeAttached()
  // Main-process view: the window finished loading; it stays hidden in tests unless DFYOM_E2E_SHOW=1.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.isLoading(),
      ),
    )
    .toBe(false)
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
  ).toBe(process.env['DFYOM_E2E_SHOW'] === '1')
  expect(rendererErrors).toEqual([])

  // Isolation: Electron's userData and the logs are in the temp data dir, not the developer's.
  expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(dataDir)
  expect(await readdir(join(dataDir, 'logs'))).not.toHaveLength(0)
})

test('the bundled geometry worker evaluates a part', async ({ dfyom }) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)

  const { partId } = await editedProject(page, 'Smoke')
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

test('the shell switches the three modes and applies the theme setting', async ({ dfyom }) => {
  const page = await dfyom.app.firstWindow()
  const mode = (name: string) => page.getByRole('radio', { name })
  await expect(mode('Design')).toBeChecked()
  await expect(page.getByRole('main', { name: 'Viewport' })).toBeVisible()

  await mode('Plan').click()
  await expect(mode('Plan')).toBeChecked()
  await expect(page.getByRole('heading', { name: 'Plan', level: 2 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+3')
  await expect(mode('Run')).toBeChecked()
  await expect(page.getByRole('heading', { name: 'Run', level: 2 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+1')
  await expect(mode('Design')).toBeChecked()

  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // the tokens follow: Jet background
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(39, 45, 45)')
  await settings.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 248, 255)')
  // kept in app data for the next start
  await expect
    .poll(async () => {
      const text = await readFile(join(dfyom.dataDir, 'settings.json'), 'utf8').catch(() => '{}')
      return (JSON.parse(text) as { theme?: string }).theme
    })
    .toBe('light')
  expect(dfyom.rendererErrors).toEqual([])
})

test('closing the last window of an edited project asks first', async ({ dfyom }) => {
  const page = await dfyom.app.firstWindow()
  await editedProject(page, 'Bracket')
  // the replica follows the project: title with the edit state
  await expect(page).toHaveTitle('Bracket — Edited')
  const closeWindow = () =>
    dfyom.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())

  await closeWindow()
  const dialog = page.getByRole('alertdialog', { name: 'Close “Bracket” with unsaved changes?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(
    await dfyom.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1)

  await closeWindow()
  await expect(dialog).toBeVisible()
  await Promise.all([
    page.waitForEvent('close'),
    dialog.getByRole('button', { name: 'Close without saving' }).click(),
  ])
  expect(dfyom.rendererErrors).toEqual([])
})

test('quitting with an edited project asks first: Cancel keeps it, Quit without saving quits', async ({
  dfyom,
}) => {
  const { app } = dfyom
  const page = await app.firstWindow()
  await editedProject(page, 'Bracket')
  await expect(page).toHaveTitle('Bracket — Edited')
  const quit = () => app.evaluate(({ app: a }) => a.quit())

  await answerMessageBoxes(app, 'Cancel')
  await quit()
  await expect.poll(() => askedMessageBoxes(app)).toHaveLength(1)
  expect((await askedMessageBoxes(app))[0]).toMatchObject({
    message: 'Quit with unsaved changes in “Bracket”?',
    buttons: ['Save all', 'Quit without saving', 'Cancel'],
  })
  // still running, project still open and edited; closing the window still asks (not "quitting")
  await expect(page).toHaveTitle('Bracket — Edited')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  const closeDialog = page.getByRole('alertdialog', {
    name: 'Close “Bracket” with unsaved changes?',
  })
  await expect(closeDialog).toBeVisible()
  await closeDialog.getByRole('button', { name: 'Cancel' }).click()

  await answerMessageBoxes(app, 'Quit without saving')
  // the app may exit before the evaluate returns
  await Promise.all([app.waitForEvent('close'), quit().catch(() => undefined)])
  expect(dfyom.rendererErrors).toEqual([])
})

test('quitting with Save all saves an untitled project through the save dialog', async ({
  dfyom,
}) => {
  const { app, dataDir } = dfyom
  const page = await app.firstWindow()
  await editedProject(page, 'Lid')
  await expect(page).toHaveTitle('Lid — Edited')
  const file = join(dataDir, 'Lid.dfyom')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
  }, file)

  await answerMessageBoxes(app, 'Save all')
  await Promise.all([
    app.waitForEvent('close'),
    app.evaluate(({ app: a }) => a.quit()).catch(() => undefined),
  ])
  expect((await stat(file)).size).toBeGreaterThan(0)
  expect(dfyom.rendererErrors).toEqual([])
})

test('New / Open with a project open use a new window; an open file is not opened twice', async ({
  dfyom,
}) => {
  const { app, dataDir } = dfyom
  const page = await app.firstWindow()
  const windowCount = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const fileA = join(dataDir, 'A.dfyom')
  await bridgeCall(page, 'project.create', { name: 'A', unitSystem: 'mm' })
  await bridgeCall(page, 'project.save', { target: fileA })
  await expect(page).toHaveTitle('A')

  // New (shortcut) in a window with a project: no question, a new window with the new project
  await page.keyboard.press('ControlOrMeta+n')
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('B')
  const [pageB] = await Promise.all([
    app.waitForEvent('window'),
    dialog.getByRole('button', { name: 'Create project' }).click(),
  ])
  await expect(pageB).toHaveTitle('B')
  await expect(page).toHaveTitle('A')
  expect(await windowCount()).toBe(2)
  // cascaded from the asking window with its size; still hidden in tests
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .sort((a, b) => a.id - b.id)
      .map((w) => ({ ...w.getBounds(), visible: w.isVisible() })),
  )
  const first = bounds[0]
  expect(first).toBeDefined()
  expect(bounds[1]).toEqual({
    x: (first?.x ?? 0) + 22,
    y: (first?.y ?? 0) + 22,
    width: first?.width,
    height: first?.height,
    visible: false,
  })

  // Open (shortcut) of the file this window shows: nothing new opens
  await app.evaluate(({ dialog: d }, path) => {
    d.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [path] })) as typeof d.showOpenDialog
  }, fileA)
  await page.keyboard.press('ControlOrMeta+o')
  // from the other window: A's window comes to the front instead of a duplicate
  const reply = await pageB.evaluate(
    (file) =>
      (globalThis as unknown as { dfyom: PreloadApi }).dfyom.window.openProject('project.open', {
        file,
      }),
    fileA,
  )
  expect(reply).toMatchObject({ ok: true, value: { window: 'other', alreadyOpen: true } })
  expect(await windowCount()).toBe(2)
  // a refused open closes its new window unseen; the asking window gets the error
  const refused = await pageB.evaluate(
    (file) =>
      (globalThis as unknown as { dfyom: PreloadApi }).dfyom.window.openProject('project.open', {
        file,
      }),
    join(dataDir, 'missing.dfyom'),
  )
  expect(refused.ok).toBe(false)
  await expect.poll(windowCount).toBe(2)
  await expect(pageB).toHaveTitle('B')
  await expect(page).toHaveTitle('A')
  expect(dfyom.rendererErrors).toEqual([])
})
