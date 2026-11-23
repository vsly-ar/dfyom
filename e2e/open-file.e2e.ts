// Opening `.dfyom` files from Finder (hardening U5), windows hidden: a file in the first launch's
// arguments opens in the first window; a second launch on the same data folder hands its file to
// the running app and quits, a bare second launch just quits; macOS `open-file` takes the same
// path (a window with a project puts the file into a new window, an open file is not opened
// twice).
// Doc: docs/conventions/ui.md#project-files, docs/conventions/testing.md#app-playwright-for-electron
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'node:path'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, launchEnv, test } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/** A saved project file, closed again (the window is left without a project). */
async function projectFile(page: Page, dir: string, name: string): Promise<string> {
  const file = join(dir, `${name}.dfyom`)
  await bridgeCall(page, 'project.create', { name, unitSystem: 'mm' })
  await bridgeCall(page, 'project.save', { target: file })
  await bridgeCall(page, 'project.close', {})
  await expect(page).toHaveTitle('DFYOM')
  return file
}

/** The built app started again on `dataDir` as a plain process; resolves with its exit code. */
function secondLaunch(dataDir: string, args: readonly string[]): Promise<number | null> {
  const packaged = process.env['DFYOM_E2E_APP']
  const electron =
    packaged ??
    (createRequire(join(process.cwd(), 'package.json'))('electron') as unknown as string)
  const argv = [...(packaged ? [] : ['out/main/index.js']), `--data-dir=${dataDir}`, ...args]
  const child = spawn(electron, argv, { env: launchEnv(), stdio: 'ignore' })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

/** Each window's document title (the project name, or DFYOM), oldest window first. */
const titles = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .sort((a, b) => a.id - b.id)
      .map((w) => w.webContents.getTitle()),
  )

test('a file in the launch arguments opens in the first window', async ({ dfyom }) => {
  const page = await dfyom.app.firstWindow()
  const file = await projectFile(page, dfyom.dataDir, 'Bracket')
  await dfyom.app.close()

  const again = await launchApp(dfyom.dataDir, [file])
  try {
    const first = await again.app.firstWindow()
    await expect(first).toHaveTitle('Bracket')
    expect(await titles(again.app)).toHaveLength(1)
    expect(again.rendererErrors).toEqual([])
  } finally {
    await again.app.close()
  }
})

test('a second launch hands its file to the running app and quits; open-file takes the same path', async ({
  dfyom,
}) => {
  const { app, dataDir } = dfyom
  const page = await app.firstWindow()
  const fileA = await projectFile(page, dataDir, 'Alpha')
  const fileB = await projectFile(page, dataDir, 'Beta')

  // a second launch on the same data folder: the empty window opens the file, the launch quits
  expect(await secondLaunch(dataDir, [fileA])).toBe(0)
  await expect(page).toHaveTitle('Alpha')
  expect(await titles(app)).toHaveLength(1)

  // without a file it only quits (the running app keeps its windows)
  expect(await secondLaunch(dataDir, [])).toBe(0)
  expect(await titles(app)).toHaveLength(1)

  // macOS open-file while a window has a project: File → Open's window choice, a new window
  const [pageB] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ app: electronApp }, f) => {
      electronApp.emit('open-file', { preventDefault: () => {} }, f)
    }, fileB),
  ])
  await expect(pageB).toHaveTitle('Beta')
  // a file already open is not opened twice: Alpha's window (the oldest, nothing focused in a
  // hidden run) takes it and the next file one after the other, so once Gamma's window shows,
  // Alpha's open has answered without a window of its own
  const fileC = join(dataDir, 'Gamma.dfyom')
  await bridgeCall(pageB, 'project.create', { name: 'Gamma', unitSystem: 'mm' })
  await bridgeCall(pageB, 'project.save', { target: fileC })
  await bridgeCall(pageB, 'project.close', {})
  await expect(pageB).toHaveTitle('DFYOM')
  // Beta's window is empty now and is reused: open Beta there again first
  await app.evaluate(({ app: electronApp }, f) => {
    electronApp.emit('open-file', { preventDefault: () => {} }, f)
  }, fileB)
  await expect(pageB).toHaveTitle('Beta')
  const [pageC] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(
      ({ app: electronApp }, files) => {
        for (const f of files) electronApp.emit('open-file', { preventDefault: () => {} }, f)
      },
      [fileA, fileC],
    ),
  ])
  await expect(pageC).toHaveTitle('Gamma')
  expect(await titles(app)).toEqual(['Alpha', 'Beta', 'Gamma'])
  expect(dfyom.rendererErrors).toEqual([])
})
