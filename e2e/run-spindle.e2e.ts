// The spindle while jogging (v0.5 RV1) in the real app on the virtual machine (the GRBL emulator,
// no hardware): on in Idle after the confirmation, "Start spindle" refused in a jog with its reason,
// the cutting jog feed while it turns, and "Stop spindle" during a jog stopping both the jog and the
// spindle. Windows stay hidden (fixture). With DFYOM_SHOTS=<dir>: rv1-spindle-light.png there.
// Doc: docs/modes/run-machine.md#spindle-while-jogging-rv1
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

const SHOTS = process.env['DFYOM_SHOTS']

const ROUTER = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '600', z: '100' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'gcode', minSpeed: '6200', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  homingCorner: 'backRight',
  pullOff: '1',
  softLimits: true,
  probePlateThickness: '10',
}

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(
    ([n, a]) => (globalThis as unknown as { dfyom: PreloadApi }).dfyom.call(n, a),
    [name, args] as const,
  )
}

/** With DFYOM_SHOTS: `name`-light.png of the window in the light theme. */
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
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` })
}

test('RV1: spindle on in Idle, refused in a jog, Off during a jog stops both', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (SHOTS !== undefined) await page.setViewportSize({ width: 1280, height: 900 })
  const added = await call(page, 'library.machine.add', { values: ROUTER })
  expect(added.ok, JSON.stringify(added)).toBe(true)

  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const machine = page.getByRole('group', { name: 'Machine' })
  const state = navigator.getByRole('status', { name: /^Spindle: / })
  const start = navigator.getByRole('button', { name: 'Start spindle' })
  const stop = navigator.getByRole('button', { name: 'Stop spindle' })

  await navigator.getByRole('button', { name: 'Go to Run' }).click()
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '10×' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  // nothing starts on connect
  await expect(state).toHaveAccessibleName('Spindle: Off')
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(state).toHaveAccessibleName('Spindle: Off')

  // on in Idle, after the confirmation, at the slider's speed (the middle: 15000 rpm)
  await expect(navigator.getByRole('slider', { name: 'Spindle speed' })).toHaveAttribute(
    'aria-valuetext',
    '15000 rpm',
  )
  await start.click()
  const confirm = page.getByRole('alertdialog', { name: 'Start the spindle?' })
  await expect(confirm).toContainText('15000 rpm')
  await confirm.getByRole('button', { name: 'Start spindle' }).click()
  await expect(state).toHaveAccessibleName('Spindle: 15000 rpm · CW')
  // while it turns: the cutting jog feed; Home waits
  await expect(navigator.getByRole('slider', { name: 'Cutting jog feed' })).toHaveAttribute(
    'aria-valuetext',
    '600 mm/min',
  )
  await expect(navigator.getByRole('button', { name: 'Home' })).toBeDisabled()
  await shot(page, 'rv1-spindle')

  // off, then a long jog: Start is refused with its reason while it jogs
  await stop.click()
  await expect(state).toHaveAccessibleName('Spindle: Off')
  expect((await call(page, 'run.machine.jog', { by: [-300, 0, 0], feed: 400 })).ok).toBe(true)
  await expect(machine.getByText('Jogging')).toBeVisible()
  await expect(start).toBeDisabled()
  await expect(
    navigator.getByText('Stop the jog first: the spindle turns on only while the machine is idle.'),
  ).toBeVisible()
  // the host refuses it too, with the same words in the banner
  const refused = await call(page, 'run.machine.spindle', { on: true, rpm: 12000 })
  expect(refused.ok).toBe(false)
  await expect(page.getByText(/Stop the jog first/).first()).toBeVisible()
  expect((await call(page, 'run.machine.jogCancel')).ok).toBe(true)
  await expect(machine.getByText('Idle')).toBeVisible()

  // on again, then a jog with the spindle turning: Off stops the jog and the spindle
  await start.click()
  await page
    .getByRole('alertdialog', { name: 'Start the spindle?' })
    .getByRole('button', { name: 'Start spindle' })
    .click()
  await expect(state).toHaveAccessibleName(/^Spindle: 15000 rpm/)
  const jog = await call(page, 'run.machine.jog', { by: [0, -300, 0], feed: 400 })
  expect(jog.ok, JSON.stringify(jog)).toBe(true)
  await expect(machine.getByText('Jogging')).toBeVisible()
  await stop.click()
  await expect(state).toHaveAccessibleName('Spindle: Off')
  await expect(machine.getByText('Idle')).toBeVisible()

  await navigator.getByRole('button', { name: 'Disconnect' }).click()
  await expect(machine).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
