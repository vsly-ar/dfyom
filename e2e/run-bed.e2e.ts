// The bed map in the built app (v0.5 RV11) on the virtual machine (the GRBL emulator, no
// hardware): Run inspector › Machine settings › "Map bed…" probes the default 5 × 4 grid over the
// travel on the virtual operator's warped bed (VIRTUAL_BED) and keeps it with the library machine;
// the app is closed and relaunched, a new project's plan for a thin sheet on the same machine
// shows the saved map, and the pre-flight's "Compensate with the bed map" (off by default) streams
// the compensated program (more lines than the plain export: the split moves) to its end.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-surface.md#the-bed-map-rv11
import type { Page } from '@playwright/test'
import type { RunStatus } from '../src/core/run/service'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, launchApp, test, zeroXyz } from './app.fixture'

async function bridgeCall<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

const WOOD = {
  name: 'MDF',
  materialClass: 'sheetGood',
  spindleSpeed: '18000',
  feedRate: '1500',
  plungeRate: '400',
  stepdown: '1.5',
  stepover: '2.4',
}

interface Library {
  stock: string
  machine: string
}

/** A 3 mm sheet, a 6 mm end mill and a router (800 × 600) in the library. */
async function library(page: Page): Promise<Library> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Sheet',
      shape: 'block',
      length: '180',
      width: '60',
      thickness: '3',
      material: { name: 'MDF', class: 'sheetGood' },
    },
  })
  await call('library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '20',
      overallLength: '50',
      fluteCount: '2',
      toolMaterial: 'carbide',
      presets: [WOOD],
    },
  })
  const machine = await call<{ id: string }>('library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '600', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'gcode', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
    },
  })
  return { stock: stock.id, machine: machine.id }
}

/** A project with a shallow pocket in the sheet, planned on the library machine. */
async function sheetPlan(page: Page, lib: Library): Promise<string> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  await call('project.create', { name: 'Bed', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Plate',
    stockLibraryItemId: lib.stock,
  })
  await call('design.pocket.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['35', '30'],
      length: '50',
      width: '40',
      cornerRadius: '4',
    },
    depth: '1.5',
  })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: lib.machine,
  })
  return planId
}

/** Run mode, the inspector shown, connected to the virtual machine at Max and homed. */
async function connectAndHome(page: Page) {
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  await page.keyboard.press('ControlOrMeta+3')
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  return { navigator, inspector, machine }
}

test('run: map the bed, relaunch, compensate a thin sheet with it (RV11)', async ({ dfyom }) => {
  test.setTimeout(300_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const lib = await library(page)
  await sheetPlan(page, lib)
  const first = await connectAndHome(page)
  const settings = first.inspector.getByRole('button', { name: 'Machine settings' })
  await settings.click()
  await first.inspector.getByRole('button', { name: 'Map bed…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Map bed' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/^5 × 4 points/)).toBeVisible()
  await dialog
    .getByRole('group', { name: 'Probe input' })
    .getByRole('button', { name: 'Touch probe' })
    .click()
  const map = dialog.getByRole('button', { name: 'Map bed' })
  await expect(map).toBeEnabled()
  await map.click()
  const heat = dialog.getByRole('img', { name: /^Surface map: lowest/ })
  await expect(heat).toHaveAccessibleName(/20 of 20 points/, { timeout: 180_000 })
  // the warp: a tilt and seeded bumps, under the 1 mm follow limit
  const range = Number(/Range ([\d.]+) mm/.exec((await dialog.textContent()) ?? '')?.[1])
  expect(range).toBeGreaterThan(0.2)
  expect(range).toBeLessThan(1)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  await first.navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])

  // ── close (the project unsaved), relaunch on the same data: the map stays with the machine ──
  await dfyom.app.close()
  const second = await launchApp(dfyom.dataDir)
  try {
    const page2 = await second.app.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const planId = await sheetPlan(page2, lib)
    const { navigator, inspector, machine } = await connectAndHome(page2)
    await inspector.getByRole('button', { name: 'Machine settings' }).click()
    await expect(inspector.getByText(/5 × 4, range/)).toBeVisible()
    await bridgeCall(page2, 'run.machine.jog', { to: [-500, -400, -60], feed: 5000 })
    await expect(machine.getByText('Idle')).toBeVisible()
    await zeroXyz(page2)
    const plain = await bridgeCall<{ program: { lines: string[] } }>(page2, 'run.job.check', {
      planId,
      program: true,
    })
    await inspector.getByRole('button', { name: 'Start run' }).click()
    const preflight = page2.getByRole('dialog', { name: 'Start run?' })
    const compensate = preflight.getByRole('checkbox', { name: 'Compensate with the bed map' })
    await expect(compensate).not.toBeChecked()
    await expect(preflight.getByText('Inside the travel at this work zero.')).toBeVisible()
    await compensate.click()
    await expect(preflight.getByText(/^The program moves by up to [\d.]+ mm\.$/)).toBeVisible({
      timeout: 30_000,
    })
    const start = preflight.getByRole('button', { name: 'Start run' })
    await expect(start).toBeEnabled()
    await start.click()
    const waits = () => page2.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
    const complete = page2.getByText(/^Run complete: [\d,]+ lines in/)
    for (;;) {
      await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
      if (await complete.isVisible()) break
      const title = (await waits().getByRole('heading').first().textContent()) ?? ''
      await waits().getByRole('button', { name: 'Continue' }).click()
      await expect(page2.getByRole('dialog', { name: title })).toBeHidden()
    }
    await expect(machine.getByText('Idle')).toBeVisible()
    // the streamed program followed the bed: more lines (split moves) than the plain export
    const status = await bridgeCall<RunStatus>(page2, 'run.status.get')
    const streamed = await page2.evaluate(
      (id) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.run.program(id),
      status.lastRun!.jobId,
    )
    expect(streamed!.lines.length).toBeGreaterThan(plain.program.lines.length)
    await navigator.getByRole('button', { name: 'Disconnect' }).click()
    expect(second.rendererErrors).toEqual([])
  } finally {
    await second.app.close()
  }
})
