// The v0.1 exit criteria's UI flow (task 3.11), through the UI only: create a project with a
// rectangular stock; add facing, pocket (inside corner radius, floor fillet), drilling and profile
// with tabs; plan one setup (tools from the library, drill feeds entered by hand); generate the
// toolpaths and export GRBL gCode; run it on the virtual machine at max speed with progress shown,
// through every tool change and program pause; save, close the app, reopen it and open the project.
// The tool and machine library is app data from before the project (there is no library UI in
// v0.1): it is filled through the window's bridge first, like an agent would. The native file
// dialogs are stubbed in the main process. Selectors are roles and accessible names.
// Docs: docs/plans/v0.1.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import {
  deg,
  flatEndMillValues,
  len,
  machineValues,
  num,
} from '../src/core/library/library.fixture'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, test } from './app.fixture'

/** The OS dialogs answer `project` for the project file and `gcode` for the export. */
async function stubFileDialogs(
  app: ElectronApplication,
  files: { project: string; gcode: string },
): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    const pick = (args: unknown[]) => {
      const options = args.at(-1) as { title?: string } | undefined
      return options?.title === 'Export gCode' ? f.gcode : f.project
    }
    dialog.showSaveDialog = ((...args: unknown[]) =>
      Promise.resolve({ canceled: false, filePath: pick(args) })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [f.project] })) as typeof dialog.showOpenDialog
  }, files)
}

// The plan fixture's tools (src/core/plan/plan.fixture.ts imports Vitest, so not shared here)
const { kind: _tool, ...flat } = flatEndMillValues()
const flat6 = {
  ...flat,
  name: 'Flat 6',
  fluteLength: len('25'),
  overallLength: len('60'),
  toolMaterial: 'carbide',
}
const TOOLS = [
  flat6,
  { ...flat6, name: 'Flat 4', diameter: len('4'), presets: [] },
  { ...flat6, name: 'Bull 6', type: 'bullNoseEndMill', cornerRadius: len('2') },
  {
    name: 'Drill 6',
    type: 'drill',
    diameter: len('6'),
    fluteLength: len('30'),
    overallLength: len('66'),
    fluteCount: num('2'),
    pointAngle: deg('118'),
    presets: [],
  },
]

/** Fills the library (app data, no project needed) through the window's bridge. */
async function fillLibrary(page: Page): Promise<void> {
  const call = async (name: string, args: object) => {
    const r = await page.evaluate(
      ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
      [name, args] as const,
    )
    expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
    return (r as Extract<CallReply, { ok: true }>).value
  }
  for (const values of TOOLS) await call('library.tool.add', { values })
  const { kind: _, ...machine } = machineValues()
  await call('library.machine.add', { values: machine })
}

/** Types a value into a field and commits it (Enter = one command), then leaves the field. */
async function setField(scope: Locator, label: string, value: string): Promise<void> {
  // the input only: a group may share its label ("Depth")
  const field = scope.getByLabel(label, { exact: true }).and(scope.locator('input'))
  await field.fill(value)
  await field.press('Enter')
  // leave the field: its echo collapses on blur, which would move the next click's target
  await field.blur()
}

async function addFromMenu(page: Page, label: string): Promise<void> {
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await navigator.getByRole('button', { name: 'Add operation' }).click()
  await page.getByRole('menuitem', { name: label }).click()
}

const designRows = (page: Page) =>
  page
    .getByRole('list', { name: 'Operations in design order' })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

const planRows = (page: Page) =>
  page
    .getByRole('list', { name: 'Plan operations in machining order' })
    .getByRole('button', { name: /^(Facing|Pocket|Drilling|Profile) \d/ })

