// Jog, position and probing in the real app (hardening DF88) on the virtual machine (the GRBL
// emulator, no hardware): a click jogs one step, a custom step typed inline, a held button jogs
// until released, the videogame jog keys (tap = step, hold = continuous, Escape stops), and the
// "=0" buttons in the Position table. Windows stay hidden (fixture). With DFYOM_RENDERS=1: df88-jog
// and df88-position (light and dark) in design/features/renders/. DF140: a jog key right after a
// clicked step, the DRO's "→0" reaching the work zero, the jog step and feed after a restart.
// Docs: docs/conventions/ui.md#jog-position-and-probing-df88, #jog-pad-df140, docs/modes/run-machine.md,
// docs/modes/run-goto.md#go-to-work-zero-per-axis-df140
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { closeApp, expect, launchApp, test } from './app.fixture'

const RENDERS = process.env['DFYOM_RENDERS'] === '1'

const ROUTER = {
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
}
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

test('DF140: a jog key after a clicked step, →0 to the work zero, jog settings after a restart', async ({
  dfyom,
}) => {
  test.setTimeout(180_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const added = await call(page, 'library.machine.add', { values: ROUTER })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector', includeHidden: true })
  const machine = page.getByRole('group', { name: 'Machine' })
  const dro = inspector.getByRole('table', { name: 'Position', includeHidden: true })
  const cell = (name: string) => dro.getByRole('cell', { name, includeHidden: true })
  const idle = () => expect(machine.getByText('Idle')).toBeVisible()

  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await idle()
  await expect(cell('Machine position Z')).toHaveText('-1.000')

  // a clicked step keeps no focus: the next Space is the Z+ jog key, not that step again
  await navigator.getByRole('radio', { name: '10 mm', exact: true }).click()
  await page.keyboard.press('Shift')
  await expect(cell('Machine position Z')).toHaveText('-11.000')
  await idle()
  const one = navigator.getByRole('radio', { name: '1 mm', exact: true })
  await one.click()
  await expect(one).not.toBeFocused()
  await page.keyboard.press('Space')
  await expect(cell('Machine position Z')).toHaveText('-10.000')
  await idle()

  // the work zero here, then away from it: 20 mm in X, 10 in Y, 10 below in Z
  for (const axis of ['X', 'Y', 'Z'])
    await dro.getByRole('button', { name: `Set ${axis} zero` }).click()
  await expect(cell('Work position Z')).toHaveText(/^-?0\.000/)
  await navigator.getByRole('radio', { name: '10 mm', exact: true }).click()
  for (const key of ['a', 'a', 's', 'Shift']) {
    await page.keyboard.press(key)
    await idle()
  }
  await expect(cell('Work position X')).toHaveText(/^-20\.000mm/)
  await expect(cell('Work position Z')).toHaveText(/^-10\.000mm/)

  // →0 X: up to the safe height (work Z 5, no plan) first, then X alone; Z stays up
  await dro.getByRole('button', { name: 'Go to work X zero' }).click()
  await expect(page.getByRole('dialog', { name: 'Go to' })).toHaveCount(0)
  await idle()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)
  await expect(cell('Work position Y')).toHaveText(/^-10\.000mm/)
  await expect(cell('Work position Z')).toHaveText(/^5\.000mm/)
  // →0 Y, then →0 Z (Z alone): at the work zero
  await dro.getByRole('button', { name: 'Go to work Y zero' }).click()
  await expect(cell('Work position Y')).toHaveText(/^-?0\.000/)
  await idle()
  await expect(page.getByRole('dialog', { name: 'Go to' })).toHaveCount(0)
  await dro.getByRole('button', { name: 'Go to work Z zero' }).click()
  await expect(cell('Work position Z')).toHaveText(/^-?0\.000/)
  await idle()
  await expect(cell('Work position X')).toHaveText(/^-?0\.000/)

  // the jog step and feed come back after a restart (remembered for this machine)
  await navigator.getByRole('radio', { name: '50 mm', exact: true }).click()
  const feed = navigator.getByRole('slider', { name: 'Jog feed' })
  await feed.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(feed).toHaveAttribute('aria-valuetext', '300 mm/min')
  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
  await closeApp(dfyom.app)

  const second = await launchApp(dfyom.dataDir)
  try {
    const page2 = await second.app.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const nav2 = page2.getByRole('navigation', { name: 'Navigator' })
    await nav2.getByRole('button', { name: 'Go to Run' }).click()
    await expect(nav2.getByRole('combobox', { name: 'Machine' })).toHaveText('Router')
    await expect(nav2.getByRole('radio', { name: '50 mm', exact: true })).toBeChecked()
    await expect(nav2.getByRole('slider', { name: 'Jog feed' })).toHaveAttribute(
      'aria-valuetext',
      '300 mm/min',
    )
    expect(second.rendererErrors).toEqual([])
  } finally {
    await closeApp(second.app)
  }
})
