// The setup's workholding in the Run scene (hardening DF133 RW1) in the real app on the virtual
// machine (the GRBL emulator, no hardware): a 250 × 100 × 40 stock with a facing, two toe clamps
// and a screw, a machine with an ER11 holder. Connected but not homed the Position panel says the
// clamps are outlined; homed with G54 never set they are hidden; with the work zero set they are
// solid and the holder ghost stands at the tool marker with its chip. Windows stay hidden
// (fixture). With DFYOM_RENDERS=1: df133-rw1-outlined and df133-rw1-solid (light and dark) in
// design/features/renders/, or in DFYOM_RENDERS_DIR. RW6 extends this into the guard's e2e.
// Docs: docs/modes/run-workholding.md#implementation-rw1, docs/conventions/ui.md#workholding
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function call<T>(page: Page, name: string, args: object = {}): Promise<T> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

/** With DFYOM_RENDERS=1: `name`-light.png and -dark.png (the theme set as Settings does). */
async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      ;(
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } }
        }
      ).document.documentElement.dataset['theme'] = t
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('run scene workholding (DF133 RW1): outlined, hidden, then solid with the holder ghost', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 860 })
  const stock = await call<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' },
    },
  })
  await call(page, 'library.tool.add', {
    values: {
      name: 'Flat 6',
      type: 'flatEndMill',
      diameter: '6',
      fluteLength: '20',
      overallLength: '50',
      stickout: '30',
      fluteCount: '2',
      toolMaterial: 'carbide',
    },
  })
  const machine = await call<{ id: string }>(page, 'library.machine.add', {
    values: {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '320', y: '220', z: '90' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
      homingCorner: 'backRight',
      pullOff: '1',
      softLimits: true,
      holder: { preset: 'er11' },
    },
  })
  await call(page, 'project.create', { name: 'Clamped', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>(page, 'design.part.add', {
    name: 'Clamped',
    stockLibraryItemId: stock.id,
  })
  await call(page, 'design.facing.add', { partId, depth: '0.5' })
  await call(page, 'project.apply', {})
  const { planId } = await call<{ planId: string }>(page, 'plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })
  const setupId = (await call<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId }))
    .plan.setups[0]!.id
  await call(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [
      { kind: 'toeClamp', edge: 'vMin', at: '60', top: '22' },
      { kind: 'toeClamp', edge: 'vMax', at: '190', top: '22' },
      { kind: 'screw', center: ['230', '50'], top: '2' },
    ],
  })

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machineGroup = page.getByRole('group', { name: 'Machine', includeHidden: true })
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')
  const line = inspector.locator('[data-workholding-trust]')

  await page.getByRole('radio', { name: 'Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(line).toHaveText('Clamps outlined: home the machine to place them at the work zero.')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df133-rw1-outlined')

  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  await expect(line).toHaveText('Clamps hidden: set the work zero to place them.')

  // the work zero at machine (−290, −160, −75), then the tool beside the front clamp, above it
  await call(page, 'run.machine.jog', { to: [-290, -160, -75], feed: 5000 })
  await expect.poll(() => at('Machine position Z')).toBeCloseTo(-75, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(line).toHaveText(
    'Clamps drawn as placed in Plan, at the work zero. Jogs are not checked against them.',
  )
  await call(page, 'run.machine.jog', { to: [-205, -150, -50], feed: 5000 })
  await expect.poll(() => at('Work position Z')).toBeCloseTo(25, 3)
  await expect(machineGroup.getByText('Idle')).toBeVisible()
  const chip = page.locator('[data-holder-ghost]')
  await expect(chip).toHaveText('T1 Ø6 mm · stickout 30 mm · ER11')
  await page.getByRole('button', { name: 'Fit' }).click()
  await render(page, 'df133-rw1-solid')

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machineGroup).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
