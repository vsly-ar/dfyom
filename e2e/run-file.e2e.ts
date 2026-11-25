// Run an external gCode file in the real app (hardening DF93): with no project, a Fusion-style
// fixture opened through the bridge (`run.openFile(path)`, no native dialog) loads into Run mode:
// its card, the preview in the 3D view and its lines in the gCode panel; then the virtual machine
// connects, homes, the work zero is set where the file fits, the pre-flight checks the soft
// limits and the file runs through both tool changes to the end. Windows stay hidden (fixture).
// Docs: docs/modes/run.md#run-an-external-g-code-file-df93, docs/conventions/testing.md#end-to-end
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi, RunFileOpened } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

type Dfyom = { dfyom: PreloadApi }

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(([n, a]) => (globalThis as unknown as Dfyom).dfyom.call(n, a), [
    name,
    args,
  ] as const)
}

const FIXTURE = resolve(__dirname, '../src/core/run/__fixtures__/fusion-grbl.nc')

test('Run a gCode file without a project: open → preview and lines → pre-flight → run on the virtual machine (DF93)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const added = await call(page, 'library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '600', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
      homingCorner: 'backRight',
      pullOff: '1',
      softLimits: true,
    },
  })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await expect(navigator.getByRole('heading', { name: 'No project open' })).toBeVisible()

  // the window has no project: it shows the file itself, in Run mode
  const opened = await page.evaluate(
    (path) => (globalThis as unknown as Dfyom).dfyom.run.openFile(path),
    FIXTURE,
  )
  expect(opened).toEqual({ path: FIXTURE, window: 'this' } satisfies RunFileOpened)
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByText('File fusion-grbl.nc')).toBeVisible()
  await expect(inspector.getByText('1: D=6 CR=0 - ZMIN=-3 - flat end mill')).toBeVisible()
  await expect(inspector.getByText('2: D=3.175 CR=0 - ZMIN=-2 - flat end mill')).toBeVisible()
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible()
  // the gCode panel opens with the prepared lines: M6 became DFYOM's tool-change marker
  const panel = page.getByRole('region', { name: 'gCode' })
  const list = panel.getByRole('list', { name: 'Program lines' })
  await expect(list).toBeVisible()
  await expect(
    list.getByText('(DFYOM TOOL CHANGE 1: D=6 CR=0 - ZMIN=-3 - flat end mill)'),
  ).toBeVisible()

  // connect, home, put the work zero where the file fits the travel
  const machine = page.getByRole('group', { name: 'Machine' })
  // a serial port is the default connection (DF101): choose the virtual machine
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  const jog = await call(page, 'run.machine.jog', { by: [-400, -300, -60], feed: 5000 })
  expect(jog.ok, JSON.stringify(jog)).toBe(true)
  const cell = (name: string) =>
    inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })
  await expect(cell('Machine position Z')).toHaveText('-61.000', { timeout: 30_000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  expect((await call(page, 'run.workZero.set', { axes: ['x', 'y', 'z'] })).ok).toBe(true)

  // the pre-flight checks the file at this work zero; the run waits at both tool changes
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Inside the travel at this work zero.')).toBeVisible()
  await preflight.getByRole('button', { name: 'Start run' }).click()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: \d+ lines in/)
  const seen: string[] = []
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 60_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    seen.push(title)
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  expect(seen).toEqual(['Tool change 1', 'Tool change 2'])
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  // still no project
  expect(await call(page, 'project.list')).toMatchObject({ ok: true, value: { projects: [] } })
  expect(dfyom.rendererErrors).toEqual([])
})

test('Run a gCode file from a window with a project: a new window without one shows it (DF93)', async ({
  dfyom,
}) => {
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const created = await call(page, 'project.create', { name: 'Bracket', unitSystem: 'mm' })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const next = dfyom.app.waitForEvent('window')
  const opened = await page.evaluate(
    (path) => (globalThis as unknown as Dfyom).dfyom.run.openFile(path),
    FIXTURE,
  )
  expect(opened).toEqual({ path: FIXTURE, window: 'new' } satisfies RunFileOpened)
  const win = await next
  await win.waitForLoadState('domcontentloaded')
  await expect(win.getByRole('radio', { name: 'Run' })).toBeChecked()
  const inspector = win.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await win.getByRole('button', { name: 'Inspector' }).click()
  await expect(inspector.getByText('File fusion-grbl.nc')).toBeVisible()
  // the project's window keeps its project and shows no file
  expect(await call(page, 'project.list')).toMatchObject({
    ok: true,
    value: { projects: [{ name: 'Bracket' }] },
  })
  await expect(page.getByText('File fusion-grbl.nc')).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
