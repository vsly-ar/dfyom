// A limit switch hit after a completed run (hardening DF134, dogfood: "Reset (immediate) doesn't do
// anything and I can't unlock the machine") on the virtual machine (hard limits on): a gCode file
// runs to the end, then the X limit switch is pressed (ALARM:1, critical: Home and Unlock wait for
// the reset). Reset (immediate) → "reset done, still locked"; the switch still pressed is named and
// Home waits for its release; released → Home (recommended) or Unlock, the work zero kept, the run
// record still done (no recovery). Windows stay hidden (fixture).
// Docs: docs/modes/run-machine.md#after-a-hard-limit-df134, docs/conventions/testing.md#end-to-end
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { CallReply, PreloadApi } from '../src/shared/preload-api'
import { expect, test } from './app.fixture'

type Dfyom = { dfyom: PreloadApi }

async function call(page: Page, name: string, args: object = {}): Promise<CallReply> {
  // Runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`.
  return page.evaluate(([n, a]) => (globalThis as unknown as Dfyom).dfyom.call(n, a), [
    name,
    args,
  ] as const)
}

async function press(page: Page, input: 'x' | 'y' | 'z' | 'door', pressed: boolean) {
  const r = await page.evaluate(
    ([i, p]) => (globalThis as unknown as Dfyom).dfyom.run.simulateInput(i, p),
    [input, pressed] as const,
  )
  expect(r).toBeNull()
}

const FIXTURE = resolve(__dirname, '../src/core/run/__fixtures__/fusion-grbl.nc')

test('a hard limit after a completed run: reset, release the switch, home or unlock; G54 kept, no recovery (DF134)', async ({
  dfyom,
}) => {
  test.setTimeout(120_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
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
  const opened = await page.evaluate(
    (path) => (globalThis as unknown as Dfyom).dfyom.run.openFile(path),
    FIXTURE,
  )
  expect(opened).toMatchObject({ window: 'this' })
  await expect(page.getByRole('radio', { name: 'Run' })).toBeChecked()
  const navigator = page.getByRole('navigation', { name: 'Navigator' })
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.getByRole('button', { name: 'Inspector' }).click()
  const machine = page.getByRole('group', { name: 'Machine' })

  // connect, home, place the work zero and run the file to the end
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText('Virtual machine · Max')).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible()
  expect((await call(page, 'run.machine.jog', { by: [-400, -300, -60], feed: 5000 })).ok).toBe(true)
  const cell = (name: string) =>
    inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })
  await expect(cell('Machine position Z')).toHaveText('-61.000', { timeout: 30_000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  expect((await call(page, 'run.workZero.set', { axes: ['x', 'y', 'z'] })).ok).toBe(true)
  const status = () =>
    page.evaluate(() => (globalThis as unknown as Dfyom).dfyom.call('run.status.get', {}))
  const zeroOf = async () =>
    ((await status()) as Extract<CallReply, { ok: true }>).value as { workZero: number[] }
  const workZero = (await zeroOf()).workZero
  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await preflight.getByRole('button', { name: 'Start run' }).click()
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: \d+ lines in/)
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 60_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  await expect(machine.getByText('Idle')).toBeVisible()

  // cleaning the machine: the X limit switch is pressed and let go
  await press(page, 'x', true)
  await expect(machine.getByText('Alarm 1: hard limit')).toBeVisible()
  const home = navigator.getByRole('button', { name: 'Home' })
  const unlock = navigator.getByRole('button', { name: 'Unlock' })
  await expect(home).toBeDisabled()
  await expect(unlock).toBeDisabled()
  await expect(
    navigator.getByText('Reset the machine first (Reset (immediate)), then home it.'),
  ).toBeVisible()
  // a pressed switch is ignored in the alarm; pressed again before the reset (still held)
  await press(page, 'x', false)
  await press(page, 'x', true)

  // Reset (immediate): the controller restarts locked, the held switch is named
  await inspector.getByRole('button', { name: 'Reset (immediate)' }).click()
  const panel = navigator.getByRole('region', { name: 'Alarm' })
  await expect(
    panel.getByRole('heading', { name: 'Alarm 1: reset done, still locked' }),
  ).toBeVisible()
  await expect(panel.getByText('Inputs active: X limit switch')).toBeVisible()
  await expect(panel.getByText(/^The X limit switch is still pressed\. Release it/)).toBeVisible()
  await expect(navigator.getByText('Release the X limit switch first.')).toBeVisible()
  await expect(home).toBeDisabled()
  await expect(unlock).toBeEnabled()

  // released: Home (recommended) or Unlock, one line why
  await press(page, 'x', false)
  await expect(panel.getByText(/^Home the machine \(recommended\)/)).toBeVisible()
  await expect(panel.getByText(/Inputs active/)).toBeHidden()
  await expect(home).toBeEnabled()
  await expect(unlock).toBeEnabled()
  await home.click()
  await expect(machine.getByText('Idle')).toBeVisible({ timeout: 30_000 })
  await expect(panel).toBeHidden()
  await expect(navigator.getByText('Homed', { exact: true })).toBeVisible()
  // GRBL keeps G54 (EEPROM); the completed run is no interruption
  expect((await zeroOf()).workZero).toEqual(workZero)
  const record = await page.evaluate(() => (globalThis as unknown as Dfyom).dfyom.run.record())
  expect(record?.state ?? 'done').toBe('done')
  await expect(page.getByRole('dialog', { name: 'The run was interrupted' })).toBeHidden()
  await expect(page.getByRole('region', { name: /recover/i })).toHaveCount(0)
  expect(dfyom.rendererErrors).toEqual([])
})