test('exit criteria through the UI: design, plan, export, run, save, close and reopen', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const files = {
    project: join(dfyom.dataDir, 'Bracket.dfyom'),
    gcode: join(dfyom.dataDir, 'Bracket.nc'),
  }
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await stubFileDialogs(dfyom.app, files)
  await fillLibrary(page)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const status = page.getByRole('contentinfo', { name: 'Status bar' })

  // ── Create a project with a rectangular stock ────────────────────────────────────────────
  await navigator.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Bracket')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveTitle('Bracket')
  const setup = navigator.getByRole('region', { name: 'Set up the part' })
  await setField(setup, 'Length (X)', '100')
  await setField(setup, 'Width (Y)', '60')
  await setField(setup, 'Thickness (Z)', '20')
  await setup.getByRole('button', { name: 'Create part' }).click()
  await expect(navigator.getByText(/^Stock: 100 × 60 × 20/)).toBeVisible()

  // ── Facing, pocket (corner radius, floor fillet), drilling, profile with tabs ────────────
  await navigator.getByRole('button', { name: 'Add facing' }).click()
  await expect(inspector.getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  await setField(inspector, 'Depth', '0.5')

  await addFromMenu(page, 'Add pocket')
  await expect(inspector.getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
  await setField(inspector, 'Depth', '6')
  await setField(inspector, 'Corner radius', '4')
  // the library's bull nose has RE 2 (plan-v0.1.md: a floor fillet needs a matching bull nose)
  await setField(inspector, 'Floor fillet radius', '2')
  await expect(inspector.getByLabel('Floor fillet radius', { exact: true })).toHaveValue('2')

  await addFromMenu(page, 'Add drilling')
  await expect(inspector.getByRole('heading', { name: 'Drilling 1' })).toBeVisible()
  await setField(inspector, 'Diameter', '6')

  await addFromMenu(page, 'Add profile')
  await expect(inspector.getByRole('heading', { name: 'Profile 1' })).toBeVisible()
  await setField(inspector, 'Tab count', '4')
  await setField(inspector, 'Tab thickness', '3')

  await expect(designRows(page)).toHaveCount(4)
  await expect(status.getByText('Part up to date')).toBeAttached({ timeout: 30_000 })
  await expect(page.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
    /Part with 4 operations/,
  )

  // ── Plan one setup ───────────────────────────────────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('radio', { name: 'Plan' })).toBeChecked()
  await navigator.getByRole('button', { name: 'Create plan' }).click()
  await expect(planRows(page)).toHaveText([
    /^Facing 1Flat 6/,
    /^Drilling 1/,
    /^Pocket 1Bull 6/,
    /^Profile 1Flat 6/,
  ])
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Shapeoko')

  // the drilling: the drill from the picker, and its feeds by hand (no preset, no calculator data)
  await planRows(page).nth(1).click()
  await expect(inspector.getByRole('heading', { name: 'Drilling 1' })).toBeVisible()
  await inspector.getByRole('combobox', { name: 'Tool' }).click()
  await page.getByRole('option', { name: /^Drill 6/ }).click()
  await expect(planRows(page).nth(1)).toHaveText(/^Drilling 1Drill 6/)
  await setField(inspector, 'Spindle speed', '3000')
  await setField(inspector, 'Feed rate', '150')
  await setField(inspector, 'Plunge rate', '150')
  await expect(inspector.getByLabel('Plunge rate', { exact: true })).toHaveValue('150')

  // toolpaths (a job), then the export through the save dialog
  await navigator.getByRole('button', { name: 'Generate toolpaths' }).click()
  await expect(navigator.getByText('All toolpaths up to date.')).toBeVisible({ timeout: 60_000 })
  await navigator.getByRole('button', { name: 'Export gCode…' }).click()
  const exported = page.getByRole('dialog', { name: 'gCode exported' })
  await expect(exported).toBeVisible({ timeout: 30_000 })
  await expect(exported.getByText('No machine warnings.')).toBeVisible()
  const gcode = readFileSync(files.gcode, 'utf8')
  const lineCount = gcode.trimEnd().split('\n').length
  await expect(exported.getByText(`${lineCount} lines`)).toBeVisible()
  expect(gcode).toMatch(/\(DFYOM TOOL CHANGE \d+: Drill 6\)/)
  await exported.getByRole('button', { name: 'Close' }).click()
  await expect(exported).toBeHidden()

  // ── Run it on the virtual machine with progress shown ────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const machine = page.getByRole('group', { name: 'Machine' })
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect to virtual machine' }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  // jog to the middle of the table, then set the work zero there
  await navigator.getByRole('radio', { name: '100 mm' }).click()
  for (const name of ['Jog X−', 'Jog Y−'])
    for (let i = 0; i < 4; i++) {
      await navigator.getByRole('button', { name }).click()
      await expect(machine.getByText('Idle')).toBeVisible()
    }
  await navigator.getByRole('radio', { name: '10 mm' }).click()
  for (let i = 0; i < 5; i++) {
    await navigator.getByRole('button', { name: 'Jog Z−' }).click()
    await expect(machine.getByText('Idle')).toBeVisible()
  }
  await navigator.getByRole('button', { name: 'Zero X Y Z' }).click()
  const dro = inspector.getByRole('table', { name: 'Position' })
  await expect(dro.getByRole('cell', { name: 'Work position Z' })).toHaveText(/^0\.000/)

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await expect(preflight.getByText('Shapeoko')).toBeVisible()
  await expect(preflight.getByRole('listitem')).toHaveText([
    'Flat 6',
    'Drill 6',
    'Bull 6',
    'Flat 6',
  ])
  await preflight.getByRole('button', { name: 'Start run' }).click()

  await expect(inspector.getByRole('progressbar', { name: 'Run progress' })).toBeVisible()
  const complete = inspector.getByText(/^Run complete: \d+ lines in/)
  const toolChanges: string[] = []
  for (;;) {
    const wait = page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    await expect(wait.or(complete)).toBeVisible({ timeout: 60_000 })
    if (await complete.isVisible()) break
    const title = (await wait.getByRole('heading').first().textContent()) ?? ''
    if (title.startsWith('Tool change')) toolChanges.push(title)
    await wait.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  expect(toolChanges).toHaveLength(3)
  const [, done, total] = /Line (\d+) \/ (\d+)/.exec((await inspector.textContent()) ?? '') ?? []
  expect(Number(done)).toBeGreaterThan(0)
  expect(done).toBe(total)
  expect(Number(total)).toBe(lineCount)
  await expect(machine.getByText('Idle')).toBeVisible()
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)

  // ── Save, close and reopen ───────────────────────────────────────────────────────────────
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status.getByText('Saved', { exact: true })).toBeVisible()
  expect(existsSync(files.project)).toBe(true)
  expect(dfyom.rendererErrors).toEqual([])

  await dfyom.app.close()
  const second = await launchApp(dfyom.dataDir)
  try {
    const page2 = await second.app.firstWindow()
    await stubFileDialogs(second.app, files)
    const nav2 = page2.getByRole('navigation', { name: 'Navigator' })
    const inspector2 = page2.getByRole('complementary', { name: 'Inspector' })
    await nav2.getByRole('button', { name: 'Open project' }).click()
    await expect(page2).toHaveTitle('Bracket')
    await expect(designRows(page2)).toHaveText([
      /^Facing 1/,
      /^Pocket 1/,
      /^Drilling 1/,
      /^Profile 1/,
    ])
    await designRows(page2).nth(1).click()
    await expect(inspector2.getByLabel('Corner radius', { exact: true })).toHaveValue('4')
    await expect(
      page2.getByRole('contentinfo', { name: 'Status bar' }).getByText('Part up to date'),
    ).toBeAttached({ timeout: 30_000 })
    // the plan came back with its tools and the drill's feeds
    await page2.keyboard.press('ControlOrMeta+2')
    await expect(planRows(page2)).toHaveText([
      /^Facing 1Flat 6/,
      /^Drilling 1Drill 6/,
      /^Pocket 1Bull 6/,
      /^Profile 1Flat 6/,
    ])
    await planRows(page2).nth(1).click()
    await expect(inspector2.getByLabel('Feed rate', { exact: true })).toHaveValue('150')
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
