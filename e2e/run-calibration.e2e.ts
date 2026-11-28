// Calibration cut in the built app (v0.5 RV9) on the virtual machine (the GRBL emulator, no
// hardware): a block with the part's pocket at one end, planned through the bridge; in Run, after
// connecting, homing and zeroing, "Calibration cut…" suggests a spot clear of the pocket, previews
// the program in the viewport, runs it through the tool change to its end; the cut is kept, the
// caliper readings give a steps/mm line to copy and the tool Ø.
// Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-calibration.md
import type { Page } from '@playwright/test'
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
  await call('project.create', { name: 'Calibration', unitSystem: 'mm' })
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

test('run: a calibration cut on a free spot, run to its end, readings give suggestions (RV9)', async ({
  dfyom,
}) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await blockPlan(page)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const view = page.getByRole('region', { name: '3D viewport' })
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
  // the stock's front-left top corner, well inside the travel
  await bridgeCall(page, 'run.machine.jog', { to: [-500, -400, -60], feed: 5000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  await zeroXyz(page)

  await navigator.getByRole('button', { name: 'Calibration cut…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Calibration cut' })
  await expect(dialog).toBeVisible()
  // a spot clear of the pocket (it reaches x ≈ 63) and 2 mm inside the stock
  const x = dialog.getByRole('textbox', { name: 'Centre X (mm)' })
  await expect(x).not.toHaveValue('', { timeout: 30_000 })
  expect(Number(await x.inputValue())).toBeGreaterThan(63)
  const run = dialog.getByRole('button', { name: 'Run calibration cut' })
  await expect(run).toBeEnabled({ timeout: 30_000 })
  // the program is previewed in the viewport (the plan's pocket is not drawn meanwhile)
  await expect(view).toHaveAttribute('data-toolpath-segments', /^[1-9]\d*$/)
  // a spot on the pocket is refused
  await x.fill('35')
  await expect(dialog.locator('[data-problem="operation"]')).toBeVisible()
  await expect(run).toBeDisabled()
  await dialog.getByRole('button', { name: 'Suggest a free spot' }).click()
  await expect(run).toBeEnabled({ timeout: 30_000 })
  await run.click()

  // the tool change first (the app's wait dialog or the dialog's own Continue), then the end
  const results = dialog.getByRole('textbox', { name: 'Pocket X (mm)' })
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  for (;;) {
    await expect(
      waits()
        .or(results)
        .or(dialog.getByRole('button', { name: 'Continue' })),
    ).toBeVisible({ timeout: 120_000 })
    if (await results.isVisible()) break
    if (await waits().isVisible()) {
      const title = (await waits().getByRole('heading').first().textContent()) ?? ''
      await waits().getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('dialog', { name: title })).toBeHidden()
    } else await dialog.getByRole('button', { name: 'Continue' }).click()
  }
  await expect(results).toBeVisible({ timeout: 120_000 })

  // readings: X 1 % long (pocket and boss both), the tool cuts 0.1 mm wide
  await results.fill('15.25')
  await dialog.getByRole('textbox', { name: 'Boss X (mm)' }).fill('15.05')
  await expect(dialog.getByText(/X moves 1.00 % off/)).toBeVisible()
  await expect(dialog.locator('[data-suggestion="stepsPerMm"] code')).toHaveText(/^\$100=\d/)
  await expect(dialog.getByText(/The tool cuts as Ø 6.1 mm/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Save results' }).click()
  await expect(dialog.getByText('Results saved.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).first().click()
  await expect(dialog).toHaveCount(0)
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  expect(dfyom.rendererErrors).toEqual([])
})
