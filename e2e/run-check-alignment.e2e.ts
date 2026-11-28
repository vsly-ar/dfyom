// Check alignment in the real app (v0.5 RV6) on the virtual machine (the GRBL emulator, no
// hardware): the virtual operator's stock lies turned 0.5° about its front-left corner, where the
// X/Y zero is set. The perimeter trace stops at the four corners of the outline 2 mm outside the
// plan's stock, 2 mm above the top; Measure with the bit probes the front edge at two points and
// reports the turn within 0.02°; with a toe clamp over the back-right corner the move there is
// refused by the workholding guard and nothing moves. Windows stay hidden (fixture). With
// DFYOM_RV6_SHOTS=<dir>: light screenshots there.
// Docs: docs/modes/alignment.md#check-alignment-rv6
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_RV6_SHOTS']

async function call<T>(page: Page, name: string, args: object = {}): Promise<T> {
  const r = await page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
  expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
  return (r as Extract<CallReply, { ok: true }>).value as T
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  await page.evaluate(() => {
    ;(
      globalThis as unknown as {
        document: { documentElement: { dataset: Record<string, string> } }
      }
    ).document.documentElement.dataset['theme'] = 'light'
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('check alignment (v0.5 RV6): perimeter trace at the gap, Measure a turned stock, guard', async ({
  dfyom,
}) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 900 })
  const stock = await call<{ id: string }>(page, 'library.stock.add', {
    values: {
      name: 'Aluminium plate',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: '6061', class: 'aluminum' },
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
      travel: { x: '800', y: '600', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '24000' },
      programUnits: 'mm',
      toolChanger: 'none',
      homingCorner: 'backRight',
      pullOff: '1',
      softLimits: true,
      probe: { kind: 'tool', fastFeed: '300', slowFeed: '50' },
    },
  })
  await call(page, 'project.create', { name: 'Plate', unitSystem: 'mm' })
  const { partId } = await call<{ partId: string }>(page, 'design.part.add', {
    name: 'Plate',
    stockLibraryItemId: stock.id,
  })
  await call(page, 'design.facing.add', { partId, depth: '0.5' })
  await call(page, 'project.apply', {})
  const { planId } = await call<{ planId: string }>(page, 'plan.create', {
    partId,
    machineLibraryItemId: machine.id,
  })

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machineGroup = page.getByRole('group', { name: 'Machine', includeHidden: true })
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')
  const idle = () => expect(machineGroup.getByText('Idle')).toBeVisible()
  const jog = async (to: [number, number, number]) => {
    await call(page, 'run.machine.jog', { to, feed: 5000 })
    await expect.poll(() => at('Machine position X')).toBeCloseTo(to[0], 3)
    await expect.poll(() => at('Machine position Y')).toBeCloseTo(to[1], 3)
    await expect.poll(() => at('Machine position Z')).toBeCloseTo(to[2], 3)
    await idle()
  }
  const machineAt = async (x: number, y: number, z: number) => {
    expect(Math.abs((await at('Machine position X')) - x)).toBeLessThanOrEqual(0.01)
    expect(Math.abs((await at('Machine position Y')) - y)).toBeLessThanOrEqual(0.01)
    expect(Math.abs((await at('Machine position Z')) - z)).toBeLessThanOrEqual(0.01)
  }

  await page.getByRole('radio', { name: 'Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await idle()
  // before the X/Y zero the check waits for it
  await expect(navigator.getByRole('button', { name: 'Check alignment…' })).toBeDisabled()

  // the work zero by eye at machine (−400, −300, −60); Set X/Y zero's virtual operator lays the
  // stock (3.2, −1.7) mm off; here it lies turned 0.5° about that front-left corner instead
  await jog([-400, -300, -60])
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)
  const xyDialog = page.getByRole('dialog', { name: 'Set X/Y zero' })
  await navigator.getByRole('button', { name: 'Set X/Y zero…' }).click()
  await xyDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(xyDialog).toHaveCount(0)
  const corner = [-400 + 3.2, -300 - 1.7] as const
  await call(page, 'run.virtual.stock', {
    stock: {
      min: [corner[0], corner[1], -100],
      max: [corner[0] + 250, corner[1] + 100, -60],
      angle: 0.5,
    },
    touch: false,
  })
  // the X/Y zero on that corner (Set X/Y zero's own path is RV5's e2e)
  await jog([-400, -300, -50])
  await call(page, 'run.workZero.set', {
    axes: ['x', 'y'],
    values: [-400 - corner[0], -300 - corner[1], 10],
  })
  await expect.poll(() => at('Work position X')).toBeCloseTo(-3.2, 3)

  // the perimeter trace: the four corners of the outline 2 mm outside, 2 mm above the top
  const dialog = page.getByRole('dialog', { name: 'Check alignment' })
  const statusLine = dialog.locator('[data-check-status]')
  await navigator.getByRole('button', { name: 'Check alignment…' }).click()
  await expect(dialog.getByText(/^Stock 250\.000 × 100\.000 mm, from /)).toBeVisible()
  await dialog.getByRole('radio', { name: 'Perimeter' }).click()
  await dialog.getByRole('button', { name: 'Start the trace' }).click()
  const g = 2
  const outline: [string, number, number][] = [
    ['front left corner', corner[0] - g, corner[1] - g],
    ['front right corner', corner[0] + 250 + g, corner[1] - g],
    ['back right corner', corner[0] + 250 + g, corner[1] + 100 + g],
    ['back left corner', corner[0] - g, corner[1] + 100 + g],
  ]
  await expect(statusLine).toHaveText(/^At the front left corner \(1 of 4\)/, { timeout: 30_000 })
  await machineAt(outline[0]![1], outline[0]![2], -58)
  for (const [i, [name, x, y]] of [...outline.slice(1), outline[0]!].entries()) {
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(statusLine).toHaveText(
      i === 3 ? 'Back at the start: the trace is done.' : new RegExp(`^At the ${name} `),
      { timeout: 60_000 },
    )
    await machineAt(x, y, -58)
    if (i === 1) await shot(page, 'rv6-1-perimeter-back-right')
  }

  // Measure the front edge with the bit: the turn within 0.02°
  await dialog.getByRole('radio', { name: 'Measure' }).click()
  await expect(dialog.getByRole('radio', { name: 'Front edge (Y−)' })).toBeChecked()
  await expect(dialog.getByRole('textbox', { name: 'Bit Ø' })).toHaveValue('6.000')
  // DF143: the probe check: "Touch probe" closes the virtual probe input for a moment
  await dialog
    .getByRole('group', { name: 'Probe input' })
    .getByRole('button', { name: 'Touch probe' })
    .click()
  await expect(dialog.getByText('Probe tested: probing is enabled.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Measure', exact: true }).click()
  const angle = dialog.locator('[data-measure-angle]')
  await expect(angle).toHaveText(/^Turned [\d.]+° counter-clockwise/, { timeout: 120_000 })
  const deg = parseFloat(/Turned ([\d.]+)°/.exec((await angle.textContent()) ?? '')![1]!)
  expect(Math.abs(deg - 0.5)).toBeLessThanOrEqual(0.02)
  await expect(dialog.locator('[data-measure-nudge]')).toHaveText(
    /^Keep the front left corner where it is and move the front right corner 2\.1\d\d mm toward Y−\.$/,
  )
  await shot(page, 'rv6-2-measure')

  // a toe clamp over the back-right corner: the move there is refused, nothing moves
  const setupId = (await call<{ plan: { setups: { id: string }[] } }>(page, 'plan.get', { planId }))
    .plan.setups[0]!.id
  await call(page, 'plan.workholding.set', {
    planId,
    setupId,
    items: [{ kind: 'toeClamp', edge: 'vMax', at: '245', top: '22' }],
  })
  await dialog.getByRole('radio', { name: 'Pointer' }).click()
  await dialog.getByRole('radio', { name: 'Corners' }).click()
  await dialog.getByRole('button', { name: 'Go to the first stop' }).click()
  await expect(statusLine).toHaveText(/^At the front left corner/, { timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(statusLine).toHaveText(/^At the front right corner/, { timeout: 60_000 })
  const finding = dialog.locator('[data-guard-finding]')
  await expect(finding).toContainText(/hits Toe clamp 1/)
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled()
  await shot(page, 'rv6-3-guard')
  const before = await at('Machine position Y')
  await page.waitForTimeout(500)
  expect(await at('Machine position Y')).toBe(before)
  await machineAt(outline[1]![1], outline[1]![2], -58)
})
