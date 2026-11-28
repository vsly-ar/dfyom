// Map stock surface in the built app (v0.5 RV10) on the virtual machine (the GRBL emulator, no
// hardware): a block with a pocket planned through the bridge; in Run, after connecting, homing and
// zeroing on the stock top, "Map stock surface…" probes the default 5 × 4 grid on the virtual
// operator's tilted stock top (VIRTUAL_TILT), shows the heat map and keeps the map; the pre-flight
// offers "Follow the surface map" off by default; ticked, the run streams the followed program
// (more lines than the plain export: the split moves) to its end.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-surface.md
import type { Page } from '@playwright/test'
import type { RunStatus } from '../src/core/run/service'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test, zeroXyz } from './app.fixture'

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

async function blockPlan(page: Page): Promise<string> {
  const call = <T>(name: string, args: object = {}) => bridgeCall<T>(page, name, args)
  const stock = await call<{ id: string }>('library.stock.add', {
    values: {
      name: 'Board',
      shape: 'block',
      length: '180',
      width: '60',
      thickness: '18',
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
  await call('project.create', { name: 'Surface', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>('design.part.add', {
    name: 'Tray',
    stockLibraryItemId: stock.id,
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
    depth: '3',
  })
  await call('project.apply', {})
  const { planId } = await call<{ planId: string }>('plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  return planId
}

test('run: map the stock surface, follow it, run to the end (RV10)', async ({ dfyom }) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const planId = await blockPlan(page)
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
  await bridgeCall(page, 'run.machine.jog', { to: [-500, -400, -60], feed: 5000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  // Z0 on the stock top here (the virtual top lies at G54 Z), then up above the first point
  await zeroXyz(page)
  await bridgeCall(page, 'run.machine.jog', { to: [-495, -395, -55], feed: 5000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  const plain = await bridgeCall<{ program: { lines: string[] } }>(page, 'run.job.check', {
    planId,
    program: true,
  })

  await navigator.getByRole('button', { name: 'Map stock surface…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Map stock surface' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/^5 × 4 points/)).toBeVisible()
  await dialog
    .getByRole('group', { name: 'Probe input' })
    .getByRole('button', { name: 'Touch probe' })
    .click()
  const map = dialog.getByRole('button', { name: 'Map surface' })
  await expect(map).toBeEnabled()
  await map.click()
  const heat = dialog.getByRole('img', { name: /^Surface map: lowest/ })
  await expect(heat).toHaveAccessibleName(/20 of 20 points/, { timeout: 120_000 })
  await expect(dialog.getByRole('button', { name: 'Clear map' })).toBeVisible()
  // the tilt: 0.004 in X over the 170 mm between the outer columns, −0.002 in Y over 50 mm
  const range = Number(/Range ([\d.]+) mm/.exec((await dialog.textContent()) ?? '')?.[1])
  expect(range).toBeGreaterThan(0.5)
  expect(range).toBeLessThan(1)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  const follow = preflight.getByRole('checkbox', { name: 'Follow the surface map' })
  await expect(follow).not.toBeChecked()
  await expect(preflight.getByText('Inside the travel at this work zero.')).toBeVisible()
  await follow.click()
  await expect(preflight.getByText(/^The program moves by up to [\d.]+ mm\.$/)).toBeVisible({
    timeout: 30_000,
  })
  const start = preflight.getByRole('button', { name: 'Start run' })
  await expect(start).toBeEnabled()
  await start.click()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: [\d,]+ lines in/)
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  await expect(machine.getByText('Idle')).toBeVisible()
  // the streamed program followed the map: more lines (split moves) than the plain export
  const status = await bridgeCall<RunStatus>(page, 'run.status.get')
  const streamed = await page.evaluate(
    (id) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.run.program(id),
    status.lastRun!.jobId,
  )
  expect(streamed!.lines.length).toBeGreaterThan(plain.program.lines.length)
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
