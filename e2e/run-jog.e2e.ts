// Jog, position and probing in the real app (hardening DF88) on the virtual machine (the GRBL
// emulator, no hardware): a click jogs one step, a custom step typed inline, a held button jogs
// until released, the videogame jog keys (tap = step, hold = continuous, Escape stops), and the
// "0" buttons in the Position table. Windows stay hidden (fixture). With DFYOM_RENDERS=1: df88-jog
// and df88-position (light and dark) in design/features/renders/.
// Docs: docs/conventions/ui.md#jog-position-and-probing-df88, docs/modes/run-machine.md
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir = resolve(__dirname, '../design/features/renders')

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
}

/** With DFYOM_RENDERS=1: `name`-light.png and -dark.png of `target` (the theme set as Settings does). */
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

test('jog (DF88): click = step, custom step, hold = continuous, WASD, Escape, zero in the table', async ({
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
      probePlateThickness: '10',
    },
  })
  expect(added.ok, JSON.stringify(added)).toBe(true)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const machine = page.getByRole('group', { name: 'Machine' })
  const dro = inspector.getByRole('table', { name: 'Position' })
  const cell = (name: string) => dro.getByRole('cell', { name })
  const at = async (name: string) => parseFloat((await cell(name).textContent()) ?? '')

  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  await expect(navigator.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
  // 10×: homing is quick, a slow hold still takes a moment
  // a serial port is the default connection (DF101): choose the virtual machine
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(cell('Machine position X')).toHaveText('-1.000')

  // no jog mode: the step picker, the feed slider and the pad; no "Zero X Y Z"
  await expect(navigator.getByRole('radio', { name: 'Continuous' })).toHaveCount(0)
  await expect(navigator.getByRole('button', { name: 'Zero X Y Z' })).toHaveCount(0)
  await expect(navigator.getByRole('heading', { name: 'Probing' })).toBeVisible()
  const feed = navigator.getByRole('slider', { name: 'Jog feed' })
  await expect(feed).toHaveAttribute('aria-valuetext', '2000 mm/min')
  await expect(feed).toHaveAttribute('aria-valuemax', '5000')
  // the slowest jog feed, in 100 mm/min steps (remembered for this machine)
  await feed.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(feed).toHaveAttribute('aria-valuetext', '200 mm/min')

  // a click: one step at the chosen preset
  await navigator.getByRole('radio', { name: '1 mm', exact: true }).click()
  await navigator.getByRole('button', { name: 'Jog X−' }).click()
  await expect(cell('Machine position X')).toHaveText('-2.000')
  await expect(machine.getByText('Idle')).toBeVisible()
  // a custom step, typed in the picker itself
  const custom = navigator.getByRole('textbox', { name: 'Custom jog step (mm)' })
  await custom.fill('2.5')
  await custom.press('Enter')
  await expect(navigator.getByRole('radio', { checked: true })).toHaveCount(0)
  await navigator.getByRole('button', { name: 'Jog Y−' }).click()
  await expect(cell('Machine position Y')).toHaveText('-3.500')
  await expect(machine.getByText('Idle')).toBeVisible()
  await render(page, 'df88-jog')

  // a hold: continuous until released, then the jog cancel stops it short of the travel edge
  const xMinus = navigator.getByRole('button', { name: 'Jog X−' })
  await xMinus.hover()
  await page.mouse.down()
  await expect(machine.getByText('Jogging')).toBeVisible()
  await expect.poll(() => at('Machine position X')).toBeLessThan(-10)
  await page.mouse.up()
  await expect(machine.getByText('Idle')).toBeVisible()
  const x = await at('Machine position X')
  expect(x).toBeLessThan(-10)
  expect(x).toBeGreaterThan(-400)

  // the videogame keys (the default style), with the focus on a pad button: a tap is one step
  await page.keyboard.press('d')
  await expect.poll(() => at('Machine position X')).toBeCloseTo(x + 2.5, 3)
  await expect(machine.getByText('Idle')).toBeVisible()
  // held: continuous until the key goes up
  const y = await at('Machine position Y')
  await page.keyboard.down('s')
  await expect(machine.getByText('Jogging')).toBeVisible()
  await expect.poll(() => at('Machine position Y')).toBeLessThan(y - 5)
  await page.keyboard.up('s')
  await expect(machine.getByText('Idle')).toBeVisible()
  // Escape stops a held key's jog at once
  await page.keyboard.down('a')
  await expect(machine.getByText('Jogging')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(machine.getByText('Idle')).toBeVisible()
  await page.keyboard.up('a')
  // typing never jogs
  const before = await at('Machine position Y')
  await custom.fill('')
  await custom.pressSequentially('ww')
  await page.waitForTimeout(600)
  expect(await at('Machine position Y')).toBe(before)
  await custom.press('Escape')

  // zero per axis with the "0" buttons beside the axis letters
  await dro.getByRole('button', { name: 'Set X zero' }).click()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)
  await dro.getByRole('button', { name: 'Set Y zero' }).click()
  await expect(cell('Work position Y')).toHaveText(/^-?0\.000/)
  await expect(cell('Work position Z')).not.toHaveText(/^-?0\.000/)
  await render(page, 'df88-position')

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
