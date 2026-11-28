// Work area (v0.5 RV7) in the app against the fake bridge, `run.workArea.set` on the real
// dispatcher (the library machine): the Homing section opens it, Mark takes the position, a
// crossed mark is refused, the `$13n=` line to copy, Clear; axe.
// Spec: docs/modes/run.md#work-area-rv7
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Machine } from '../../../../core/library/machine'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { machineWorkArea } from '../../../../core/run/work-area'
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
  bridge.handle('run.machine.home', () => {
    queueMicrotask(() =>
      push({
        state: 'Idle',
        homed: true,
        envelope,
        mpos: [-1, -1, -1],
        wpos: [0, 0, 0],
        workZero: [-1, -1, -1],
      }),
    )
    return ok({ jobId: 'home-1' })
  })
  bridge.handle('job.wait', () => ok({ state: 'finished', outcome: { ok: true, value: {} } }))
  bridge.handle('run.machine.jog', () => ok({}))
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
  const library = () => {
    const found = s.library.lookup('machine', s.machineId)
    const v = found.state === 'found' ? found.item.values : undefined
    return v instanceof Machine ? machineWorkArea(v) : undefined
  }
  return { ...r, nav, push, library }
}

const dialog = () => screen.getByRole('dialog', { name: 'Work area' })

describe('Work area (v0.5 RV7)', () => {
  it('marks after homing, refuses a crossed mark, offers the $13n line, clears', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Work area…' }))
    // not homed yet: Mark waits, with the reason
    const markXmin = () => within(dialog()).getByRole('button', { name: 'Mark X min' })
    expect(markXmin()).toBeDisabled()
    expect(within(dialog()).getByText(/marks are machine coordinates/)).toBeInTheDocument()
    // homed (the dialog is modal: as if homed from the controller's own panel)
    t.push({ state: 'Idle', homed: true, envelope, mpos: [-1, -1, -1] })
    await waitFor(() => expect(markXmin()).toBeEnabled())
    // X max at the homed position, then X min after a jog to −780
    await t.user.click(within(dialog()).getByRole('button', { name: 'Mark X max' }))
    await waitFor(() =>
      expect(within(dialog()).getByText('-1.000 mm', { selector: '[data-mark="x-max"]' })),
    )
    t.push({ mpos: [-780, -1, -1] })
    await t.user.click(markXmin())
    await waitFor(() =>
      expect(t.library()).toEqual({ marks: { x: { min: -780, max: -1 } }, margin: 2 }),
    )
    // 779 mm from the switch at 0 against $130 = 800: the line to copy (Q219: never written)
    const line = await within(dialog()).findByRole('button', { name: 'Copy $130=780.000' })
    expect(line).toBeInTheDocument()
    expect(within(dialog()).getByText(/the controller allows 800.000 mm \(\$130\)/)).toBeVisible()
    // a min above the max is refused before anything is written
    t.push({ mpos: [0, -1, -1] })
    await t.user.click(within(dialog()).getByRole('button', { name: 'Mark X min' }))
    expect(await within(dialog()).findByText(/X min must stay below X max/)).toBeInTheDocument()
    await expectNoAxeViolations()
    // the margin is saved with the machine
    const margin = within(dialog()).getByRole('textbox', { name: /Margin/ })
    await t.user.clear(margin)
    await t.user.type(margin, '3{Enter}')
    await waitFor(() => expect(t.library()?.margin).toBe(3))
    // Clear: back to the travel
    await t.user.click(within(dialog()).getByRole('button', { name: 'Clear work area' }))
    await waitFor(() => expect(t.library()).toBeUndefined())
    expect(within(dialog()).queryByRole('button', { name: /Copy \$13/ })).toBeNull()
  })
})
