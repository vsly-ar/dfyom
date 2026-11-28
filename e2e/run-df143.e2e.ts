// Hardening DF143 on the virtual machine (hard limits on): the probe check (Probe Z waits until the
// probe input went touching → open: "Touch probe"), and for an advanced user a limit switch hit
// while jogging → "Unlock and back off" → jogging works again, the position unverified: Start run
// waits until homed. ("Finalize and start" runs on the loopback serial port: run-serial.e2e.ts.)
// Windows stay hidden (fixture).
// Docs: docs/modes/run-probing.md#probe-check-df143, docs/modes/run-machine.md#unlock-and-back-off-df143,
// docs/conventions/testing.md#end-to-end
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

async function press(page: Page, input: 'x' | 'y' | 'z', pressed: boolean) {
  const r = await page.evaluate(
    ([i, p]) => (globalThis as unknown as Dfyom).dfyom.run.simulateInput(i, p),
    [input, pressed] as const,
  )
  expect(r).toBeNull()
}

const FIXTURE = resolve(__dirname, '../src/core/run/__fixtures__/fusion-grbl.nc')

test('the probe check, then a limit hit while jogging: Unlock and back off, Start waits for homing (DF143)', async ({
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
      probePlateThickness: '10',
    },
  })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  // the "Advanced user" setting (Settings → Run)
  const set = await page.evaluate(() =>
    (globalThis as unknown as Dfyom).dfyom.settings.update({ advancedUser: true }),
  )
  expect(set.ok, JSON.stringify(set)).toBe(true)
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
  const cell = (name: string) =>
    inspector.getByRole('table', { name: 'Position' }).getByRole('cell', { name })
  const machineX = async () => parseFloat((await cell('Machine position X').textContent()) ?? '')

  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await navigator.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(machine.getByText(/^Virtual machine/)).toBeVisible()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible({ timeout: 60_000 })

  // the probe check: Probe Z waits, the probe input live beside it; "Touch probe" passes it
  const probeZ = navigator.getByRole('button', { name: 'Probe Z' })
  await expect(probeZ).toBeDisabled()
  const input = navigator.getByRole('group', { name: 'Probe input' })
  await expect(input.getByText('Touch the plate to the bit to test the probe.')).toBeVisible()
  await expect(input.getByText('Open', { exact: true })).toBeVisible()
  await input.getByRole('button', { name: 'Touch probe' }).click()
  await expect(input.getByText('Probe tested: probing is enabled.')).toBeVisible()
  await expect(probeZ).toBeEnabled()

  // a long X− jog at the virtual machine's real pace; the X limit switch closes on the way
  expect((await call(page, 'run.machine.jog', { by: [-300, 0, 0], feed: 3000 })).ok).toBe(true)
  await expect(machine.getByText('Jogging')).toBeVisible()
  await expect.poll(machineX).toBeLessThan(-20)
  await press(page, 'x', true)
  await expect(machine.getByText('Alarm 1: hard limit')).toBeVisible()
  const panel = navigator.getByRole('region', { name: 'Alarm' })
  await expect(panel.getByText(/jogs X\+ 3\.000 mm off the switch, slowly/)).toBeVisible()
  // the cells read "—" while not homed; GRBL reports nothing in the critical alarm, so this is the
  // last report before the switch stopped the jog (the axis went on a little X− after it)
  const now = await call(page, 'run.status.get')
  const x = ((now as Extract<CallReply, { ok: true }>).value as { mpos: number[] }).mpos[0]!
  await panel.getByRole('button', { name: 'Unlock and back off' }).click()
  await expect(panel).toBeHidden({ timeout: 30_000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  // 3 mm X+ from where it stopped: at most 3 mm past that last report
  await expect.poll(machineX).toBeGreaterThan(x - 10)
  const backedOff = await machineX()
  expect(backedOff).toBeLessThanOrEqual(x + 3 + 0.001)
  await expect(
    navigator.getByText('Position unverified — re-home before cutting', { exact: true }),
  ).toBeVisible()

  // jogging works again once the quiet time is over (refused meanwhile)
  await expect
    .poll(async () => (await call(page, 'run.machine.jog', { by: [-1, 0, 0], feed: 1000 })).ok, {
      timeout: 10_000,
      intervals: [500],
    })
    .toBe(true)
  await expect.poll(machineX).toBeCloseTo(backedOff - 1, 2)
  await expect(machine.getByText('Idle')).toBeVisible()

  // Start run waits for homing, and says why; the host refuses too
  const start = inspector.getByRole('button', { name: 'Start run' })
  await expect(start).toBeDisabled()
  await expect(start).toHaveAccessibleDescription(/the position is unverified/)
  // home again: verified, Start runs
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(navigator.getByText('Homed', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(machine.getByText('Idle')).toBeVisible()
  await expect(start).toBeEnabled()
})
