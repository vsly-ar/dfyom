// Run mode UI against the fake bridge: a project with a real plan (core plan fixture) and a
// scripted machine that answers the run commands and pushes statuses as main does.
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #testing
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

interface Machine {
  status: RunStatus
  push(patch: Partial<RunStatus>): void
  progress: { done: number; total: number; label: string }
  outcome: { ok: true; value: unknown } | { ok: false; error: AppErrorData } | undefined
}

/** Answers the run commands like main and the virtual machine would, and pushes statuses. */
function scriptMachine(bridge: FakeBridge): Machine {
  const m: Machine = {
    status: closedStatus(),
    push(patch) {
      m.status = { ...m.status, ...patch }
      act(() => bridge.emitRunStatus(m.status))
    },
    progress: { done: 0, total: 20, label: 'facing1 · tool 1: Flat 6' },
    outcome: undefined,
  }
  const job = (phase: NonNullable<RunStatus['job']>['phase'], extra = {}) => ({
    job: {
      jobId: 'run-1',
      phase,
      line: m.progress.done + 1,
      startedAt: '2026-11-20T10:00:00Z',
      elapsedSeconds: 65,
      ...extra,
    },
  })
  bridge.handle('run.status.get', () => ok(m.status))
  bridge.handle('run.connection.open', (a) => {
    const { timeScale } = a as { timeScale: number | 'max' }
    queueMicrotask(() =>
      m.push({ connection: { state: 'open', target: 'virtual', timeScale }, state: 'Alarm' }),
    )
    return ok({})
  })
  bridge.handle('run.connection.close', () => {
    queueMicrotask(() => m.push(closedStatus()))
    return ok({})
  })
  bridge.handle('run.machine.home', () => {
    queueMicrotask(() => m.push({ state: 'Idle', homed: true, mpos: [-1, -1, -1] }))
    return ok({ jobId: 'home-1' })
  })
  bridge.handle('job.wait', () => ok({ state: 'finished', outcome: { ok: true, value: {} } }))
  bridge.handle('run.machine.jog', () => ok({}))
  bridge.handle('run.machine.jogCancel', () => ok({}))
  bridge.handle('run.machine.unlock', () => ok({}))
  bridge.handle('run.workZero.set', () => {
    queueMicrotask(() => m.push({ workZero: m.status.mpos, wpos: [0, 0, 0] }))
    return ok({ workZero: m.status.mpos })
  })
  bridge.handle('run.job.start', () => {
    queueMicrotask(() => m.push({ state: 'Run', ...job('streaming') }))
    return ok({ jobId: 'run-1' })
  })
  bridge.handle('job.get', () =>
    ok(
      m.outcome
        ? { state: 'finished', progress: m.progress, outcome: m.outcome }
        : { state: 'running', progress: m.progress },
    ),
  )
  bridge.handle('job.pause', () => {
    queueMicrotask(() => m.push({ state: 'Hold:0', ...job('held') }))
    return ok({})
  })
  bridge.handle('job.resume', () => {
    queueMicrotask(() => m.push({ state: 'Run', ...job('streaming') }))
    return ok({})
  })
  bridge.handle('job.abort', () => ok({}))
  bridge.handle('run.job.continue', () => ok({}))
  bridge.handle('run.machine.reset', () => ok({}))
  return Object.assign(m, { job })
}

async function renderRun() {
  const s = await planSetup()
  await s.create()
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const machine = scriptMachine(bridge) as Machine & {
    job: (phase: NonNullable<RunStatus['job']>['phase'], extra?: object) => Partial<RunStatus>
  }
  const shell = createShell(bridge)
  shell.ui.getState().setMode('run')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  await within(nav()).findByRole('button', { name: 'Connect to virtual machine' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  return { ...r, bridge, machine, nav, callsOf }
}

const machineGroup = () => screen.queryByRole('group', { name: 'Machine' })

/** Presses Tab until `target` has the focus (the dialog traps it, so Tab wraps); fails if never. */
async function tabTo(t: Awaited<ReturnType<typeof renderRun>>, target: HTMLElement) {
  for (let i = 0; i < 30 && document.activeElement !== target; i++) await t.user.tab()
  expect(target).toHaveFocus()
}

async function connectAndHome(t: Awaited<ReturnType<typeof renderRun>>) {
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect to virtual machine' }))
  await screen.findByRole('group', { name: 'Machine' })
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }))
  await within(machineGroup()!).findByText('Idle')
}

