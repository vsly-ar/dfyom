// Run mode UI against the fake bridge: a project with a real plan (core plan fixture) and a
// scripted machine that answers the run commands and pushes statuses as main does.
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #testing
import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
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
  /** `softLimit` findings `run.job.check` answers (DF46). */
  findings: { rule: string; params: Record<string, number | string> }[]
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
    findings: [],
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
  bridge.handle('run.job.check', () => ok({ setupId: 's', findings: m.findings }))
  bridge.handle('run.machine.reset', () => ok({}))
  bridge.handle('run.machine.probeZ', () => ok({ jobId: 'probe-1' }))
  bridge.handle('run.override.set', () => ok({}))
  return Object.assign(m, { job })
}

async function renderRun(opts: { bottom?: boolean; plate?: string } = {}) {
  const s = await planSetup()
  // a touch plate on the library machine, copied into the plan (M4)
  if (opts.plate !== undefined)
    await s.run('library.machine.update', {
      id: s.machineId,
      revision: 1,
      values: { ...libraryInput(machineValues()), probePlateThickness: opts.plate },
    })
  // a bottom facing too: setups Bottom, Top (task E2)
  if (opts.bottom === true)
    await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create(
    opts.plate === undefined ? {} : { machineLibraryItemId: s.machineId },
  )
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
  await within(nav()).findByRole('button', { name: 'Connect' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  return { ...r, bridge, machine, nav, callsOf, plan: () => s.plan(planId) }
}

const machineGroup = () => screen.queryByRole('group', { name: 'Machine' })

/** Presses Tab until `target` has the focus (the dialog traps it, so Tab wraps); fails if never. */
async function tabTo(t: Awaited<ReturnType<typeof renderRun>>, target: HTMLElement) {
  for (let i = 0; i < 30 && document.activeElement !== target; i++) await t.user.tab()
  expect(target).toHaveFocus()
}

async function connectAndHome(t: Awaited<ReturnType<typeof renderRun>>) {
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
  await screen.findByRole('group', { name: 'Machine' })
  await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }))
  await within(machineGroup()!).findByText('Idle')
}

