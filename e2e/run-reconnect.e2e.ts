// Auto-reconnect in the real app (hardening DF129, RC4) on the virtual machine: a gCode file runs,
// "Simulate a lost connection" pulls the virtual cable mid-run, the navigator says "Reconnecting…
// attempt n" (polite), then "Reconnected — machine needs homing": the controller restarted, locked
// and not homed, nothing moved; the run record says interrupted (connectionLost). Windows stay
// hidden (fixture). Docs: docs/modes/run-recovery.md#implementation-rc4,
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

const FIXTURE = resolve(__dirname, '../src/core/run/__fixtures__/fusion-grbl.nc')

test('a lost connection mid-run reconnects by itself: reconnecting → reconnected, needs homing, record interrupted (DF129 RC4)', async ({
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

  // connect, home and zero quickly, then run at real time so the run lasts
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
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: '1×' }).click()

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await preflight.getByRole('button', { name: 'Start run' }).click()
  const toolChange = page.getByRole('dialog', { name: 'Tool change 1' })
  await expect(toolChange).toBeVisible({ timeout: 30_000 })
  await toolChange.getByRole('button', { name: 'Continue' }).click()
  await expect(toolChange).toBeHidden()
  await expect(machine.getByText('Run')).toBeVisible({ timeout: 30_000 })

  // every reconnect phase the status pushes, in order
  await page.evaluate(() => {
    const g = globalThis as unknown as Dfyom & { phases: string[] }
    g.phases = []
    g.dfyom.run.onStatus((s) => {
      const phase = s.connection.reconnect?.phase
      if (phase !== undefined && g.phases.at(-1) !== phase) g.phases.push(phase)
    })
  })
  // practise: the virtual cable is pulled mid-run
  await navigator.getByRole('button', { name: 'Simulate a lost connection' }).click()
  // the run failed with the lost connection (RC5 replaces this dialog with the recovery panel)
  const failure = page.getByRole('dialog', { name: 'The run stopped with an error' })
  await expect(failure).toBeVisible()
  await failure.getByRole('button', { name: 'Close' }).click()
  const reconnect = navigator.getByRole('status', { name: 'Reconnecting' })
  await expect(
    reconnect.getByText(/^Reconnecting… attempt \d+$|^Reconnected — machine needs homing$/),
  ).toBeVisible()
  await expect(reconnect.getByText('Reconnected — machine needs homing')).toBeVisible({
    timeout: 30_000,
  })
  const phases = await page.evaluate(() => (globalThis as unknown as { phases: string[] }).phases)
  // tried (the simulated cable stays out 2.5 s: an attempt failed first), then reconnected
  expect(phases[0]).toBe('waiting')
  expect(phases.filter((p) => p === 'connecting').length).toBeGreaterThanOrEqual(2)
  expect(phases.at(-1)).toBe('reconnected')
  // the controller restarted: GRBL's start-up lock, not homed; DFYOM moved nothing
  await expect(machine.getByText('Needs homing')).toBeVisible()
  await expect(navigator.getByText('Not homed')).toBeVisible()
  const before = await cell('Machine position X').textContent()
  await page.waitForTimeout(1000)
  expect(await cell('Machine position X').textContent()).toBe(before)
  const record = await page.evaluate(() => (globalThis as unknown as Dfyom).dfyom.run.record())
  expect(record).toMatchObject({
    state: 'interrupted',
    reason: 'connectionLost',
    machine: { target: 'virtual' },
  })
  expect(record?.progress.sent).toBeGreaterThan(0)
  // homing clears "Reconnected"
  await navigator.getByRole('combobox', { name: 'Time scale' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await navigator.getByRole('button', { name: 'Home' }).click()
  await expect(machine.getByText('Idle')).toBeVisible({ timeout: 60_000 })
  await expect(reconnect).toBeEmpty()
  expect(dfyom.rendererErrors).toEqual([])
})
