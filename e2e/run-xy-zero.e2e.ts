// Set X/Y zero in the real app (v0.5 RV4/RV5) on the virtual machine (the GRBL emulator, no
// hardware): the machine probes with the bit; the virtual operator lays the plan's stock 3.2 mm in
// X and −1.7 mm in Y off where G54 says. A corner probe from the dialog, confirmed, sets G54 so
// the DRO's "→0" X and Y land on the stock's front-left corner within 0.01 mm; Undo puts G54
// back; a touch-off on the X+ edge by jogging (a 0.1 mm feeler, the probe input as the readout)
// sets X again. Windows stay hidden (fixture). With DFYOM_RV45_SHOTS=<dir>: light screenshots of
// the dialog's steps there.
// Docs: docs/modes/run-probing.md#set-xy-zero-rv5, #xy-probing-rv4
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_RV45_SHOTS']

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

test('set X/Y zero (v0.5 RV4/RV5): corner probe with the bit, →0 on the corner, undo, touch-off', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 860 })
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
  await call(page, 'plan.create', { partId, machineLibraryItemId: machine.id })

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

  await page.getByRole('radio', { name: 'Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await idle()

  // G54 by eye at machine (−400, −300, −60): the stock top's front-left corner, as the user
  // believes it is; the virtual operator laid it 3.2 mm right and 1.7 mm toward the front
  await jog([-400, -300, -60])
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)
  const corner = [-400 + 3.2, -300 - 1.7] as const
  // the bit 10 mm above the top, 5 mm in from the real corner
  await jog([-400, -300, -50])
  await jog([corner[0] + 5, corner[1] + 5, -50])

  const dialog = page.getByRole('dialog', { name: 'Set X/Y zero' })
  await navigator.getByRole('button', { name: 'Set X/Y zero…' }).click()
  await expect(dialog.getByRole('radio', { name: 'Front left corner (X− Y−)' })).toBeChecked()
  await expect(dialog.getByText(/Plan zero: this corner/)).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Probe' })).toBeChecked()
  await expect(dialog.getByRole('textbox', { name: 'Bit Ø' })).toHaveValue('6.000')
  await shot(page, 'rv5-1-pick-probe')
  await dialog.getByRole('button', { name: 'Probe', exact: true }).click()
  await expect(dialog.getByText(/^G54 X: -400\.000 → -396\.8\d\d mm/)).toBeVisible({
    timeout: 60_000,
  })
  await expect(dialog.getByText(/^X− edge at -396\.8\d\d ± 0\.00\d mm \(machine\)$/)).toBeVisible()
  await shot(page, 'rv5-2-confirm')
  await dialog.getByRole('button', { name: 'Set zero' }).click()
  await expect(dialog).toHaveCount(0)

  // →0 X and Y land on the stock's corner within 0.01 mm
  await dro.getByRole('button', { name: 'Go to work X zero' }).click()
  await expect.poll(() => at('Work position X'), { timeout: 30_000 }).toBeCloseTo(0, 3)
  await idle()
  await dro.getByRole('button', { name: 'Go to work Y zero' }).click()
  await expect.poll(() => at('Work position Y'), { timeout: 30_000 }).toBeCloseTo(0, 3)
  await idle()
  expect(Math.abs((await at('Machine position X')) - corner[0])).toBeLessThanOrEqual(0.01)
  expect(Math.abs((await at('Machine position Y')) - corner[1])).toBeLessThanOrEqual(0.01)
  await shot(page, 'rv5-3-at-corner')

  // Undo: G54 X/Y back to where they were
  await navigator.getByRole('button', { name: 'Undo zero change' }).click()
  await expect.poll(() => at('Work position X')).toBeCloseTo(3.2, 3)
  await expect.poll(() => at('Work position Y')).toBeCloseTo(-1.7, 3)
  await expect(navigator.getByRole('button', { name: 'Undo zero change' })).toHaveCount(0)

  // touch-off on the X+ edge (X −146.8): beside it, below the top, a 0.1 mm feeler between
  const edge = corner[0] + 250
  await jog([edge + 10, -260, -50])
  await jog([edge + 10, -260, -63])
  await navigator.getByRole('button', { name: 'Set X/Y zero…' }).click()
  await dialog.getByRole('radio', { name: 'Right edge (X+)' }).click()
  await dialog.getByRole('radio', { name: 'Touch' }).click()
  const feeler = dialog.getByRole('textbox', { name: 'Feeler' })
  await feeler.fill('0.1')
  const readout = dialog.locator('[data-touch-readout]')
  await expect(readout).toHaveText('Probe input: open.')
  // jogging toward the edge: the bit closes the input once it touches the stock …
  await jog([edge + 3 - 0.02, -260, -63])
  await expect(readout).toHaveText('Probe input: touching.')
  // … back off to the feeler's thickness with the dialog's jog pad (X+ 0.1 mm steps)
  await jog([edge + 3, -260, -63])
  await dialog.getByRole('radio', { name: '0.1 mm' }).click()
  await dialog.getByRole('button', { name: 'Jog X+' }).click()
  await expect.poll(() => at('Machine position X')).toBeCloseTo(edge + 3.1, 3)
  await idle()
  await expect(readout).toHaveText('Probe input: open.')
  await dialog.getByRole('button', { name: 'Touching X+ edge' }).click()
  await shot(page, 'rv5-4-touch')
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog.getByText(/^G54 X: -400\.000 → -396\.800 mm \(\+3\.200\)$/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Set zero' }).click()
  await expect(dialog).toHaveCount(0)
  // the bit's side 0.1 mm off the X+ edge: work X = 250 + 3.1
  await expect.poll(() => at('Work position X')).toBeCloseTo(253.1, 3)
})
