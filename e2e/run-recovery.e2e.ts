// The recovery panel in the real app (hardening DF129, RC5) on the virtual machine: a gCode file
// runs, "Simulate a lost connection" pulls the virtual cable mid-run; the failure dialog is the
// short sheet "The run was interrupted"; the Run inspector's panel says what happened, where the
// job was (the last position, the lines) and the live reconnect state; once reconnected the user
// ticks the checklist, homes from the panel, sees the work zero kept, goes to the last position
// (GoTo's safe order, confirmed), chooses "Resume near where it stopped": the pre-flight starts at
// the suggested line, the lead-in waits at the tool, the rest runs to the end and ends Idle.
// With DFYOM_RENDERS=1 light and dark renders go to design/features/renders (or DFYOM_RENDERS_DIR)
// as df129-recovery-*.png. Windows stay hidden (fixture). Selectors are roles and accessible names.
// Docs: docs/modes/run-recovery.md#implementation-rc5, docs/conventions/testing.md#end-to-end
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { RunStatus } from '../src/core/run/service'
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
const RENDERS = process.env['DFYOM_RENDERS'] === '1'
const rendersDir =
  process.env['DFYOM_RENDERS_DIR'] ?? resolve(__dirname, '../design/features/renders')

async function render(page: Page, name: string): Promise<void> {
  if (!RENDERS) return
  for (const theme of ['light', 'dark'] as const) {
    // runs in the renderer; this tsconfig has no DOM lib, hence `globalThis`
    await page.evaluate((t) => {
      const doc = (
        globalThis as unknown as {
          document: { documentElement: { setAttribute(n: string, v: string): void } }
        }
      ).document
      doc.documentElement.setAttribute('data-theme', t)
    }, theme)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${rendersDir}/${name}-${theme}.png` })
  }
}

test('an interrupted run: the sheet, the recovery panel, reconnect, home, resume near where it stopped, run to Idle (DF129 RC5)', async ({
  dfyom,
}) => {
  test.setTimeout(240_000)
  const page = await dfyom.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1000 })
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
  const timeScale = async (name: string) => {
    await navigator.getByRole('combobox', { name: 'Time scale' }).click()
    await page.getByRole('option', { name }).click()
  }

  // connect, home and zero quickly, then run at real time so the run lasts
  await navigator.getByRole('radio', { name: 'Virtual machine' }).click()
  await timeScale('Max')
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
  await timeScale('1×')

  await inspector.getByRole('button', { name: 'Start run' }).click()
  const preflight = page.getByRole('dialog', { name: 'Start run?' })
  await preflight.getByRole('button', { name: 'Start run' }).click()
  const toolChange = page.getByRole('dialog', { name: 'Tool change 1' })
  await expect(toolChange).toBeVisible({ timeout: 30_000 })
  await toolChange.getByRole('button', { name: 'Continue' }).click()
  await expect(toolChange).toBeHidden()
  await expect(machine.getByText('Run')).toBeVisible({ timeout: 30_000 })
  // let it cut a little
  await page.waitForTimeout(2500)

  // practise: the virtual cable is pulled mid-run
  await navigator.getByRole('button', { name: 'Simulate a lost connection' }).click()
  const sheet = page.getByRole('dialog', { name: 'The run was interrupted' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/^The USB connection dropped at/)).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'The run stopped with an error' })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Show the steps' }).click()
  await expect(sheet).toBeHidden()

  // the panel: what happened, where the job was, the reconnect state
  const panel = inspector.getByRole('region', { name: 'The run was interrupted' })
  await expect(panel).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Start run' })).toHaveCount(0)
  await expect(panel.getByText(/^It was cutting around line/)).toBeVisible()
  await expect(panel.getByText('Last seen')).toBeVisible()
  const status = (await call(page, 'run.status.get')) as Extract<CallReply, { ok: true }>
  const i = (status.value as RunStatus).lastRun?.interruption
  expect(i).toMatchObject({ reason: 'connectionLost', executingFrom: expect.any(String) })
  expect(i!.executing).toBeGreaterThan(0)
  const suggested = i!.suggestion!.line
  // the last resume point at or before the executing line; before the first one, the first
  expect(suggested).toBeLessThanOrEqual(Math.max(i!.executing, i!.safest!.line))
  const steps = panel.getByRole('list', { name: 'Steps' })
  // reconnected by itself (the simulated cable stays out 2.5 s): step 1 ticks, the checklist opens
  await expect(steps.getByRole('button', { name: /Check the machine/ })).toHaveAttribute(
    'aria-expanded',
    'true',
    { timeout: 30_000 },
  )
  await expect(panel.getByText(/^Reconnected\. The controller restarted/)).toBeVisible()
  await expect(machine.getByText('Needs homing')).toBeVisible()
  for (const name of [/The bit is intact/, /The stock has not moved/, /Chips are cleared/])
    await panel.getByRole('checkbox', { name }).click()
  await panel.getByRole('button', { name: 'Checked' }).click()

  // home from the panel (fast), then the work zero is the run's
  await timeScale('Max')
  await panel.getByRole('button', { name: 'Home the machine' }).click()
  await expect(machine.getByText('Idle')).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByText(/^The controller kept the work zero/)).toBeVisible()
  // over the last position, above the stock: planned in GoTo's safe order, confirmed first
  await panel.getByRole('button', { name: 'Go to the last position' }).click()
  const go = page.getByRole('dialog', { name: 'Go to the last position?' })
  // homed: the bit is high already, so across first, then down to the safe height above the stock
  await expect(go.getByRole('listitem')).toHaveText([/^Across to X /, /^Down to Z /])
  await go.getByRole('button', { name: 'Move' }).click()
  await expect(go).toBeHidden()
  await expect(machine.getByText('Idle')).toBeVisible({ timeout: 30_000 })
  const at = (await call(page, 'run.status.get')) as Extract<CallReply, { ok: true }>
  const mpos = (at.value as RunStatus).mpos
  expect(mpos[0]).toBeCloseTo(i!.lastReport!.mpos[0], 2)
  expect(mpos[1]).toBeCloseTo(i!.lastReport!.mpos[1], 2)
  await panel.getByRole('button', { name: 'The work zero is right' }).click()

  // the options: the suggestion first, recommended
  const near = panel.getByRole('button', { name: /Resume near where it stopped/ })
  await expect(near).toContainText('Recommended')
  await expect(near).toContainText(`line ${suggested}`)
  // the whole panel in view for the renders: a tall window, the panel's top at the top
  if (RENDERS) {
    await page.setViewportSize({ width: 1440, height: 1500 })
    await panel.evaluate((e) => (e as unknown as { scrollIntoView(): void }).scrollIntoView())
  }
  await render(page, 'df129-recovery')
  await near.click()

  // the RC3 pre-flight at the suggested line; the lead-in waits at the tool; then to the end
  const start = preflight.getByRole('button', {
    name: `Start at line ${suggested.toLocaleString('en-GB')}`,
  })
  await expect(start).toBeEnabled({ timeout: 30_000 })
  await start.click()
  await expect(panel).toHaveCount(0)
  const waits = () => page.getByRole('dialog', { name: /^(Tool change|Program pause) \d+$/ })
  const complete = page.getByText(/^Run complete: [\d,]+ lines in/)
  await expect(waits()).toBeVisible({ timeout: 30_000 })
  await expect(waits().getByText(/^This is the start’s tool wait/)).toBeVisible()
  for (;;) {
    await expect(waits().or(complete)).toBeVisible({ timeout: 120_000 })
    if (await complete.isVisible()) break
    const title = (await waits().getByRole('heading').first().textContent()) ?? ''
    await waits().getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog', { name: title })).toBeHidden()
  }
  await expect(machine.getByText('Idle')).toBeVisible()
  const after = (await call(page, 'run.status.get')) as Extract<CallReply, { ok: true }>
  expect((after.value as RunStatus).lastRun?.interruption).toBeUndefined()
  expect(dfyom.rendererErrors).toEqual([])
})
