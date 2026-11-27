// Go to coordinates in the real app (hardening DF128, slice GT1) on the virtual machine (the GRBL
// emulator, no hardware): a work coordinate in the Position table opens the Go to dialog, the jog
// keys do nothing while it is open, a target typed in the work frame from inside the stock is
// reached in the safe order (lift, across, down) and the dialog closes on arrival. Windows stay
// hidden (fixture). With DFYOM_RENDERS=1: df128-goto (light and dark) in design/features/renders/,
// or in DFYOM_RENDERS_DIR.
// Docs: docs/modes/run-goto.md, docs/conventions/ui.md#jog-position-and-probing-df88
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
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

test('go to (DF128): open from the DRO, jog keys off, safe order to a work coordinate', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (RENDERS) await page.setViewportSize({ width: 1280, height: 860 })
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
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machine = page.getByRole('group', { name: 'Machine', includeHidden: true })
  // includeHidden: the modal dialog hides the rest of the window from the accessibility tree
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')

  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(cell('Machine position X')).toHaveText('-1.000')

  // a work zero at machine (−300, −200, −60), then the tool 10 mm into the "stock" beside it
  expect((await call(page, 'run.machine.jog', { to: [-300, -200, -60], feed: 5000 })).ok).toBe(true)
  await expect.poll(() => at('Machine position Z')).toBeCloseTo(-60, 3)
  await expect(machine.getByText('Idle')).toBeVisible()
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(cell('Work position Z')).toHaveText(/^-?0\.000/)
  expect((await call(page, 'run.machine.jog', { to: [-340, -230, -70], feed: 5000 })).ok).toBe(true)
  await expect.poll(() => at('Machine position Z')).toBeCloseTo(-70, 3)
  await expect(machine.getByText('Idle')).toBeVisible()

  // open from the work X value: the work frame, X focused, the fields at the position
  await dro.getByRole('button', { name: /^Go to: X -40\.000 work$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Go to' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Work (G54)' })).toBeChecked()
  const field = (axis: string) => dialog.getByRole('textbox', { name: axis, exact: true })
  await expect(field('X')).toBeFocused()
  await expect(field('Z')).toHaveValue('-10.000')

  // the jog keys do nothing while it is open, wherever the focus is
  await dialog.getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('d')
  await page.keyboard.press('s')
  await page.keyboard.down('a')
  await page.waitForTimeout(700)
  await page.keyboard.up('a')
  await expect(machine.getByText('Idle')).toBeVisible()
  expect(await at('Machine position X')).toBeCloseTo(-340, 3)
  expect(await at('Machine position Y')).toBeCloseTo(-230, 3)

  // the work zero, 2 mm above it: lift to the safe height, across, down
  await field('X').fill('0')
  await field('Y').fill('0')
  await field('Z').fill('2')
  const steps = dialog.getByRole('list', { name: 'Steps' }).getByRole('listitem')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toHaveText(/^1 · Up to Z 5\.000/)
  await expect(steps.nth(1)).toHaveText(/^2 · To X 0\.000 Y 0\.000/)
  await expect(steps.nth(2)).toHaveText(/^3 · Down to Z 2\.000/)
  await render(page, 'df128-goto')
  await field('Z').press('Enter')
  // X/Y only move once Z is up at the safe height (work Z 5)
  let lowest = Infinity
  await expect
    .poll(async () => {
      const x = await at('Work position X')
      const z = await at('Work position Z')
      if (x > -40 + 0.01 && x < -0.01) lowest = Math.min(lowest, z)
      return dialog.count()
    })
    .toBe(0)
  if (lowest !== Infinity) expect(lowest).toBeGreaterThanOrEqual(5 - 0.01)
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)
  await expect(cell('Work position Y')).toHaveText(/^-?0\.000/)
  await expect(cell('Work position Z')).toHaveText(/^2\.000/)
  await expect(cell('Machine position Z')).toHaveText('-58.000')

  // WASD jogs again once it is closed
  await navigator.getByRole('radio', { name: '1 mm', exact: true }).click()
  await page.keyboard.press('d')
  await expect.poll(() => at('Work position X')).toBeCloseTo(1, 3)

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