describe('Run mode', () => {
  it('says once why the disconnected controls are disabled, and each control points at it', async () => {
    const t = await renderRun()
    const why = within(t.nav()).getByText('Connect to a machine first.')
    for (const name of ['Home', 'Jog X+', 'Zero X', 'Zero X Y Z']) {
      const button = within(t.nav()).getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-describedby', why.id)
    }
  })

  it('connects to the virtual machine; the badge, chip and Stop then show in every mode', async () => {
    const t = await renderRun()
    expect(machineGroup()).toBeNull()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
    expect(t.callsOf('run.connection.open')).toEqual([
      { target: 'virtual', planId: expect.any(String), timeScale: 1 },
    ])
    const group = await screen.findByRole('group', { name: 'Machine' })
    // DF46: GRBL's start-up lock is "Needs homing", not a red alarm; Home is the primary action
    expect(within(group).getByText('Needs homing')).toHaveAttribute('data-state', 'needsHoming')
    expect(within(t.nav()).getByRole('button', { name: 'Home' })).toHaveAttribute(
      'data-variant',
      'primary',
    )
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

  it('the position reads unknown until homed (DF46)', async () => {
    const t = await renderRun()
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const dro = within(inspector).getByRole('table', { name: 'Position' })
    const cell = (name: string) => within(dro).getByRole('cell', { name })
    expect(cell('Machine position X')).toHaveTextContent('—')
    expect(dro).toHaveAccessibleDescription('Position unknown until homed.')
    // "Connect … first" once, in the navigator; the idle line describes Start run
    expect(screen.getAllByText('Connect to a machine first.')).toHaveLength(1)
    expect(
      within(inspector).getByRole('button', { name: 'Start run' }),
    ).toHaveAccessibleDescription(/^No run yet/)
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
    await screen.findByRole('group', { name: 'Machine' })
    t.machine.push({ mpos: [-400, -400, -50] })
    expect(cell('Machine position X')).toHaveTextContent('—')
    expect(cell('Work position Z')).toHaveTextContent('—')
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Home' }))
    await within(machineGroup()!).findByText('Idle')
    expect(cell('Machine position X')).toHaveTextContent('-1.000')
    expect(dro).not.toHaveAccessibleDescription()
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
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
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
    // DF46: the soft-limit result, then Start run is enabled and focused
    await within(preflight).findByText('Inside the travel at this work zero.')
    await waitFor(() => expect(start).toHaveFocus())
    expect(t.callsOf('run.job.check')).toEqual([
      { planId: t.plan().id, setupId: expect.any(String) },
    ])
    await expectNoAxeViolations()
    await t.user.click(start)
    expect(t.callsOf('run.job.start')).toHaveLength(1)

    t.machine.progress = { done: 5, total: 20, label: 'pocket1 · tool 1: Flat 6' }
    await within(inspector).findByText('Line 5 / 20')
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

  it('pre-flight: a program outside the travel keeps Start run disabled and says why (DF46)', async () => {
    const t = await renderRun()
    t.machine.findings = [
      { rule: 'softLimit', params: { axis: 'x', min: -812, max: -12, travel: 800 } },
    ]
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    await within(preflight).findByText(
      'X leaves the travel: the program spans -812.000 to -12.000 mm, the travel is −800.000 to 0 mm.',
    )
    const start = within(preflight).getByRole('button', { name: 'Start run' })
    expect(start).toBeDisabled()
    expect(start).toHaveAccessibleDescription(/Move the work zero/)
    expect(within(preflight).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    // a new work zero is checked again
    t.machine.findings = []
    t.machine.push({ workZero: [-400, -300, -60] })
    await within(preflight).findByText('Inside the travel at this work zero.')
    await waitFor(() => expect(start).toBeEnabled())
    expect(t.callsOf('run.job.check')).toHaveLength(2)
    await expectNoAxeViolations()
  })

  it('tool change: dialog with steps, Close to the inspector, Continue names the wait', async () => {
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
    await t.user.click(within(dialog).getByRole('button', { name: 'Close (stay paused)' }))
    expect(screen.queryByRole('dialog', { name: 'Tool change 2' })).toBeNull()

    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText('Waiting for tool change 2: Drill 6')).toBeInTheDocument()
    await t.user.click(within(inspector).getByRole('button', { name: 'Show instructions' }))
    const again = screen.getByRole('dialog', { name: 'Tool change 2' })
    await t.user.click(within(again).getByRole('button', { name: 'Continue' }))
    expect(t.callsOf('run.job.continue')).toEqual([{ jobId: 'run-1', toolChange: 2 }])
  })

  // docs/modes/z-reference.md#dfyom-run (DF69)
  it('tool change on a Z reference other than the top face names the surface and the spot', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const toolChange = {
      n: 2,
      name: 'Flat 4',
      surface: 'Facing 1 floor, 0.50 below the stock top',
      spot: 'X50 Y30',
      level: -0.5,
      at: [50, 30],
    }
    // jogged away from the spot to change the tool, Z above the clearance height
    t.machine.push({
      state: 'Idle',
      workZero: [-400, -300, -60],
      mpos: [-10, -10, -20],
      ...t.machine.job('toolChange', { toolChange }),
    })
    const dialog = await screen.findByRole('dialog', { name: 'Tool change 2' })
    expect(
      within(dialog).getByText(
        'Touch off the new tool on Facing 1 floor, 0.50 below the stock top at X50 Y30 and set Z zero there.',
      ),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
    // back over the spot: confirmed, X Y at the current (higher) Z, never down
    await t.user.click(within(dialog).getByRole('button', { name: 'Move to touch-off spot' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Move to the touch-off spot?' })
    expect(within(confirm).getByText(/moves to X50 Y30 over Facing 1 floor\./)).toBeInTheDocument()
    await t.user.click(within(confirm).getByRole('button', { name: 'Move' }))
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog')).toEqual([{ to: [-350, -270, -20], feed: 2000 }]),
    )
    // at the spot: no button
    t.machine.push({ mpos: [-350, -270, -20] })
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Move to touch-off spot' })).toBeNull(),
    )
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
    const dialog = await screen.findByRole('dialog', { name: 'Machine alarm 2' })
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
    await waitFor(() =>
      expect(within(preflight).getByRole('button', { name: 'Start run' })).toHaveFocus(),
    )
    t.machine.push({ state: 'Jog' })
    await tabTo(t, within(preflight).getByRole('button', { name: 'Stop' }))
    await t.user.keyboard('{Enter}')
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1)
    await expectNoAxeViolations()
    await t.user.click(within(preflight).getByRole('button', { name: 'Cancel' }))
    t.machine.push({ state: 'Idle' })

    // program pause: Close (stay paused) has the first focus (never Stop or Continue); Stop
    // aborts the run. No bare M0 jargon: the badge says "Paused by program" (DF46)
    t.machine.push({ state: 'Hold:0', ...t.machine.job('programPause', { pause: 1 }) })
    const pause = await screen.findByRole('dialog', { name: /Program pause/ })
    expect(within(pause).getByRole('button', { name: 'Close (stay paused)' })).toHaveFocus()
    expect(within(pause).getByText(/^Program pause \(M0\) in the gCode/)).toBeInTheDocument()
    expect(within(machineGroup()!).getByText('Paused by program')).toBeInTheDocument()
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
    const dialog = await screen.findByRole('dialog', { name: /stopped with an error/ })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    await tabTo(t, within(dialog).getByRole('button', { name: 'Stop' }))
    await expectNoAxeViolations()
  })

  it('several setups: one run per setup, the setup-change prompt between them (E2)', async () => {
    const t = await renderRun({ bottom: true })
    const [bottom, top] = t.plan().setups
    expect([bottom?.name, top?.name]).toEqual(['Bottom', 'Top'])
    await connectAndHome(t)
    expect(within(t.nav()).getByRole('combobox', { name: 'Setup' })).toHaveTextContent('1. Bottom')
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    expect(within(preflight).getByText('Bottom (1 of 2)')).toBeInTheDocument()
    await within(preflight).findByText('Inside the travel at this work zero.')
    await t.user.click(within(preflight).getByRole('button', { name: 'Start run' }))
    expect(t.callsOf('run.job.start')).toEqual([{ planId: t.plan().id, setupId: bottom!.id }])

    // the bottom setup's run ends: the prompt for the top setup opens, never continuing by itself
    t.machine.outcome = {
      ok: true,
      value: {
        lines: 20,
        seconds: 60,
        elapsedSeconds: 65,
        toolChanges: 0,
        pauses: 0,
        warnings: [],
        setupId: bottom!.id,
        next: { setupId: top!.id, name: 'Top', direction: '+z', rotation: 0 },
      },
    }
    t.machine.push({ state: 'Idle', ...t.machine.job('done') })
    const prompt = await screen.findByRole('dialog', { name: 'Setup change: setup 2, Top' })
    expect(within(prompt).getByRole('img', { name: /top face up/ })).toBeInTheDocument()
    expect(within(prompt).getByText(/front-left corner, Z on its surface/)).toBeInTheDocument()
    // the zero to set and the part corner it is (M7)
    expect(within(prompt).getByText('Zero to set')).toBeInTheDocument()
    expect(
      within(prompt).getByText(/X0 Y0 at the front-left corner of the top.*front left corner/),
    ).toBeInTheDocument()
    expect(within(prompt).getByText('Stock on the machine')).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: 'Zero X Y Z' })).toBeEnabled()
    expect(within(prompt).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(within(machineGroup()!).getByText('Setup change')).toBeInTheDocument()
    expect(t.callsOf('run.job.start')).toHaveLength(1)
    await expectNoAxeViolations()

    // Later puts it off to the inspector; Show instructions brings it back
    await t.user.click(within(prompt).getByRole('button', { name: 'Close (start later)' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await t.user.click(within(inspector).getByRole('button', { name: 'Show instructions' }))
    const again = await screen.findByRole('dialog', { name: 'Setup change: setup 2, Top' })
    await t.user.click(within(again).getByRole('button', { name: 'Start setup 2' }))
    expect(t.callsOf('run.job.start').at(-1)).toEqual({ planId: t.plan().id, setupId: top!.id })
  })

  it('a run started elsewhere names its plan; once stopped, "Resume from…" restarts at an operation (M5, M7)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const plan = t.plan()
    const setup = plan.setups[0]!
    const ops = setup.operations
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    // another window (or an agent) starts a run: the status names its plan
    t.machine.push({
      state: 'Run',
      ...t.machine.job('streaming', {
        jobId: 'other-1',
        plan: {
          planId: plan.id,
          planName: plan.name,
          setupId: setup.id,
          setupName: setup.name,
          setup: 1,
          setups: 1,
        },
        planOperationId: ops[1]!.id,
      }),
    })
    expect(await within(inspector).findByText(plan.name)).toBeInTheDocument()
    expect(within(inspector).getByText('Started in another window or by an agent.')).toBeVisible()
    expect(within(inspector).queryByRole('button', { name: 'Resume from…' })).toBeNull()
    // it is stopped in the second operation
    t.machine.outcome = {
      ok: false,
      error: { code: 'op.aborted', message: 'aborted', issues: [], frames: [] },
    }
    const { job: _job, ...idle } = t.machine.status
    t.machine.status = idle
    t.machine.push({
      state: 'Idle',
      lastRun: {
        jobId: 'other-1',
        planId: plan.id,
        setupId: setup.id,
        outcome: 'stopped',
        planOperationId: ops[1]!.id,
      },
    })
    const resume = await within(inspector).findByRole('button', { name: 'Resume from…' })
    await t.user.click(resume)
    const dialog = await screen.findByRole('dialog', { name: 'Resume run?' })
    const at = within(dialog).getByRole('combobox', { name: 'Resume at' })
    expect(at).toHaveTextContent(/\(stopped here\)/)
    expect(within(dialog).getByText(/The run waits at the tool first/)).toBeInTheDocument()
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Resume run' }))
    expect(t.callsOf('run.job.start')).toEqual([
      { planId: plan.id, setupId: setup.id, from: ops[1]!.id },
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('the failure dialog offers "Resume from…" after a failed run (M5)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const plan = t.plan()
    const setup = plan.setups[0]!
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    await t.user.click(within(preflight).getByRole('button', { name: 'Start run' }))
    await within(machineGroup()!).findByText('Running')
    t.machine.outcome = {
      ok: false,
      error: { code: 'machine.error', message: 'error:20', issues: [], frames: [] },
    }
    const { job: _job, ...idle } = t.machine.status
    t.machine.status = idle
    t.machine.push({
      state: 'Idle',
      lastRun: { jobId: 'run-1', planId: plan.id, setupId: setup.id, outcome: 'failed' },
    })
    const dialog = await screen.findByRole('dialog', { name: /stopped with an error/ })
    await t.user.click(within(dialog).getByRole('button', { name: 'Resume from…' }))
    const resume = await screen.findByRole('dialog', { name: 'Resume run?' })
    // no operation known: the first is offered
    expect(within(resume).getByRole('combobox', { name: 'Resume at' })).not.toHaveTextContent(
      /stopped here/,
    )
    await t.user.click(within(resume).getByRole('button', { name: 'Resume run' }))
    expect(t.callsOf('run.job.start').at(-1)).toEqual({
      planId: plan.id,
      setupId: setup.id,
      from: setup.operations[0]!.id,
    })
  })

  it('without a plan: connects with a library machine; homing, jog and zero work (DF31)', async () => {
    const t = await renderRun()
    // by keyboard: open the plan list, up to the first option (manual control), choose it
    within(t.nav()).getByRole('combobox', { name: 'Plan' }).focus()
    await t.user.keyboard('{Enter}')
    await screen.findByRole('option', { name: 'No plan (manual control)' })
    await t.user.keyboard('{ArrowUp}{Enter}')
    const machine = await screen.findByRole('combobox', { name: 'Machine' })
    await waitFor(() => expect(machine).toHaveTextContent(/.+/))
    await connectAndHome(t)
    expect(t.callsOf('run.connection.open')).toEqual([
      { target: 'virtual', machineId: expect.any(String), timeScale: 1 },
    ])
    expect(within(t.nav()).getByRole('combobox', { name: 'Plan' })).toBeDisabled()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog X+' }))
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog X+' }))
    expect(t.callsOf('run.machine.jog')).toHaveLength(2)
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Zero X Y Z' }))
    expect(t.callsOf('run.workZero.set')).toEqual([{ axes: ['x', 'y', 'z'] }])
    await expectNoAxeViolations()
  })

  it('a travel refusal is worded at the end of the panel; the notice keeps its place (DF33, DF34)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const notice = within(t.nav()).getByRole('status', { name: 'Status' })
    expect(notice).toHaveTextContent('Ready to jog.')
    expect(within(t.nav()).getByText(/The work zero is at machine 0/)).toBeInTheDocument()
    t.bridge.handle('run.machine.jog', () => ({
      ok: false,
      retryable: false,
      error: {
        code: 'run.travel',
        message: 'X would leave the travel: max 0 mm, the jog would end at 1 mm',
        issues: [],
        frames: [{ where: 'machineHost.jog', data: { axis: 'x', target: 1, min: -800, max: 0 } }],
      },
    }))
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog X+' }))
    const alert = await within(t.nav()).findByText(
      'X would leave the travel: max 0.000 mm, the jog would end at 1.000 mm.',
    )
    // after every control: nothing above it moved
    const panelChildren = [...t.nav().querySelectorAll('section, [role="status"]')]
    for (const el of panelChildren)
      expect(el.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(t.nav()).getByRole('status', { name: 'Status' })).toBe(notice)
    await expectNoAxeViolations()
  })

  it('Stop is disabled with its reason when nothing moves, enabled while jogging (DF35)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const stop = within(machineGroup()!).getByRole('button', { name: 'Stop' })
    expect(stop).toHaveAttribute('aria-disabled', 'true')
    expect(stop).toHaveAccessibleDescription('Nothing to stop: the machine is not moving.')
    await t.user.click(stop)
    expect(t.callsOf('run.machine.reset')).toHaveLength(0)
    t.machine.push({ state: 'Jog' })
    await waitFor(() =>
      expect(within(machineGroup()!).getByRole('button', { name: 'Stop' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    )
    await expectNoAxeViolations()
  })

  it('continuous jog: hold to jog, cancelled on release, key up and window blur (M3)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Continuous' }))
    // the step control gives way to the hint
    expect(nav.queryByRole('radio', { name: '10 mm' })).toBeNull()
    expect(nav.getByText('Hold to jog; release to stop.')).toBeInTheDocument()
    const xPlus = nav.getByRole('button', { name: 'Jog X+' })
    await t.user.pointer({ keys: '[MouseLeft>]', target: xPlus })
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog')).toEqual([
        { by: [1, 0, 0], feed: 2000, continuous: true },
      ]),
    )
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(0)
    await t.user.pointer({ keys: '[/MouseLeft]', target: xPlus })
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1))
    // keyboard: Space held on a focused button, released
    const zMinus = nav.getByRole('button', { name: 'Jog Z−' })
    zMinus.focus()
    await t.user.keyboard('[Space>]')
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog').at(-1)).toEqual({
        by: [0, 0, -1],
        feed: 500,
        continuous: true,
      }),
    )
    await t.user.keyboard('[/Space]')
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(2))
    // the window losing focus ends a hold
    await t.user.pointer({ keys: '[MouseLeft>]', target: xPlus })
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(3))
    act(() => void window.dispatchEvent(new Event('blur')))
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(3))
    await t.user.pointer({ keys: '[/MouseLeft]', target: xPlus })
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(3)
    await expectNoAxeViolations(t.container)
  })

  it('a hold released before the jog is accepted cancels again once it is (M3)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    let accept: (r: CallReply) => void = () => {}
    t.bridge.handle('run.machine.jog', () => new Promise<CallReply>((r) => (accept = r)))
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Continuous' }))
    const yPlus = nav.getByRole('button', { name: 'Jog Y+' })
    await t.user.pointer({ keys: '[MouseLeft>]', target: yPlus })
    await t.user.pointer({ keys: '[/MouseLeft]', target: yPlus })
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1))
    await act(async () => accept(ok({})))
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(2))
  })

  it('in Alarm the panel at the end of the navigator says what happened and what to do (M3)', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Connect' }))
    const nav = within(t.nav())
    // locked at start ($22=1), no alarm code: the next step, not an error (DF46)
    let panel = await nav.findByRole('region', { name: 'Needs homing' })
    expect(within(panel).getByRole('heading', { name: 'Needs homing' })).toBeInTheDocument()
    expect(within(panel).getByText('Home the machine.')).toBeInTheDocument()
    // a hard limit: reset first, then check the switch, then home
    t.machine.push({
      state: 'Alarm',
      alarm: { code: 1, text: 'Hard limit triggered. Machine position is likely lost.' },
    })
    panel = nav.getByRole('region', { name: 'Alarm' })
    expect(within(panel).getByRole('heading', { name: 'Alarm 1: hard limit' })).toBeInTheDocument()
    const steps = within(panel)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(steps[0]).toBe('Reset (immediate).')
    expect(steps.at(-1)).toBe('Home the machine.')
    expect(within(panel).getByText(/Controller: Hard limit triggered/)).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
    // reset and homed: the panel goes
    const next = { ...t.machine.status }
    delete next.alarm
    t.machine.status = next
    t.machine.push({ state: 'Idle', homed: true })
    expect(nav.queryByRole('region', { name: 'Alarm' })).toBeNull()
  })

  it('probes Z with the touch plate after a confirmation (M4)', async () => {
    const none = await renderRun()
    await connectAndHome(none)
    // no plate thickness on the machine: no probe control
    expect(within(none.nav()).queryByRole('button', { name: 'Probe Z' })).toBeNull()
    none.unmount()

    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    const nav = within(t.nav())
    expect(nav.getByText(/Touch plate 10(\.0+)? mm/)).toBeInTheDocument()
    await t.user.click(nav.getByRole('button', { name: 'Probe Z' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Probe Z?' })
    expect(within(confirm).getByText(/clip on the bit/)).toBeInTheDocument()
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await expectNoAxeViolations()
    await t.user.click(within(confirm).getByRole('button', { name: 'Probe' }))
    expect(t.callsOf('run.machine.probeZ')).toEqual([{ plateThickness: 10 }])
  })

  it('at a tool change: Probe Z in the dialog; a miss shows its alarm and Unlock there (M4)', async () => {
    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    t.machine.push({
      state: 'Idle',
      ...t.machine.job('toolChange', { toolChange: { n: 2, name: 'Drill 6' } }),
    })
    const dialog = await screen.findByRole('dialog', { name: 'Tool change 2' })
    await t.user.click(within(dialog).getByRole('button', { name: 'Probe Z' }))
    await t.user.click(
      within(screen.getByRole('alertdialog', { name: 'Probe Z?' })).getByRole('button', {
        name: 'Probe',
      }),
    )
    expect(t.callsOf('run.machine.probeZ')).toEqual([{ plateThickness: 10 }])
    t.machine.push({
      state: 'Alarm',
      alarm: {
        code: 5,
        text: 'Probe fail. Probe did not contact the workpiece within the programmed travel.',
      },
    })
    const panel = within(dialog).getByRole('region', { name: 'Alarm' })
    expect(within(panel).getByText('Unlock and probe again.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Probe Z' })).toBeDisabled()
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    expect(t.callsOf('run.machine.unlock')).toHaveLength(1)
  })

  it('overrides in the inspector: ±10 %, reset, rapids; a changed value is explained (M6)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    const section = within(inspector.getByRole('region', { name: 'Overrides' }))
    // not reported yet
    expect(section.queryByText('Overrides apply until reset or the program ends.')).toBeNull()
    t.machine.push({ overrides: { feed: 120, rapid: 100, spindle: 100 } })
    const feed = within(section.getByRole('group', { name: 'Feed' }))
    expect(feed.getByText('120 %')).toHaveAttribute('data-changed')
    expect(
      section.getByText('Overrides apply until reset or the program ends.'),
    ).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
    await t.user.click(feed.getByRole('button', { name: 'Increase feed override by 10 %' }))
    await t.user.click(feed.getByRole('button', { name: 'Reset feed override to 100 %' }))
    const spindle = within(section.getByRole('group', { name: 'Spindle' }))
    expect(spindle.getByRole('button', { name: 'Reset spindle override to 100 %' })).toBeDisabled()
    await t.user.click(spindle.getByRole('button', { name: 'Decrease spindle override by 10 %' }))
    await t.user.click(section.getByRole('radio', { name: '25 %' }))
    expect(t.callsOf('run.override.set')).toEqual([
      { feed: '+10' },
      { feed: 'reset' },
      { spindle: '-10' },
      { rapid: 25 },
    ])
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

describe('Run mode: serial port (docs/modes/run-machine.md#ports-and-the-port-picker)', () => {
  const PORT = '/dev/cu.usbmodem1101'
  function scriptSerial(t: Awaited<ReturnType<typeof renderRun>>, matches: boolean) {
    t.bridge.handle('run.ports.scan', () =>
      ok({
        ports: [
          { path: PORT, manufacturer: 'Arduino (www.arduino.cc)', vendorId: '2341', usb: true },
          { path: '/dev/tty.Bluetooth-Incoming-Port', usb: false },
        ],
      }),
    )
    t.bridge.handle('run.connection.open', (args) => {
      const { path, baud } = args as { path: string; baud: number }
      queueMicrotask(() =>
        t.machine.push({
          connection: { state: 'open', target: 'serial', timeScale: 1, port: { path, baud } },
          state: 'Alarm',
        }),
      )
      return ok({
        target: 'serial',
        settingsCheck: {
          against: 'plan',
          matches,
          homingEnabled: true,
          notInMachine: [],
          differences: matches
            ? []
            : [{ setting: '$130', field: 'travel.x', controller: '400 mm', machine: '300 mm' }],
        },
      })
    })
  }

  it('picks a USB port, connects, warns about differing settings and confirms the first Home', async () => {
    const t = await renderRun()
    scriptSerial(t, false)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    // the USB port is chosen; the time scale is the virtual machine's only
    await waitFor(() =>
      expect(nav.getByRole('combobox', { name: 'Serial port' })).toHaveTextContent(
        `${PORT} · Arduino`,
      ),
    )
    expect(nav.queryByRole('combobox', { name: 'Time scale' })).toBeNull()
    expect(nav.getByRole('combobox', { name: 'Baud' })).toHaveTextContent('115200')
    await expectNoAxeViolations(t.container)
    await t.user.click(nav.getByRole('button', { name: 'Connect' }))
    expect(t.callsOf('run.connection.open').at(-1)).toMatchObject({
      target: 'serial',
      path: PORT,
      baud: 115_200,
    })
    const group = await screen.findByRole('group', { name: 'Machine' })
    expect(within(group).getByText(`Serial · ${PORT}`)).toBeInTheDocument()
    const alert = await nav.findByRole('alert')
    expect(alert).toHaveTextContent('$130 travel.x is 400 mm on the controller, 300 mm in the plan')
    expect(within(alert).getByRole('button', { name: 'Review' })).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
    // Home on a real machine that is not homed asks first
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Home the machine?' })
    expect(t.callsOf('run.machine.home')).toHaveLength(0)
    await t.user.click(within(dialog).getByRole('button', { name: 'Home' }))
    await waitFor(() => expect(t.callsOf('run.machine.home')).toHaveLength(1))
  })

  it('the real-machine pre-flight: plan status, air-cut hint, "Start on the machine" (M2)', async () => {
    const t = await renderRun()
    scriptSerial(t, true)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    await waitFor(() => expect(nav.getByRole('button', { name: 'Connect' })).toBeEnabled())
    await t.user.click(nav.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('group', { name: 'Machine' })
    t.machine.push({ state: 'Idle', homed: true })
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    expect(within(preflight).getByText(`Serial port ${PORT} at 115200 baud`)).toBeInTheDocument()
    expect(within(preflight).getByText(/Run it in the air: spindle off/)).toBeInTheDocument()
    expect(within(preflight).getByText('Plan status')).toBeInTheDocument()
    expect(within(preflight).getByText('Draft')).toBeInTheDocument()
    // a draft plan does not run on a real machine: said before the click
    const start = within(preflight).getByRole('button', { name: 'Start on the machine' })
    expect(start).toBeDisabled()
    expect(
      within(preflight).getByText(/A real machine runs only finalized plans/),
    ).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
  })

  it('a lost real connection says the machine may still move, in the navigator and the failure dialog (M2)', async () => {
    const t = await renderRun()
    scriptSerial(t, true)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    await waitFor(() => expect(nav.getByRole('button', { name: 'Connect' })).toBeEnabled())
    await t.user.click(nav.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('group', { name: 'Machine' })
    t.machine.push({ state: 'Idle', homed: true })
    t.machine.push({ state: 'Run', ...t.machine.job('streaming') })
    // the run fails with machine.connection and the connection closes as lost
    t.machine.outcome = {
      ok: false,
      error: {
        code: 'machine.connection',
        message: 'port closed',
        issues: [],
        frames: [{ where: 'GrblSender', data: { reason: 'device disconnected' } }],
      },
    }
    const closed = closedStatus()
    t.machine.push({
      ...closed,
      connection: {
        ...closed.connection,
        lost: { target: 'serial', port: { path: PORT, baud: 115_200 } },
      },
    })
    const dialog = await screen.findByRole('dialog', { name: 'Connection to the machine lost' })
    expect(within(dialog).getByText(/use the emergency stop/)).toBeInTheDocument()
    expect(within(dialog).getByText(/connect again and home the machine/)).toBeInTheDocument()
    await t.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // the navigator keeps the warning until the next connect
    expect(within(t.nav()).getByRole('alert')).toHaveTextContent(
      'Connection to the machine lost. It may still be moving',
    )
    await expectNoAxeViolations(t.container)
  })

  it('says when no port is found', async () => {
    const t = await renderRun()
    t.bridge.handle('run.ports.scan', () => ok({ ports: [] }))
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    expect(
      await nav.findByText('No serial ports found. Connect the controller by USB and refresh.'),
    ).toBeInTheDocument()
    expect(nav.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await expectNoAxeViolations(t.container)
  })
})
