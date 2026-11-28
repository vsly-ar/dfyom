// Work area in the real app (v0.5 RV7) on the virtual machine (the GRBL emulator, no hardware):
// after homing, the Work area dialog marks X max and Y max at the homed corner and X min and Y min
// after jogs there; the marks are saved with the library machine and the `$130=` line to copy is
// shown (Q219: never written). A Go to beyond the marks (less the 2 mm margin) is refused with
// the reason and Go stays disabled; a jog past them is refused. Windows stay hidden (fixture).
// With DFYOM_RV78_SHOTS=<dir>: light screenshots there.
// Docs: docs/modes/run.md#work-area-rv7
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_RV78_SHOTS']

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
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

test('work area (v0.5 RV7): mark the ends after homing, a Go to beyond them is refused', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 900 })
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

  const navigator = page.getByRole('navigation', { name: 'Navigator', includeHidden: true })
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machine = page.getByRole('group', { name: 'Machine', includeHidden: true })
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')

  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(cell('Machine position X')).toHaveText('-1.000')

  await navigator.getByRole('button', { name: 'Work area…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Work area' })
  await expect(dialog).toBeVisible()
  // the homed corner: X max and Y max
  await dialog.getByRole('button', { name: 'Mark X max' }).click()
  await expect(dialog.locator('[data-mark="x-max"]')).toHaveText('-1.000 mm')
  await dialog.getByRole('button', { name: 'Mark Y max' }).click()
  await expect(dialog.locator('[data-mark="y-max"]')).toHaveText('-1.000 mm')
  // the far corner, short of the travel: X −780, Y −590 (as if a cable chain stopped it there)
  expect((await call(page, 'run.machine.jog', { to: [-780, -590, -1], feed: 5000 })).ok).toBe(true)
  await expect.poll(() => at('Machine position X')).toBeCloseTo(-780, 3)
  await expect(machine.getByText('Idle')).toBeVisible()
  await dialog.getByRole('button', { name: 'Mark X min' }).click()
  await expect(dialog.locator('[data-mark="x-min"]')).toHaveText('-780.000 mm')
  await dialog.getByRole('button', { name: 'Mark Y min' }).click()
  await expect(dialog.locator('[data-mark="y-min"]')).toHaveText('-590.000 mm')
  // 780 mm from the X switch against $130 = 800: the line to copy
  await expect(dialog.getByRole('button', { name: 'Copy $130=780.000' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy $131=590.000' })).toBeVisible()
  await shot(page, 'rv7-work-area')
  await dialog.getByRole('button', { name: 'Close' }).first().click()
  await expect(dialog).toHaveCount(0)

  // saved with the library machine
  const listed = await call(page, 'library.machine.list', {})
  expect(JSON.stringify(listed)).toContain('"workArea"')

  // Go to machine X −1 (the mark, inside the travel): beyond the area less the 2 mm margin
  await navigator.getByRole('button', { name: 'Home' }).focus()
  await page.keyboard.press('g')
  const goTo = page.getByRole('dialog', { name: 'Go to' })
  await expect(goTo).toBeVisible()
  await goTo.getByRole('radio', { name: 'Machine (G53)' }).click()
  await goTo.getByRole('textbox', { name: 'X', exact: true }).fill('-1')
  await expect(goTo.getByText(/X would leave the work area/).first()).toBeVisible()
  await expect(goTo.getByRole('button', { name: 'Go', exact: true })).toBeDisabled()
  await shot(page, 'rv7-goto-refused')
  // inside it: allowed
  await goTo.getByRole('textbox', { name: 'X', exact: true }).fill('-10')
  await expect(goTo.getByText(/X would leave the work area/)).toHaveCount(0)
  await expect(goTo.getByRole('button', { name: 'Go', exact: true })).toBeEnabled()
  await goTo.getByRole('button', { name: 'Cancel' }).click()
  await expect(goTo).toHaveCount(0)

  // a jog past the area is refused by the host too (the margin in)
  const jog = await call(page, 'run.machine.jog', { by: [-5, 0, 0], feed: 1000 })
  expect(jog.ok).toBe(false)
  expect(JSON.stringify(jog)).toContain('work area')
  expect(await at('Machine position X')).toBeCloseTo(-780, 3)

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
