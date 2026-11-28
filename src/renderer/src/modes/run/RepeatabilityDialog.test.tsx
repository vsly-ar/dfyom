// Homing repeatability (v0.5 RV8) in the app against the fake bridge: the Homing section opens
// it, Start waits for homing and a start, Use this position takes the MPos, the test's result
// (spread per axis, pass/fail) is kept per machine with the date, the lost-steps check; axe.
// Spec: docs/modes/run-machine.md#homing-repeatability-rv8
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })
const envelope = {
  travel: [800, 600, 100] as [number, number, number],
  homingMask: 0,
  pullOff: 1,
  softLimits: true,
}

async function renderRun() {
  const s = await planSetup()
  await s.create({ machineLibraryItemId: s.machineId })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  let status: RunStatus = closedStatus()
  const push = (patch: Partial<RunStatus>) => {
    status = { ...status, ...patch }
    act(() => bridge.emitRunStatus(status))
  }
  bridge.handle('run.status.get', () => ok(status))
  bridge.handle('run.connection.open', () => {
    queueMicrotask(() =>
      push({ connection: { state: 'open', target: 'virtual', timeScale: 1 }, state: 'Alarm' }),
    )
    return ok({})
  })
  const calls: { name: string; args: unknown }[] = []
  let outcome: unknown = { ok: true, value: {} }
  bridge.handle('run.machine.repeatability', (args) => {
    calls.push({ name: 'run.machine.repeatability', args })
    return ok({ jobId: 'rep-1' })
  })
  bridge.handle('job.get', () =>
    ok({ state: 'running', progress: { done: 1, total: 5, label: 'probe' } }),
  )
  bridge.handle('job.wait', (args) =>
    ok({
      state: 'finished',
      outcome: (args as { jobId: string }).jobId === 'rep-1' ? outcome : { ok: true, value: {} },
    }),
  )
  const setOutcome = (o: unknown) => {
    outcome = o
  }
  const shell = createShell(bridge)
  shell.ui.getState().setMode('run')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  await within(nav()).findByRole('button', { name: 'Connect' })
  await r.user.click(within(nav()).getByRole('radio', { name: 'Virtual machine' }))
  await r.user.click(within(nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  return { ...r, nav, push, bridge, calls, setOutcome, machineId: s.machineId }
}

const dialog = () => screen.getByRole('dialog', { name: 'Homing repeatability' })

const axis = (spread: number, mean: number) => ({ spread, stdDev: spread / 3, mean })

describe('Homing repeatability (v0.5 RV8)', () => {
  it('takes the start, runs the test, keeps the result per machine; the lost-steps check', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Test homing repeatability…' }))
    const start = () => within(dialog()).getByRole('button', { name: 'Start test' })
    expect(start()).toBeDisabled()
    expect(start()).toHaveAccessibleDescription('Home the machine first.')
    t.push({ state: 'Idle', homed: true, envelope, mpos: [-300, -200, -60] })
    const useHere = within(dialog()).getByRole('button', { name: 'Use this position' })
    await waitFor(() => expect(useHere).toBeEnabled())
    expect(start()).toBeDisabled() // no start yet
    await t.user.click(useHere)
    expect(within(dialog()).getByText(/Start: X -300.000 Y -200.000 Z -60.000 mm/)).toBeVisible()
    t.setOutcome({
      ok: true,
      value: {
        readings: [{ z: -65 }, { z: -65.012 }],
        axes: { z: axis(0.012, -65.006) },
        pass: true,
        worst: 0.012,
      },
    })
    await t.user.click(start())
    await waitFor(() =>
      expect(within(dialog()).getByRole('table', { name: 'Result' })).toBeVisible(),
    )
    expect(t.calls[0]?.args).toMatchObject({
      at: [-300, -200, -60],
      cycles: 5,
      probe: { kind: 'zPlate', tipDiameter: 0 },
    })
    const row = within(dialog()).getByRole('row', { name: /^Z/ })
    expect(row).toHaveTextContent('0.012')
    expect(within(dialog()).getByText(/Pass: every spread under 0.020 mm/)).toBeVisible()
    const saved = t.bridge.settingsPatches.at(-1) as {
      homingRepeatability: Record<string, { pass: boolean; date: string; at: number[] }>
    }
    expect(saved.homingRepeatability[t.machineId]).toMatchObject({
      pass: true,
      at: [-300, -200, -60],
    })
    expect(Date.parse(saved.homingRepeatability[t.machineId]!.date)).not.toBeNaN()
    await expectNoAxeViolations()
    // the lost-steps check: one probe without homing, the drift from the means
    t.setOutcome({
      ok: true,
      value: { readings: [{ z: -65.106 }], axes: {}, pass: false, worst: 0 },
    })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Check for lost steps' }))
    expect(await within(dialog()).findByText(/Steps were lost/)).toBeVisible()
    expect(t.calls[1]?.args).toMatchObject({ cycles: 1, home: false })
    expect(within(dialog()).getByText(/Z -0.100 mm/)).toBeVisible()
    // over 0.02 mm: the advice instead of Pass
    t.setOutcome({
      ok: true,
      value: {
        readings: [{ z: -65 }, { z: -65.05 }],
        axes: { z: axis(0.05, -65.025) },
        pass: false,
        worst: 0.05,
      },
    })
    await t.user.click(start())
    expect(
      await within(dialog()).findByText(/Over 0.020 mm: check the homing switches/),
    ).toBeVisible()
  })
})