describe('Run mode', () => {
  it('connects to the virtual machine; the badge, chip and Stop then show in every mode', async () => {
    const t = await renderRun()
    expect(machineGroup()).toBeNull()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect to virtual machine' }))
    expect(t.callsOf('run.connection.open')).toEqual([
      { target: 'virtual', planId: expect.any(String), timeScale: 1 },
    ])
    const group = await screen.findByRole('group', { name: 'Machine' })
    expect(within(group).getByText('Alarm')).toHaveAttribute('data-state', 'alarm')
    expect(within(group).getByText('Virtual machine · 1×')).toBeInTheDocument()
    for (const mode of ['Design', 'Plan', 'Run']) {
      await t.user.click(screen.getByRole('radio', { name: mode }))
      expect(within(machineGroup()!).getByRole('button', { name: 'Stop' })).toBeVisible()
    }
    // in Alarm, jog and work zero say why they are disabled
    expect(within(t.nav()).getByRole('button', { name: 'Jog X+' })).toBeDisabled()
    expect(within(t.nav()).getAllByText('Home the machine first.').length).toBeGreaterThan(0)
    await expectNoAxeViolations()
  })

  it('homes, jogs by the chosen step and sets the work zero', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    expect(within(t.nav()).getByText('Homed')).toBeInTheDocument()
    await t.user.click(within(t.nav()).getByRole('radio', { name: '100 mm' }))
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog X−' }))
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog Z+' }))
    expect(t.callsOf('run.machine.jog')).toEqual([
      { by: [-100, 0, 0], feed: 2000 },
      { by: [0, 0, 100], feed: 500 },
    ])
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Zero X Y Z' }))
    expect(t.callsOf('run.workZero.set')).toEqual([{ axes: ['x', 'y', 'z'] }])
  })

  it('unlock asks first: the position is not known until homed', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect to virtual machine' }))
    await screen.findByRole('group', { name: 'Machine' })
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Unlock' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Unlock without homing?' })
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await t.user.click(within(confirm).getByRole('button', { name: 'Unlock' }))
    expect(t.callsOf('run.machine.unlock')).toHaveLength(1)
  })

  it('starts through the pre-flight dialog; progress, Escape = feed hold, resume, stop', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    expect(within(preflight).getAllByRole('listitem').length).toBeGreaterThan(0)
    expect(within(preflight).getByText('Virtual machine at 1×')).toBeInTheDocument()
    const start = within(preflight).getByRole('button', { name: 'Start run' })
    expect(start).toHaveFocus()
    await expectNoAxeViolations()
    await t.user.click(start)
    expect(t.callsOf('run.job.start')).toHaveLength(1)

    t.machine.progress = { done: 5, total: 20, label: 'pocket1 · tool 1: Flat 6' }
    await within(inspector).findByText('Line 5 / 20', {}, { timeout: 2000 })
    expect(within(inspector).getByText('pocket1 · tool 1: Flat 6')).toBeInTheDocument()
    expect(within(inspector).getByText('01:05')).toBeInTheDocument()
    expect(within(inspector).getByRole('progressbar', { name: 'Run progress' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    )
    const group = machineGroup()!
    expect(within(group).getByText('Running')).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Feed hold' })).toBeInTheDocument()

    // Escape holds the feed wherever the focus is
    await t.user.keyboard('{Escape}')
    expect(t.callsOf('job.pause')).toEqual([{ jobId: 'run-1' }])
    await within(group).findByText('Feed hold', { selector: '[data-state]' })
    // resume only while held; never a single key
    await t.user.click(within(group).getByRole('button', { name: 'Resume' }))
    expect(t.callsOf('job.resume')).toEqual([{ jobId: 'run-1' }])
    // stop is never confirmed
    await t.user.click(within(group).getByRole('button', { name: 'Stop' }))
    expect(t.callsOf('job.abort')).toEqual([{ jobId: 'run-1' }])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('tool change: dialog with steps, Later to the inspector, Continue names the wait', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.machine.push({
      state: 'Idle',
      ...t.machine.job('toolChange', { toolChange: { n: 2, name: 'Drill 6' } }),
    })
    const dialog = await screen.findByRole('dialog', { name: 'Tool change 2' })
    expect(within(dialog).getByText('Change to Drill 6.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Jog Z+' })).toBeEnabled()
    expect(within(machineGroup()!).getByText('Tool change')).toHaveAttribute('data-state', 'action')
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog', { name: 'Tool change 2' })).toBeNull()

    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText('Waiting for tool change 2: Drill 6')).toBeInTheDocument()
    await t.user.click(within(inspector).getByRole('button', { name: 'Show instructions' }))
    const again = screen.getByRole('dialog', { name: 'Tool change 2' })
    await t.user.click(within(again).getByRole('button', { name: 'Continue' }))
    expect(t.callsOf('run.job.continue')).toEqual([{ jobId: 'run-1', toolChange: 2 }])
  })

  it('a failed run opens a blocking dialog with what happened and what to do next', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.machine.push({ state: 'Run', ...t.machine.job('streaming') })
    t.machine.outcome = {
      ok: false,
      error: {
        code: 'machine.alarm',
        message: 'ALARM:2',
        issues: [],
        frames: [{ where: 'run', data: { code: 2, line: 42 } }],
      },
    }
    t.machine.push({ state: 'Alarm', homed: false, alarm: { code: 2, text: 'Soft limit.' } })
    const dialog = await screen.findByRole('dialog', { name: 'Machine alarm 2' }, { timeout: 2000 })
    expect(within(dialog).getByText('At line 42.')).toBeInTheDocument()
    expect(within(dialog).getByText(/Home the machine again/)).toBeInTheDocument()
    expect(within(machineGroup()!).getByText('Alarm 2: soft limit')).toBeInTheDocument()
    await t.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('every run dialog carries its own Stop, reachable by keyboard while the dialog is modal', async () => {
    const t = await renderRun()
    await connectAndHome(t)

    // pre-flight: Stop leads the footer; with a jog under way it cancels the jog
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    expect(within(preflight).getByRole('button', { name: 'Start run' })).toHaveFocus()
    t.machine.push({ state: 'Jog' })
    await tabTo(t, within(preflight).getByRole('button', { name: 'Stop' }))
    await t.user.keyboard('{Enter}')
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1)
    await expectNoAxeViolations()
    await t.user.click(within(preflight).getByRole('button', { name: 'Cancel' }))
    t.machine.push({ state: 'Idle' })

    // program pause: Later has the first focus (never Stop or Continue); Stop aborts the run
    t.machine.push({ state: 'Hold:0', ...t.machine.job('programPause', { pause: 1 }) })
    const pause = await screen.findByRole('dialog', { name: /Program pause/ })
    expect(within(pause).getByRole('button', { name: 'Later' })).toHaveFocus()
    await tabTo(t, within(pause).getByRole('button', { name: 'Stop' }))
    await t.user.keyboard('{Enter}')
    expect(t.callsOf('job.abort')).toEqual([{ jobId: 'run-1' }])
    await expectNoAxeViolations()

    // tool change: the same Stop, pressed with Space
    t.machine.push({
      state: 'Idle',
      ...t.machine.job('toolChange', { toolChange: { n: 2, name: 'Drill 6' } }),
    })
    const change = await screen.findByRole('dialog', { name: 'Tool change 2' })
    await tabTo(t, within(change).getByRole('button', { name: 'Stop' }))
    await t.user.keyboard(' ')
    expect(t.callsOf('job.abort')).toEqual([{ jobId: 'run-1' }, { jobId: 'run-1' }])
  })

  it('the failure dialog carries Stop too and focuses Close first', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.machine.push({ state: 'Run', ...t.machine.job('streaming') })
    t.machine.outcome = {
      ok: false,
      error: { code: 'machine.error', message: 'error:20', issues: [], frames: [] },
    }
    t.machine.push({ state: 'Idle' })
    const dialog = await screen.findByRole(
      'dialog',
      { name: /stopped with an error/ },
      { timeout: 2000 },
    )
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    await tabTo(t, within(dialog).getByRole('button', { name: 'Stop' }))
    await expectNoAxeViolations()
  })

  it('stop without a run cancels a jog', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.machine.push({ state: 'Jog' })
    await within(machineGroup()!).findByText('Jogging')
    await t.user.click(within(machineGroup()!).getByRole('button', { name: 'Stop' }))
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1)
  })
})
