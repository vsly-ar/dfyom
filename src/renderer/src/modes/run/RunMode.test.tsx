// Run mode UI against the fake bridge: a project with a real plan (core plan fixture) and a
// scripted machine that answers the run commands and pushes statuses as main does.
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #testing
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { runPlanHash } from '../../../../core/run/plan-hash'
import { resumePoints, resumeProgram, scanProgram } from '../../../../core/run/recovery'
import { prepareGcodeFile } from '../../../../core/run/gcode-file'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply } from '../../../../shared/preload-api'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/settings'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { Library } from '../../../../core/library/library'
import { createMemoryLibraryStorage } from '../../../../core/library/memory-storage'
import { expectNoAxeViolations, renderUi } from '../../test/render'

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

/** The program `run.job.check` answers (DF129 RC3): two passes, the second entering on a ramp. */
const TWO_PASSES = [
  '(Pocket 1)',
  '(DFYOM TOOL CHANGE 1: Flat 6)',
  'M0',
  'G90 G94 G17 G21',
  'G54',
  'M3 S18000',
  'G4 P3',
  'G0 Z5',
  'G0 X10 Y10',
  'G1 Z-1 F150',
  'G1 X20 F600',
  'G1 Y20',
  'G0 Z5',
  'G0 X10 Y10',
  'G1 X12 Z-1.5 F300',
  'G1 X14 Z-2',
  'G1 X20',
  'G1 Y20',
  'G0 Z5',
  'M5',
]

interface Machine {
  status: RunStatus
  push(patch: Partial<RunStatus>): void
  progress: { done: number; total: number; label: string }
  outcome: { ok: true; value: unknown } | { ok: false; error: AppErrorData } | undefined
  /** `softLimit` findings `run.job.check` answers (DF46). */
  findings: { rule: string; params: Record<string, number | string> }[]
  /** DF129 RC3: a file's prepared lines, for `run.job.check { file, fromLine }`. */
  fileLines?: readonly string[]
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
  // DF129 RC3: the program and the start's preview, from core on a small two-pass program
  bridge.handle('run.job.check', (a) => {
    const { fromLine, program, file } = a as {
      fromLine?: number
      program?: boolean
      file?: string
    }
    const lines = file !== undefined && m.fileLines !== undefined ? m.fileLines : TWO_PASSES
    const points = resumePoints(scanProgram(lines))
    const resumed =
      fromLine === undefined
        ? undefined
        : resumeProgram({ lines, sections: [] }, fromLine, {
            topZ: -1,
            spinUpSeconds: 3,
            spindleControl: 'gcode',
          }).unwrap()
    return ok({
      setupId: 's',
      findings: m.findings,
      ...(program === true
        ? { program: { lines, sections: [{ fromLine: 1, label: 'Pocket 1' }], points } }
        : {}),
      ...(resumed === undefined
        ? {}
        : {
            resume: {
              fromLine: resumed.fromLine,
              programHash: 'hash-1',
              leadIn: resumed.leadIn,
              findings: resumed.findings,
              before: points.filter((p) => p.line <= resumed.fromLine).at(-1)?.line,
              after: points.find((p) => p.line > resumed.fromLine)?.line,
            },
          }),
    })
  })
  bridge.handle('run.machine.reset', () => ok({}))
  bridge.handle('run.machine.probeZ', () => ok({ jobId: 'probe-1' }))
  bridge.handle('run.override.set', () => ok({}))
  // DF78: the alignment step as main keeps it (the pointer arrives at once)
  bridge.handle('run.align.goto', (a) => {
    const { planId, setupId, to } = a as { planId: string; setupId: string; to: string }
    const step = m.status.alignment ?? {
      planId,
      setupId,
      entries: [
        { id: 'zero', name: 'Work zero', target: [0, 0] as [number, number], ticked: false },
        {
          id: 'al1',
          name: 'Back right',
          target: [80, 50] as [number, number],
          ticked: false,
          // Q108: a side mark's entry checks one axis
          oneAxis: 'y' as const,
        },
      ],
      confirmed: false,
      skipped: [],
      zeroAt: [m.status.workZero[0], m.status.workZero[1]] as [number, number],
    }
    const i = step.entries.findIndex((e) => e.id === step.current)
    const entry =
      to === 'next'
        ? step.entries[(i + 1) % step.entries.length]!
        : step.entries.find((e) => e.id === to)!
    queueMicrotask(() =>
      m.push({
        alignment: { ...step, current: entry.id },
        wpos: [entry.target[0], entry.target[1], 5],
      }),
    )
    return ok({ current: entry.id, target: entry.target })
  })
  bridge.handle('run.align.tick', (a) => {
    const c = a as { entry?: string; ticked?: boolean; confirm?: true; skipUnticked?: true }
    const step = m.status.alignment!
    const entries = step.entries.map((e) =>
      e.id === c.entry ? { ...e, ticked: c.ticked ?? true } : e,
    )
    const next = {
      ...step,
      entries,
      confirmed: c.confirm === true,
      skipped: c.confirm === true ? entries.filter((e) => !e.ticked).map((e) => e.id) : [],
    }
    queueMicrotask(() => m.push({ alignment: next }))
    return ok(next)
  })
  return Object.assign(m, { job })
}

async function renderRun(
  opts: {
    bottom?: boolean
    plate?: string
    points?: boolean
    /** DF135 Q199: every top-level operation marked already cut; the plan in this status. */
    allCut?: 'draft' | 'settledDesign'
    /** DF140: the app settings the window starts with (a restart). */
    settings?: (machineId: string) => Partial<AppSettings>
  } = {},
) {
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
  if (opts.allCut !== undefined)
    await s.run('design.part.update', {
      partId: s.partId,
      alreadyCut: s
        .part()
        .operations.filter((o) => o.featureId === undefined)
        .map((o) => o.id),
    })
  const planId = await s.create(
    opts.plate === undefined ? {} : { machineLibraryItemId: s.machineId },
  )
  if (opts.allCut === 'settledDesign')
    await s.run('plan.status.set', { planId, status: 'settledDesign' })
  // DF78: an alignment point on the last setup
  if (opts.points === true)
    await s.run('plan.alignment.set', {
      planId,
      setupId: s.plan(planId).setups.at(-1)!.id,
      points: [{ name: 'Back right', source: { corner: 'top back right' } }],
    })
  const bridge = createFakeBridge({ ...DEFAULT_SETTINGS, ...opts.settings?.(s.machineId) })
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
  // a serial port is the default (DF101); these tests run the virtual machine unless they choose
  await r.user.click(within(nav()).getByRole('radio', { name: 'Virtual machine' }))
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  return { ...r, bridge, shell, machine, nav, callsOf, plan: () => s.plan(planId), s }
}

const machineGroup = () => screen.queryByRole('group', { name: 'Machine' })

/** Presses Tab until `target` has the focus (the dialog traps it, so Tab wraps); fails if never. */
async function tabTo(t: Awaited<ReturnType<typeof renderRun>>, target: HTMLElement) {
  for (let i = 0; i < 60 && document.activeElement !== target; i++) await t.user.tab()
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
    for (const name of ['Home', 'Jog X+']) {
      const button = within(t.nav()).getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(why.id)
    }
    // DF88: no "Zero X Y Z"; the per-axis zero buttons are in the Position table
    expect(within(t.nav()).queryByRole('button', { name: /^Zero / })).toBeNull()
    expect(within(t.nav()).getByRole('heading', { name: 'Probing' })).toBeInTheDocument()
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
    // v0.5 RV3: Test probe, the probe input live
    expect(within(t.nav()).getByText(/^Probe input: open\./)).toHaveAttribute('role', 'status')
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
    // "Connect … first" shown once, in the navigator (the zero buttons' copy is for screen
    // readers only); the idle line describes Start run
    expect(
      screen
        .getAllByText('Connect to a machine first.')
        .filter((e) => !e.classList.contains('srOnly')),
    ).toHaveLength(1)
    expect(within(dro).getByRole('button', { name: 'Set X zero' })).toHaveAccessibleDescription(
      'Connect to a machine first.',
    )
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
    // DF88: the jog feed (2000 mm/min) on every axis (a plan without a machine: no Z cap)
    expect(t.callsOf('run.machine.jog')).toEqual([
      { by: [-100, 0, 0], feed: 2000 },
      { by: [0, 0, 100], feed: 2000 },
    ])
    // DF88: the zero buttons in the Position table, one axis each
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const dro = screen.getByRole('table', { name: 'Position' })
    for (const axis of ['X', 'Y', 'Z'])
      await t.user.click(within(dro).getByRole('button', { name: `Set ${axis} zero` }))
    expect(t.callsOf('run.workZero.set')).toEqual([
      { axes: ['x'] },
      { axes: ['y'] },
      { axes: ['z'] },
    ])
    await expectNoAxeViolations()
  })

  it('remembers the jog feed per machine and jogs at it; Z at most its max (DF88)', async () => {
    // the plan's machine comes from the library (machine fixture: X/Y 5000, Z 1000 mm/min)
    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    const slider = within(t.nav()).getByRole('slider', { name: 'Jog feed' })
    expect(slider).toHaveAttribute('aria-valuemax', '5000')
    slider.focus()
    await t.user.keyboard('{ArrowRight}{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuetext', '2200 mm/min')
    const patch = t.bridge.settingsPatches.at(-1) as { jogFeed?: Record<string, number> }
    expect(Object.values(patch.jogFeed ?? {})).toEqual([2200])
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog Y+' }))
    expect(t.callsOf('run.machine.jog').at(-1)).toEqual({ by: [0, 10, 0], feed: 2200 })
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog Z−' }))
    expect(t.callsOf('run.machine.jog').at(-1)).toEqual({ by: [0, 0, -10], feed: 1000 })
  })

  it('v0.5 RV1: while the spindle turns the jog uses the cutting jog feed (600 mm/min, remembered); Home waits', async () => {
    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    expect(within(t.nav()).getByRole('slider', { name: 'Jog feed' })).toHaveAttribute(
      'aria-valuetext',
      '2000 mm/min',
    )
    t.machine.push({ spindle: 12000, spindleDirection: 'cw' })
    const cutting = within(t.nav()).getByRole('slider', { name: 'Cutting jog feed' })
    expect(cutting).toHaveAttribute('aria-valuetext', '600 mm/min')
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Jog X+' }))
    expect(t.callsOf('run.machine.jog').at(-1)).toEqual({ by: [10, 0, 0], feed: 600 })
    cutting.focus()
    await t.user.keyboard('{ArrowLeft}')
    expect(t.bridge.settingsPatches.at(-1)).toEqual({ cuttingJogFeed: { [t.s.machineId]: 500 } })
    // the DRO's spindle value in the accent; Home refused with the reason
    expect(within(t.nav()).getByRole('button', { name: 'Home' })).toBeDisabled()
    // off: the jog feed again
    t.machine.push({ spindle: 0 })
    expect(within(t.nav()).getByRole('slider', { name: 'Jog feed' })).toHaveAttribute(
      'aria-valuetext',
      '2000 mm/min',
    )
  })

  it('v0.5 RV2: Machine settings edits the library machine (Save, Revert) and shows the controller $$', async () => {
    const t = await renderRun({ plate: '10' })
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    // collapsed by default
    const toggle = inspector.getByRole('button', { name: 'Machine settings' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await t.user.click(toggle)
    const plate = inspector.getByRole('combobox', { name: 'Touch plate thickness' })
    expect(plate).toHaveValue('10')
    expect(inspector.getByText(/plan uses its own copy/)).toBeInTheDocument()
    // a draft: Unsaved, Revert drops it
    await t.user.clear(plate)
    await t.user.type(plate, '12{Enter}')
    expect(inspector.getByText('Unsaved')).toBeInTheDocument()
    await t.user.click(inspector.getByRole('button', { name: 'Revert' }))
    expect(inspector.getByRole('combobox', { name: 'Touch plate thickness' })).toHaveValue('10')
    expect(inspector.queryByText('Unsaved')).toBeNull()
    // Save: one library.machine.update; Probe Z then uses the library machine's plate
    const again = inspector.getByRole('combobox', { name: 'Touch plate thickness' })
    await t.user.clear(again)
    await t.user.type(again, '12{Enter}')
    await t.user.click(inspector.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(inspector.queryByText('Unsaved')).toBeNull())
    const update = t.callsOf('library.machine.update').at(-1) as {
      id: string
      values: { probePlateThickness?: string }
    }
    expect(update.id).toBe(t.s.machineId)
    expect(update.values.probePlateThickness).toBe('12')
    // main's library broadcast (the fake bridge does not send it by itself)
    act(() =>
      t.bridge.emitLibraryChange({
        kind: 'machine',
        id: t.s.machineId,
        change: 'updated',
        revision: 3,
      }),
    )
    expect(await within(t.nav()).findByText(/Touch plate 12\.000 mm/)).toBeInTheDocument()
    await expectNoAxeViolations()

    // connected: the controller's $$ read-only, a difference with its line to copy
    t.bridge.handle('run.settings.check', () =>
      ok({ settings: { '20': 1, '22': 1, '110': 4000, '111': 5000, '999': 3 } }),
    )
    await connectAndHome(t)
    const table = within(await inspector.findByRole('table', { name: 'Controller settings' }))
    expect(table.getByRole('rowheader', { name: /\$110 X max rate/ })).toBeInTheDocument()
    const differs = table.getByRole('row', { name: /\$110/ })
    expect(differs).toHaveAttribute('data-differs')
    expect(differs).toHaveTextContent('4000 mm/min')
    expect(differs).toHaveTextContent('5000 mm/min')
    expect(table.getByRole('row', { name: /\$111/ })).not.toHaveAttribute('data-differs')
    expect(table.getByRole('row', { name: /\$999/ })).toHaveTextContent('—')
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await t.user.click(table.getByRole('button', { name: 'Copy $110=5000' }))
    expect(write).toHaveBeenCalledWith('$110=5000')
    write.mockRestore()
    await expectNoAxeViolations()
  })

  it('remembers the jog step and feed per machine across restarts (DF140)', async () => {
    const t = await renderRun({ plate: '10' })
    await t.user.click(within(t.nav()).getByRole('radio', { name: '50 mm' }))
    expect(t.bridge.settingsPatches.at(-1)).toEqual({ jogStep: { [t.s.machineId]: { step: 50 } } })
    t.unmount()
    // a restart: the window starts from the saved settings
    const r = await renderRun({
      plate: '10',
      settings: (id) => ({
        jogStep: { [id]: { step: 2.5, custom: 2.5 } },
        jogFeed: { [id]: 1500 },
      }),
    })
    const presets = within(r.nav()).getByRole('radiogroup', { name: 'Jog step presets' })
    expect(within(presets).queryByRole('radio', { checked: true })).toBeNull()
    expect(within(r.nav()).getByRole('textbox', { name: 'Custom jog step (mm)' })).toHaveValue(
      '2.5',
    )
    expect(within(r.nav()).getByRole('slider', { name: 'Jog feed' })).toHaveAttribute(
      'aria-valuetext',
      '1500 mm/min',
    )
    await connectAndHome(r)
    await r.user.click(within(r.nav()).getByRole('button', { name: 'Jog X+' }))
    expect(r.callsOf('run.machine.jog').at(-1)).toEqual({ by: [2.5, 0, 0], feed: 1500 })
  })

  it('without a library machine the jog step is remembered app-wide (DF140)', async () => {
    const t = await renderRun()
    await t.user.click(within(t.nav()).getByRole('radio', { name: '5 mm' }))
    expect(t.bridge.settingsPatches.at(-1)).toEqual({ jogStep: { '*': { step: 5 } } })
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
    // DF129 RC3: the first check also reads the program for "Start at"
    expect(t.callsOf('run.job.check')).toEqual([
      { planId: t.plan().id, setupId: expect.any(String), program: true },
    ])
    expect(within(preflight).getByRole('combobox', { name: 'Start at' })).toHaveTextContent(
      'Beginning',
    )
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
    // DF82: while the hold still decelerates (Hold:1) Resume waits, the badge says "Holding…"
    t.machine.push({ state: 'Hold:1', job: { ...t.machine.status.job!, phase: 'held' } })
    await within(group).findByText('Holding…', { selector: '[data-state]' })
    expect(within(group).getByRole('button', { name: 'Resume' })).toBeDisabled()
    t.machine.push({ state: 'Hold:0' })
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Resume' })).not.toBeDisabled(),
    )
    // stop is never confirmed
    await t.user.click(within(group).getByRole('button', { name: 'Stop' }))
    expect(t.callsOf('job.abort')).toEqual([{ jobId: 'run-1' }])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('pre-flight "Start at": a pass start, the lead-in with its tool wait, a risky line, the start (DF129 RC3)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = within(screen.getByRole('dialog', { name: 'Start run?' }))
    await preflight.findByText('Inside the travel at this work zero.')
    // a pass start from the list, grouped by its operation
    await t.user.click(preflight.getByRole('combobox', { name: 'Start at' }))
    expect(screen.getByRole('option', { name: 'Operation start · line 10' })).toBeInTheDocument()
    await t.user.click(screen.getByRole('option', { name: 'Pass 2 · line 15' }))
    expect(await preflight.findByText('The run first waits at tool 1: Flat 6')).toBeInTheDocument()
    expect(t.callsOf('run.job.check').at(-1)).toMatchObject({ fromLine: 15 })
    expect(t.callsOf('run.job.check').at(-1)).not.toHaveProperty('program')
    expect(
      preflight.getByText('Lines 1–14 are skipped: the machine runs from line 15 on.'),
    ).toBeInTheDocument()
    const leadIn = within(preflight.getByRole('region', { name: 'Lead-in' }))
    expect(leadIn.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Spindle and coolant off, then straight up to the machine top.',
      'Waits at tool 1 (the tool-change dialog).',
      'Spindle on at 18,000 rpm, then waits 3 s for it to spin up.',
      'Rapid to X 10 Y 10 mm at the top.',
      'Rapid down to Z 5 mm.',
      'Runs the program from line 15.',
    ])
    // the gCode panel behind the dialog (inert while it is open): lines before the start
    // skipped, the start line marked
    const list = document.querySelector('[aria-label="gCode"] [role="list"]')!
    expect(list.querySelector('[aria-current="location"]')).toHaveAttribute('data-line', '15')
    expect(list.querySelector('[data-line="14"]')).toHaveAttribute('data-state', 'skipped')
    const start = preflight.getByRole('button', { name: 'Start at line 15' })
    await waitFor(() => expect(start).toBeEnabled())
    await expectNoAxeViolations()

    // any line behind "Choose a line…": inside the ramp, in the material
    await t.user.click(preflight.getByRole('combobox', { name: 'Start at' }))
    await t.user.click(screen.getByRole('option', { name: 'Choose a line…' }))
    const field = preflight.getByRole('textbox', { name: 'Line' })
    await t.user.clear(field)
    await t.user.type(field, '16{Enter}')
    expect(
      await preflight.findByText(
        /^This line is part of a ramp; starting here plunges straight down/,
      ),
    ).toBeInTheDocument()
    expect(
      preflight.getByText(/^The line starts in the material at Z -1\.500 mm/),
    ).toBeInTheDocument()
    expect(preflight.getByText(/^Line 16 is not an operation or pass start/)).toBeInTheDocument()
    // allowed after reading; the ramp's first line a click away
    await waitFor(() =>
      expect(preflight.getByRole('button', { name: 'Start at line 16' })).toBeEnabled(),
    )
    await expectNoAxeViolations()
    await t.user.click(preflight.getAllByRole('button', { name: 'Start at line 15' })[0]!)
    expect(preflight.getByRole('combobox', { name: 'Start at' })).toHaveTextContent(
      'Pass 2 · line 15',
    )
    const go = preflight.getByRole('button', { name: 'Start at line 15' })
    await waitFor(() => expect(go).toBeEnabled())
    await t.user.click(go)
    expect(t.callsOf('run.job.start')).toEqual([
      { planId: t.plan().id, setupId: expect.any(String), fromLine: 15, programHash: 'hash-1' },
    ])
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

  it('pre-flight: everything marked already cut offers Clear marks; a draft plan then runs it all (DF135 Q199)', async () => {
    const t = await renderRun({ allCut: 'draft' })
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = within(screen.getByRole('dialog', { name: 'Start run?' }))
    const offer = within(preflight.getByRole('group', { name: 'Already cut' }))
    expect(
      offer.getByText(/^Everything in .* is marked already cut\. Cutting a new blank\?/),
    ).toBeVisible()
    const start = preflight.getByRole('button', { name: 'Start run' })
    expect(start).toBeDisabled()
    expect(start).toHaveAccessibleDescription(/^Nothing to cut in .*: every operation is marked/)
    // no program to check
    expect(t.callsOf('run.job.check')).toEqual([])
    await expectNoAxeViolations()
    await t.user.click(offer.getByRole('button', { name: 'Clear marks' }))
    await waitFor(() => expect(t.plan().design.part.alreadyCut).toBeUndefined())
    expect(t.callsOf('design.part.update').at(-1)).toMatchObject({ alreadyCut: [] })
    expect(t.callsOf('project.apply')).toHaveLength(1)
    await preflight.findByText('Inside the travel at this work zero.')
    await waitFor(() => expect(start).toBeEnabled())
    expect(preflight.queryByRole('group', { name: 'Already cut' })).toBeNull()
  })

  it('pre-flight: a plan that is not a draft keeps its copy of the marks and says so (DF135 Q199)', async () => {
    const t = await renderRun({ allCut: 'settledDesign' })
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = within(screen.getByRole('dialog', { name: 'Start run?' }))
    const offer = within(preflight.getByRole('group', { name: 'Already cut' }))
    expect(offer.getByText(/\(Settled design\) keeps its own copy of the marks/)).toBeVisible()
    await t.user.click(offer.getByRole('button', { name: 'Clear marks' }))
    await offer.findByText(/^The marks are cleared in Design\./)
    expect(offer.queryByRole('button', { name: 'Clear marks' })).toBeNull()
    expect(t.callsOf('project.apply')).toEqual([])
    expect(preflight.getByRole('button', { name: 'Start run' })).toBeDisabled()
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

  // docs/modes/tool-holder.md#run-mode (DF132 H3)
  it('tool change whose stickout a clamp decides shows the reason line', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    t.machine.push({
      state: 'Idle',
      ...t.machine.job('toolChange', {
        toolChange: {
          n: 2,
          name: 'Flat 6, 6 mm flat, min stickout 36 mm',
          stickoutReason: 'Collet nut must clear Toe clamp 1, holder ER11',
        },
      }),
    })
    const dialog = await screen.findByRole('dialog', { name: 'Tool change 2' })
    expect(
      within(dialog).getByText(
        'Collet nut must clear Toe clamp 1, holder ER11: chuck the tool with at least the stickout above.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('note')).toHaveTextContent('Collet nut must clear')
    await expectNoAxeViolations()
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
    // DF88: "Zero X Y Z" is gone; the per-axis buttons stay in the prompt
    expect(within(prompt).getByRole('button', { name: 'Zero X' })).toBeEnabled()
    expect(within(prompt).queryByRole('button', { name: 'Zero X Y Z' })).toBeNull()
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

  // DF78: docs/modes/alignment.md#run-the-alignment-step; Q107 (assumed): the step is docked in
  // the Run inspector, the prompt points to it and keeps its start gate
  it('the alignment step runs in the docked Run panel; the prompt hands over and Start waits', async () => {
    const t = await renderRun({ bottom: true, points: true })
    const [bottom, top] = t.plan().setups
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    await within(preflight).findByText('Inside the travel at this work zero.')
    await t.user.click(within(preflight).getByRole('button', { name: 'Start run' }))
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
    const start = within(prompt).getByRole('button', { name: 'Start setup 2' })
    expect(start).toBeDisabled()
    expect(start).toHaveAccessibleDescription('Confirm the alignment first.')
    // the prompt points to the panel; no step inside it
    const handover = within(prompt).getByRole('region', { name: 'Alignment' })
    expect(within(handover).getByText(/in the Alignment panel beside the DRO/)).toBeInTheDocument()
    expect(within(prompt).queryByRole('button', { name: 'Start alignment' })).toBeNull()
    await expectNoAxeViolations()
    await t.user.click(within(handover).getByRole('button', { name: 'Align in the Run panel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // the panel beside the DRO takes the focus; the DRO stays in view
    const panel = within(inspector).getByRole('region', { name: 'Alignment of Top' })
    await waitFor(() => expect(panel).toHaveFocus())
    expect(within(inspector).getAllByText('Position').length).toBeGreaterThan(0)
    expect(
      within(panel).getByRole('img', { name: /^The stock on the machine/ }),
    ).toBeInTheDocument()
    const step = within(panel).getByRole('region', { name: 'Alignment' })
    expect(within(step).getByText(/the alignment point in turn/)).toBeInTheDocument()

    // Start alignment asks once, then sends the pointer to the work zero
    await t.user.click(within(step).getByRole('button', { name: 'Start alignment' }))
    const ask = screen.getByRole('alertdialog', {
      name: 'Move the spindle over the alignment points?',
    })
    await t.user.click(within(ask).getByRole('button', { name: 'Start alignment' }))
    expect(t.callsOf('run.align.goto')).toEqual([
      { planId: t.plan().id, setupId: top!.id, to: 'zero' },
    ])
    const list = await within(step).findByRole('list', { name: 'Alignment points' })
    const zero = within(list).getByRole('checkbox', { name: 'Work zero lines up' })
    expect(within(list).getByRole('checkbox', { name: 'Back right lines up' })).toBeDisabled()
    // Q108: the side mark's entry names the one axis it checks
    expect(within(list).getByText('Y only')).toBeInTheDocument()
    expect(within(step).getByRole('button', { name: 'Set zero here' })).toBeEnabled()
    await expectNoAxeViolations()
    await t.user.click(zero)
    expect(t.callsOf('run.align.tick')).toEqual([{ entry: 'zero', ticked: true }])

    // Next: the point; "Zero on this point" offered there; the picture highlights it
    await t.user.click(within(step).getByRole('button', { name: 'Next' }))
    expect(t.callsOf('run.align.goto').at(-1)).toMatchObject({ to: 'next' })
    await waitFor(() =>
      expect(within(list).getByRole('checkbox', { name: 'Back right lines up' })).toBeEnabled(),
    )
    expect(within(step).getByRole('button', { name: 'Zero on this point' })).toBeEnabled()
    expect(panel.querySelector('[data-align-point][data-current]')).not.toBeNull()

    // confirming with an unchecked point asks once; then back to the prompt, Start enabled
    await t.user.click(within(step).getByRole('button', { name: 'Confirm alignment' }))
    const skip = screen.getByRole('alertdialog', {
      name: '1 of 2 points not checked. Continue anyway?',
    })
    await t.user.click(within(skip).getByRole('button', { name: 'Continue' }))
    expect(t.callsOf('run.align.tick').at(-1)).toEqual({ confirm: true, skipUnticked: true })
    await within(step).findByText('Alignment confirmed, 1 not checked.')
    await t.user.click(
      within(panel).getByRole('button', { name: 'Back to the setup change (start setup 2)' }),
    )
    const again = await screen.findByRole('dialog', { name: 'Setup change: setup 2, Top' })
    expect(
      within(again).getByText('Alignment confirmed in the Alignment panel.'),
    ).toBeInTheDocument()
    expect(within(again).getByRole('button', { name: 'Start setup 2' })).toBeEnabled()
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

  it('"Resume from…" after the plan was edited: the stopped operation by id, the change said (DF85)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const plan = t.plan()
    const setup = plan.setups[0]!
    const ids = setup.operations.map((o) => o.id)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const stopped = (over: object) =>
      t.machine.push({
        state: 'Idle',
        lastRun: {
          jobId: 'run-0',
          planId: plan.id,
          setupId: setup.id,
          outcome: 'stopped',
          planOperationId: ids[1]!,
          ...over,
        },
      })
    // the plan as the run had it: no notes
    stopped({ planHash: runPlanHash(plan, setup.id), operations: ids })
    await t.user.click(await within(inspector).findByRole('button', { name: 'Resume from…' }))
    let dialog = await screen.findByRole('dialog', { name: 'Resume run?' })
    expect(within(dialog).queryByText(/The plan changed since the stop/)).toBeNull()
    await t.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // edited and in another order since: the stopped operation is still preselected by id
    stopped({ planHash: 'another', operations: [...ids].reverse() })
    await t.user.click(within(inspector).getByRole('button', { name: 'Resume from…' }))
    dialog = await screen.findByRole('dialog', { name: 'Resume run?' })
    expect(
      within(dialog).getByText(
        'The plan changed since the stop: the resumed program is exported from the current plan.',
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'The operations were reordered since the stop. Check where to resume.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Resume at' })).toHaveTextContent(
      /\(stopped here\)/,
    )
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // the stopped operation was removed: said, and the first one offered
    stopped({ planHash: 'another', operations: ids, planOperationId: 'planOp-gone' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Resume from…' }))
    dialog = await screen.findByRole('dialog', { name: 'Resume run?' })
    expect(
      within(dialog).getByText(
        'The operation the run stopped in is no longer in this setup. Choose where to resume.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Resume at' })).not.toHaveTextContent(
      /stopped here/,
    )
    await t.user.click(within(dialog).getByRole('button', { name: 'Resume run' }))
    expect(t.callsOf('run.job.start').at(-1)).toEqual({
      planId: plan.id,
      setupId: setup.id,
      from: ids[0],
    })
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
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    await t.user.click(screen.getByRole('button', { name: 'Set Y zero' }))
    expect(t.callsOf('run.workZero.set')).toEqual([{ axes: ['y'] }])
    await expectNoAxeViolations()
  })

  it('a travel refusal is worded at the end of the panel; the notice keeps its place (DF33, DF34)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const notice = within(t.nav()).getByRole('status', { name: 'Status' })
    expect(notice).toHaveTextContent('Ready to jog.')
    // DF88: the live G54 and its hint under the Position table
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(inspector).getByText(/The work zero is at machine 0/)).toBeInTheDocument()
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

  it('click = step, hold = continuous jog, cancelled on release, key up and window blur (M3, DF88)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const nav = within(t.nav())
    // no jog mode any more (DF88): the step picker stays
    expect(nav.queryByRole('radio', { name: 'Continuous' })).toBeNull()
    expect(nav.getByRole('radio', { name: '10 mm' })).toBeChecked()
    const xPlus = nav.getByRole('button', { name: 'Jog X+' })
    // a click: one step, never a continuous jog
    await t.user.click(xPlus)
    expect(t.callsOf('run.machine.jog')).toEqual([{ by: [10, 0, 0], feed: 2000 }])
    // a hold past the delay: continuous until released
    await t.user.pointer({ keys: '[MouseLeft>]', target: xPlus })
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog').at(-1)).toEqual({
        by: [1, 0, 0],
        feed: 2000,
        continuous: true,
      }),
    )
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(0)
    await t.user.pointer({ keys: '[/MouseLeft]', target: xPlus })
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1))
    expect(t.callsOf('run.machine.jog')).toHaveLength(2)
    // keyboard: Space held on a focused button, released
    const zMinus = nav.getByRole('button', { name: 'Jog Z−' })
    zMinus.focus()
    await t.user.keyboard('[Space>]')
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog').at(-1)).toEqual({
        by: [0, 0, -1],
        feed: 2000,
        continuous: true,
      }),
    )
    await t.user.keyboard('[/Space]')
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(2))
    // the window losing focus ends a hold
    await t.user.pointer({ keys: '[MouseLeft>]', target: xPlus })
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(4))
    act(() => void window.dispatchEvent(new Event('blur')))
    await waitFor(() => expect(t.callsOf('run.machine.jogCancel')).toHaveLength(3))
    await t.user.pointer({ keys: '[/MouseLeft]', target: xPlus })
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(3)
    expect(t.callsOf('run.machine.jog')).toHaveLength(4)
    await expectNoAxeViolations(t.container)
  })

  it('jog hotkeys: WASD taps step, Escape stops; not while typing (DF88)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.keyboard('d')
    expect(t.callsOf('run.machine.jog')).toEqual([{ by: [10, 0, 0], feed: 2000 }])
    // typing in the custom step field never jogs
    const field = within(t.nav()).getByRole('textbox', { name: 'Custom jog step (mm)' })
    // (focus, not a click: in jsdom every rect is 0 × 0, so the panel resize handle takes clicks)
    act(() => field.focus())
    await t.user.keyboard('w')
    expect(field).toHaveValue('w')
    expect(t.callsOf('run.machine.jog')).toHaveLength(1)
    act(() => field.blur())
    t.machine.push({ state: 'Jog' })
    await t.user.keyboard('{Escape}')
    expect(t.callsOf('run.machine.jogCancel')).toHaveLength(1)
  })

  it('a hold released before the jog is accepted cancels again once it is (M3)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    let accept: (r: CallReply) => void = () => {}
    t.bridge.handle('run.machine.jog', () => new Promise<CallReply>((r) => (accept = r)))
    const nav = within(t.nav())
    const yPlus = nav.getByRole('button', { name: 'Jog Y+' })
    await t.user.pointer({ keys: '[MouseLeft>]', target: yPlus })
    // held past the delay: the continuous jog is on its way, not yet accepted
    await waitFor(() => expect(t.callsOf('run.machine.jog')).toHaveLength(1))
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

  // DF134 (dogfood): a limit switch hit while cleaning after a run; Reset (immediate) has to lead
  // on to Home or Unlock, and a switch still pressed is named
  it('after Reset (immediate) from a hard limit: Home recommended or Unlock; a pressed switch is named (DF134)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const nav = within(t.nav())
    const text = 'Hard limit triggered. Machine position is likely lost.'
    t.machine.push({ state: 'Alarm', homed: false, alarm: { code: 1, text } })
    expect(nav.getByRole('button', { name: 'Unlock' })).toBeDisabled()
    expect(nav.getByRole('button', { name: 'Home' })).toBeDisabled()
    // reset done, the switch still pressed: release it first
    t.machine.push({ state: 'Alarm', alarm: { code: 1, text, reset: true }, pins: 'X' })
    let panel = nav.getByRole('region', { name: 'Alarm' })
    expect(
      within(panel).getByRole('heading', { name: 'Alarm 1: reset done, still locked' }),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('listitem').textContent).toMatch(
      /^The X limit switch is still pressed\. Release it, then home\./,
    )
    expect(within(panel).getByText('Inputs active: X limit switch')).toBeInTheDocument()
    expect(nav.getByRole('button', { name: 'Home' })).toBeDisabled()
    expect(nav.getByText('Release the X limit switch first.')).toBeInTheDocument()
    expect(nav.getByRole('button', { name: 'Unlock' })).toBeEnabled()
    await expectNoAxeViolations(t.container)
    // released: Home (recommended, the primary) or Unlock, one line why
    const released = { ...t.machine.status }
    delete released.pins
    t.machine.status = released
    t.machine.push({ state: 'Alarm' })
    panel = nav.getByRole('region', { name: 'Alarm' })
    expect(within(panel).getByRole('listitem').textContent).toMatch(
      /^Home the machine \(recommended\): a hard limit stops the motors at once/,
    )
    expect(within(panel).queryByText(/Inputs active/)).toBeNull()
    expect(nav.getByRole('button', { name: 'Home' })).toBeEnabled()
    expect(nav.getByRole('button', { name: 'Unlock' })).toBeEnabled()
    await t.user.click(nav.getByRole('button', { name: 'Unlock' }))
    await t.user.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(t.callsOf('run.machine.unlock')).toHaveLength(1))
    await expectNoAxeViolations(t.container)
  })

  it('the safety door outside a run: close it, then Reset (immediate) (DF134)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    const nav = within(t.nav())
    t.machine.push({ state: 'Door:1', pins: 'D' })
    let panel = nav.getByRole('region', { name: 'Safety door' })
    expect(within(panel).getByRole('heading', { name: 'Safety door open' })).toBeInTheDocument()
    expect(within(panel).getByText('Inputs active: safety door')).toBeInTheDocument()
    const closed = { ...t.machine.status }
    delete closed.pins
    t.machine.status = closed
    t.machine.push({ state: 'Door:0' })
    panel = nav.getByRole('region', { name: 'Safety door' })
    expect(within(panel).getByText(/^Reset \(immediate\) to continue/)).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
    t.machine.push({ state: 'Idle' })
    expect(nav.queryByRole('region', { name: 'Safety door' })).toBeNull()
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

  it("the toolbar's Resume resumes this window's held Probe Z job (DF82)", async () => {
    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    // the probe runs until the test lets job.wait answer
    let finish: () => void = () => {}
    t.bridge.handle(
      'job.wait',
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok({ state: 'finished', outcome: { ok: true, value: {} } }))
        }),
    )
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Probe Z' }))
    await t.user.click(
      within(screen.getByRole('alertdialog', { name: 'Probe Z?' })).getByRole('button', {
        name: 'Probe',
      }),
    )
    const group = machineGroup()!
    // held from elsewhere (the job list, an agent): decelerating, then held
    t.machine.push({ state: 'Hold:1' })
    expect(await within(group).findByRole('button', { name: 'Resume' })).toBeDisabled()
    t.machine.push({ state: 'Hold:0' })
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Resume' })).not.toBeDisabled(),
    )
    await t.user.click(within(group).getByRole('button', { name: 'Resume' }))
    expect(t.callsOf('job.resume')).toEqual([{ jobId: 'probe-1' }])
    // once the probe ended, a Hold without a run offers no Resume (nothing of this window's to resume)
    finish()
    t.machine.push({ state: 'Idle' })
    await waitFor(() => expect(within(group).queryByRole('button', { name: 'Resume' })).toBeNull())
    t.machine.push({ state: 'Hold:0' })
    expect(within(group).queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  // DF82: a hold DFYOM did not send (the machine's hold button, its safety door) is resumed from
  // the toolbar like the app's own (docs/modes/run.md#external-holds-df82)
  it("the machine's hold button and safety door: the badge says so; Resume resumes the run", async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await t.user.click(within(inspector).getByRole('button', { name: 'Start run' }))
    const preflight = screen.getByRole('dialog', { name: 'Start run?' })
    const start = within(preflight).getByRole('button', { name: 'Start run' })
    await waitFor(() => expect(start).not.toBeDisabled())
    await t.user.click(start)
    const group = machineGroup()!
    await within(group).findByText('Running', { selector: '[data-state]' })
    const held = { ...t.machine.status.job!, phase: 'held' as const }
    // the hold button: decelerating, then held by the machine
    t.machine.push({ state: 'Hold:1', holdBy: 'machine' })
    await within(group).findByText('Holding…', { selector: '[data-state]' })
    t.machine.push({ state: 'Hold:0', holdBy: 'machine', job: held })
    await within(group).findByText('Held (machine button)', { selector: '[data-state]' })
    const resume = within(group).getByRole('button', { name: 'Resume' })
    expect(resume).not.toBeDisabled()
    await t.user.click(resume)
    expect(t.callsOf('job.resume')).toEqual([{ jobId: 'run-1' }])
    // the safety door: no Resume while it is open; once closed, Resume continues
    t.machine.push({ state: 'Door:1', job: held })
    await within(group).findByText('Door open', { selector: '[data-state]' })
    expect(within(group).getByRole('button', { name: 'Resume' })).toBeDisabled()
    t.machine.push({ state: 'Door:0', job: held })
    await within(group).findByText('Held (door closed)', { selector: '[data-state]' })
    await t.user.click(within(group).getByRole('button', { name: 'Resume' }))
    expect(t.callsOf('job.resume')).toEqual([{ jobId: 'run-1' }, { jobId: 'run-1' }])
  })

  it("the machine's hold button during this window's Probe Z: Resume resumes the probe (DF82)", async () => {
    const t = await renderRun({ plate: '10' })
    await connectAndHome(t)
    t.bridge.handle('job.wait', () => new Promise(() => {}))
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Probe Z' }))
    await t.user.click(
      within(screen.getByRole('alertdialog', { name: 'Probe Z?' })).getByRole('button', {
        name: 'Probe',
      }),
    )
    const group = machineGroup()!
    // the safety door: Resume once it is closed
    t.machine.push({ state: 'Door:1' })
    await within(group).findByText('Door open', { selector: '[data-state]' })
    expect(within(group).getByRole('button', { name: 'Resume' })).toBeDisabled()
    t.machine.push({ state: 'Door:0' })
    await within(group).findByText('Held (door closed)', { selector: '[data-state]' })
    expect(within(group).getByRole('button', { name: 'Resume' })).not.toBeDisabled()
    // the hold button
    t.machine.push({ state: 'Hold:0', holdBy: 'machine' })
    await within(group).findByText('Held (machine button)', { selector: '[data-state]' })
    await t.user.click(within(group).getByRole('button', { name: 'Resume' }))
    expect(t.callsOf('job.resume')).toEqual([{ jobId: 'probe-1' }])
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
    // Run, Overrides and Machine settings (v0.5 RV2) take the inspectors' group header style
    // (DF110 S6): h3 titles, Reset none
    expect(inspector.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Run',
      'Overrides',
      'Machine settings',
    ])
    expect(inspector.getByRole('region', { name: 'Reset (immediate)' })).toBeInTheDocument()
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

  it('"Don\'t ask again" skips the Home confirmation for this machine; Settings asks again (DF88)', async () => {
    // a library machine in the plan: the key the choice is stored under
    const t = await renderRun({ plate: '10' })
    scriptSerial(t, true)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    await waitFor(() => expect(nav.getByRole('button', { name: 'Connect' })).toBeEnabled())
    await t.user.click(nav.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('group', { name: 'Machine' })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Home the machine?' })
    const dontAsk = within(dialog).getByRole('checkbox', {
      name: 'Don’t ask again for this machine',
    })
    expect(dontAsk).not.toBeChecked()
    await expectNoAxeViolations()
    await t.user.click(dontAsk)
    await t.user.click(within(dialog).getByRole('button', { name: 'Home' }))
    await waitFor(() => expect(t.callsOf('run.machine.home')).toHaveLength(1))
    const patch = t.bridge.settingsPatches.at(-1) as { skipHomeConfirm?: string[] }
    expect(patch.skipHomeConfirm).toHaveLength(1)
    // locked again (not homed): Home again, no question
    t.machine.push({ state: 'Alarm', homed: false })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    await waitFor(() => expect(t.callsOf('run.machine.home')).toHaveLength(2))
    expect(screen.queryByRole('alertdialog', { name: 'Home the machine?' })).toBeNull()
    // Settings → Homing confirmation → "Ask again for every machine"
    act(() => t.shell.ui.getState().setSettingsOpen(true))
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    await t.user.click(
      within(settings).getByRole('button', { name: 'Ask again for every machine' }),
    )
    expect(t.bridge.settingsPatches.at(-1)).toEqual({ skipHomeConfirm: [] })
    expect(
      within(settings).getByRole('button', { name: 'Ask again for every machine' }),
    ).toBeDisabled()
    act(() => t.shell.ui.getState().setSettingsOpen(false))
    t.machine.push({ state: 'Alarm', homed: false })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    await screen.findByRole('alertdialog', { name: 'Home the machine?' })
    expect(t.callsOf('run.machine.home')).toHaveLength(2)
  })

  it('the settings warning is checked again after a library change (DF87)', async () => {
    const t = await renderRun()
    scriptSerial(t, false)
    const nav = within(t.nav())
    await t.user.click(nav.getByRole('radio', { name: 'Serial port' }))
    await waitFor(() => expect(nav.getByRole('button', { name: 'Connect' })).toBeEnabled())
    await t.user.click(nav.getByRole('button', { name: 'Connect' }))
    await nav.findByRole('alert')
    // the user fixed the machine in the Library: the warning goes without reconnecting
    t.bridge.handle('run.settings.check', () =>
      ok({
        settingsCheck: {
          against: 'plan',
          matches: true,
          homingEnabled: true,
          notInMachine: [],
          differences: [],
        },
      }),
    )
    t.bridge.emitLibraryChange({ kind: 'machine', id: 'm', change: 'updated', revision: 2 })
    await waitFor(() => expect(nav.queryByRole('alert')).toBeNull())
    expect(t.callsOf('run.settings.check').at(-1)).toMatchObject({ planId: expect.any(String) })
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

  it('chooses a serial port by default, listed first, and lists the ports at once (DF101)', async () => {
    const bridge = createFakeBridge()
    const s = await planSetup()
    await s.create()
    bridge.bind(s.d)
    scriptMachine(bridge)
    bridge.handle('run.ports.scan', () =>
      ok({ ports: [{ path: PORT, manufacturer: 'Arduino (www.arduino.cc)', usb: true }] }),
    )
    const shell = createShell(bridge)
    shell.ui.getState().setMode('run')
    renderUi(
      <ShellProvider shell={shell}>
        <App />
      </ShellProvider>,
    )
    const nav = within(screen.getByRole('navigation', { name: 'Navigator' }))
    const choice = await nav.findByRole('radiogroup', { name: 'Connect to' })
    const radios = within(choice).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Serial port', 'Virtual machine'])
    expect(radios[0]).toBeChecked()
    // the ports are listed without choosing Serial port first; the USB one is chosen
    await waitFor(() =>
      expect(nav.getByRole('combobox', { name: 'Serial port' })).toHaveTextContent(
        `${PORT} · Arduino`,
      ),
    )
    expect(bridge.calls.filter((c) => c.name === 'run.ports.scan')).toHaveLength(1)
    expect(nav.queryByRole('combobox', { name: 'Time scale' })).toBeNull()
    await waitFor(() => expect(nav.getByRole('button', { name: 'Connect' })).toBeEnabled())
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

/**
 * Run without a project (DF80): no project bound, the app-scope dispatcher answers the library
 * (a machine with a touch plate), the scripted machine the run commands.
 */
async function renderNoProject(mode: 'run' | 'design' = 'run') {
  const library = (await Library.open(createMemoryLibraryStorage())).unwrap()
  const d = await designDispatcher('App', 'mm', { library })
  const add = await d.dispatch(
    'library.machine.add',
    { values: { ...libraryInput(machineValues()), name: 'Router', probePlateThickness: '10' } },
    { kind: 'ui', id: 'test' },
  )
  const machineId = (add.unwrap().value as { id: string }).id
  const bridge = createFakeBridge()
  bridge.appScope(d, library)
  const machine = scriptMachine(bridge) as Machine & {
    job: (phase: NonNullable<RunStatus['job']>['phase'], extra?: object) => Partial<RunStatus>
  }
  const shell = createShell(bridge)
  shell.ui.getState().setMode(mode)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  // the virtual machine, not the default serial port (DF101)
  if (mode === 'run')
    await r.user.click(await within(nav()).findByRole('radio', { name: 'Virtual machine' }))
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  return { ...r, bridge, machine, nav, callsOf, machineId, shell }
}

describe('Run mode without a project (DF80)', () => {
  it('controls the machine: library machine, connect, home, jog, zero, probe, overrides, disconnect', async () => {
    const t = await renderNoProject()
    const nav = within(t.nav())
    // no plan to choose: the machine select, with the library's machine chosen
    const connect = await nav.findByRole('button', { name: 'Connect' })
    expect(nav.queryByRole('combobox', { name: 'Plan' })).toBeNull()
    await waitFor(() =>
      expect(nav.getByRole('combobox', { name: 'Machine' })).toHaveTextContent('Router'),
    )
    expect(
      nav.getByText('The machine profile sets the travel, the soft limits and the probe plate.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No project open' })).toBeNull()
    // the inspector: the DRO, and the run part as an empty state with Open project
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    expect(inspector.getByRole('table', { name: 'Position' })).toBeInTheDocument()
    expect(
      inspector.getByRole('heading', { name: 'Open a project to run a plan' }),
    ).toBeInTheDocument()
    expect(inspector.getByRole('button', { name: 'Open project' })).toBeEnabled()
    expect(inspector.queryByRole('button', { name: 'Start run' })).toBeNull()
    await expectNoAxeViolations(t.container)

    await waitFor(() => expect(connect).toBeEnabled())
    await t.user.click(connect)
    expect(t.callsOf('run.connection.open')).toEqual([
      { target: 'virtual', machineId: t.machineId, timeScale: 1 },
    ])
    await screen.findByRole('group', { name: 'Machine' })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    await within(machineGroup()!).findByText('Idle')
    await t.user.click(nav.getByRole('button', { name: 'Jog X+' }))
    expect(t.callsOf('run.machine.jog')).toEqual([{ by: [10, 0, 0], feed: expect.any(Number) }])
    await t.user.click(inspector.getByRole('button', { name: 'Set Z zero' }))
    expect(t.callsOf('run.workZero.set')).toEqual([{ axes: ['z'] }])
    // the plate thickness comes from the machine profile
    expect(nav.getByText(/Touch plate 10(\.0+)? mm/)).toBeInTheDocument()
    await t.user.click(nav.getByRole('button', { name: 'Probe Z' }))
    await t.user.click(
      within(screen.getByRole('alertdialog', { name: 'Probe Z?' })).getByRole('button', {
        name: 'Probe',
      }),
    )
    expect(t.callsOf('run.machine.probeZ')).toEqual([{ plateThickness: 10 }])
    const overrides = within(inspector.getByRole('region', { name: 'Overrides' }))
    await t.user.click(
      within(overrides.getByRole('group', { name: 'Feed' })).getByRole('button', {
        name: 'Increase feed override by 10 %',
      }),
    )
    expect(t.callsOf('run.override.set')).toEqual([{ feed: '+10' }])
    await expectNoAxeViolations(t.container)
    await t.user.click(nav.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(machineGroup()).toBeNull())
    expect(t.callsOf('run.job.start')).toEqual([])
  })

  it('a run started elsewhere shows from the status; no Start run here (M7)', async () => {
    const t = await renderNoProject()
    await within(t.nav()).findByRole('button', { name: 'Connect' })
    t.machine.push({
      connection: { state: 'open', target: 'virtual', timeScale: 1 },
      state: 'Run',
      homed: true,
      ...t.machine.job('streaming', {
        plan: {
          planId: 'p1',
          planName: 'Plan 1',
          setupId: 's1',
          setupName: 'Top',
          setup: 1,
          setups: 1,
        },
      }),
    })
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    expect(await inspector.findByText(/Plan 1/)).toBeInTheDocument()
    expect(inspector.getByText('Started in another window or by an agent.')).toBeInTheDocument()
    expect(inspector.queryByRole('heading', { name: 'Open a project to run a plan' })).toBeNull()
    expect(within(machineGroup()!).getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('the start panel goes to Run without creating a project', async () => {
    const t = await renderNoProject('design')
    const nav = within(t.nav())
    await nav.findByRole('heading', { name: 'No project open' })
    await t.user.click(nav.getByRole('button', { name: 'Go to Run' }))
    expect(screen.getByRole('radio', { name: 'Run' })).toBeChecked()
    expect(await within(t.nav()).findByRole('combobox', { name: 'Machine' })).toBeInTheDocument()
    await expectNoAxeViolations(t.container)
  })
})

const FUSION = [
  '%',
  '(T1 D=6 CR=0 - flat end mill)',
  '(T2 D=3 CR=0 - flat end mill)',
  'G90 G94 G17',
  'G21',
  'T1 M6',
  'S12000 M3',
  'G0 X5 Y5 Z15',
  'G1 Z-1 F300',
  'G1 X40 F800',
  'G0 Z15',
  'T2 M6',
  'S16000 M3',
  'G1 Z-2 F200',
  'G0 Z15',
  'M30',
  '%',
].join('\n')

describe('an external gCode file without a project (DF93)', () => {
  it('main hands the window a file: Run mode, its card and lines, pre-flight, run, status', async () => {
    const t = await renderNoProject('design')
    t.bridge.setRunFile('/cam/fusion.nc', FUSION)
    act(() => t.bridge.emitShowRunFile('/cam/fusion.nc'))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Run' })).toBeChecked())
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    expect(await inspector.findByText('File fusion.nc')).toBeInTheDocument()
    expect(inspector.getByText('1: D=6 CR=0 - flat end mill')).toBeInTheDocument()
    expect(inspector.getByText('2: D=3 CR=0 - flat end mill')).toBeInTheDocument()
    expect(inspector.getByText('X 5.000 to 40.000 mm')).toBeInTheDocument()
    expect(inspector.queryByRole('heading', { name: 'Open a project to run a plan' })).toBeNull()
    // the gCode panel shows the prepared program before the run: M6 became the marker and M0
    const panel = within(screen.getByRole('region', { name: 'gCode' }))
    expect(
      await panel.findByText('(DFYOM TOOL CHANGE 1: D=6 CR=0 - flat end mill)'),
    ).toBeInTheDocument()
    await expectNoAxeViolations(t.container)

    // connect (the virtual machine, not the default serial port, DF101), home: Start run opens the
    // file's pre-flight
    const nav = within(t.nav())
    await t.user.click(await nav.findByRole('radio', { name: 'Virtual machine' }))
    const connect = await nav.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).toBeEnabled())
    await t.user.click(connect)
    await screen.findByRole('group', { name: 'Machine' })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    await within(machineGroup()!).findByText('Idle')
    await t.user.click(inspector.getByRole('button', { name: 'Start run' }))
    const preflight = within(await screen.findByRole('dialog', { name: 'Start run?' }))
    expect(preflight.getByText('fusion.nc')).toBeInTheDocument()
    expect(await preflight.findByText('Inside the travel at this work zero.')).toBeInTheDocument()
    expect(t.callsOf('run.job.check')).toEqual([{ file: '/cam/fusion.nc' }])
    await expectNoAxeViolations(t.container)
    await t.user.click(preflight.getByRole('button', { name: 'Start run' }))
    expect(t.callsOf('run.job.start')).toEqual([{ file: '/cam/fusion.nc' }])
    // the status names the file (M7 for files)
    t.machine.push(
      t.machine.job('streaming', { file: { name: 'fusion.nc', path: '/cam/fusion.nc' } }),
    )
    expect(await inspector.findByText('File fusion.nc')).toBeInTheDocument()
    expect(inspector.getByRole('progressbar', { name: 'Run progress' })).toBeInTheDocument()
  })

  it('refused lines keep Start disabled; the open button and the recent files ask main', async () => {
    const t = await renderNoProject()
    t.bridge.setRunFile('/cam/g28.nc', 'G21 G90\nG28 G91 Z0\nG0 X1\n')
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    t.bridge.setRunFileChoice('/cam/g28.nc')
    await t.user.click(await inspector.findByRole('button', { name: 'Run gCode file…' }))
    expect(t.bridge.runFileOpens).toEqual([undefined])
    expect(await inspector.findByText('1 line cannot run')).toBeInTheDocument()
    expect(inspector.getByText(/^Line 2: G28/)).toBeInTheDocument()
    expect(inspector.getByRole('button', { name: 'Start run' })).toBeDisabled()
    // close it: the recent files offer it again
    await t.user.click(inspector.getByRole('button', { name: 'Close file' }))
    const recent = within(await inspector.findByRole('navigation', { name: 'Recent files' }))
    await t.user.click(recent.getByRole('button', { name: 'g28.nc' }))
    expect(t.bridge.runFileOpens).toEqual([undefined, '/cam/g28.nc'])
    await inspector.findByText('1 line cannot run')
    await expectNoAxeViolations(t.container)
  })

  it('"Start from here…" on a file\'s line opens the pre-flight at the resume point before it (DF129 RC3)', async () => {
    const t = await renderNoProject()
    const lines = prepareGcodeFile(FUSION).lines
    t.machine.fileLines = lines
    t.bridge.setRunFile('/cam/fusion.nc', FUSION)
    act(() => t.bridge.emitShowRunFile('/cam/fusion.nc'))
    const nav = within(t.nav())
    const connect = await nav.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).toBeEnabled())
    await t.user.click(connect)
    await screen.findByRole('group', { name: 'Machine' })
    await t.user.click(nav.getByRole('button', { name: 'Home' }))
    await within(machineGroup()!).findByText('Idle')
    const asked = lines.indexOf('G1 X40 F800') + 1
    const point = resumePoints(scanProgram(lines))
      .filter((p) => p.line < asked)
      .at(-1)!.line
    const panel = screen.getByRole('region', { name: 'gCode' })
    const row = await waitFor(() => panel.querySelector(`[data-line="${asked}"]`)!)
    fireEvent.contextMenu(row)
    await t.user.click(await screen.findByRole('menuitem', { name: 'Start from here…' }))
    const preflight = within(await screen.findByRole('dialog', { name: 'Start run?' }))
    expect(
      preflight.getByText(
        `Line ${asked} is not a resume point: the run starts at the pass start on line ${point} before it.`,
      ),
    ).toBeInTheDocument()
    expect(
      await preflight.findByText(/^The run first waits at tool 1: D=6 CR=0 - flat end mill$/),
    ).toBeInTheDocument()
    expect(t.callsOf('run.job.check').at(-1)).toEqual({ file: '/cam/fusion.nc', fromLine: point })
    // the asked line anyway: inside the cut
    await t.user.click(preflight.getByRole('button', { name: `Start at line ${asked} anyway` }))
    expect(await preflight.findByText(/^The line starts in the material/)).toBeInTheDocument()
    const start = preflight.getByRole('button', { name: `Start at line ${asked}` })
    await waitFor(() => expect(start).toBeEnabled())
    await expectNoAxeViolations(t.container)
    await t.user.click(start)
    expect(t.callsOf('run.job.start')).toEqual([
      { file: '/cam/fusion.nc', fromLine: asked, programHash: 'hash-1' },
    ])
  })

  it('a file that cannot be read says so', async () => {
    const t = await renderNoProject()
    t.bridge.setRunFile('/cam/gone.nc', null)
    act(() => t.bridge.emitShowRunFile('/cam/gone.nc'))
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
    expect(await inspector.findByText('gone.nc cannot be read.')).toBeInTheDocument()
    expect(inspector.getByRole('button', { name: 'Close file' })).toBeEnabled()
  })
})

// DF129 RC5: the recovery panel (docs/modes/run-recovery.md#implementation-rc5)
describe('Recovery panel (DF129 RC5)', () => {
  /** A plan run streaming, then lost: the status main pushes with the interruption. */
  async function interrupted(
    t: Awaited<ReturnType<typeof renderRun>>,
    patch: { programHash?: string; reason?: 'connectionLost' | 'controllerReset' } = {},
  ) {
    const plan = t.plan()
    const setup = plan.setups[0]!
    const ops = setup.operations
    if (t.machine.status.job === undefined) await streaming(t)
    t.machine.outcome = {
      ok: false,
      error: { code: 'machine.connection', message: 'connection lost', issues: [], frames: [] },
    }
    const lost = patch.reason !== 'controllerReset'
    t.machine.status = {
      ...closedStatus(),
      connection: {
        state: lost ? 'closed' : 'open',
        timeScale: 1,
        ...(lost
          ? {
              lost: { target: 'virtual' as const },
              reconnect: { phase: 'waiting' as const, attempt: 1, nextAt: Date.now() + 4000 },
            }
          : { target: 'virtual' as const }),
      },
      ...(lost ? {} : { state: 'Alarm', homed: false }),
    }
    t.machine.push({
      lastRun: {
        jobId: 'run-1',
        planId: plan.id,
        setupId: setup.id,
        outcome: 'failed',
        operations: ops.map((o) => o.id),
        interruption: {
          reason: patch.reason ?? 'connectionLost',
          at: '2026-11-27T14:32:07Z',
          startedAt: '2026-11-27T14:09:07Z',
          lines: 20,
          sent: 19,
          acknowledged: 17,
          executing: 16,
          executingFrom: 'estimate',
          lastReport: {
            at: '2026-11-27T14:32:06.800Z',
            state: 'Run',
            mpos: [-290, -190, -51],
            wpos: [12, 10, -1.5],
            feed: 600,
            spindle: 18000,
          },
          workZero: { start: [0, 0, 0], last: [0, 0, 0] },
          tool: { n: 1, name: 'Flat 6' },
          operation: { planOperationId: ops[0]!.id, label: 'Pocket 1' },
          spindle: { dir: 'cw', rpm: 18000 },
          programHash: patch.programHash ?? 'hash-1',
          suggestion: { line: 15, kind: 'pass' },
          safest: { line: 10, kind: 'operation', label: 'Pocket 1 · tool 1: Flat 6' },
        },
      },
    })
  }

  async function streaming(t: Awaited<ReturnType<typeof renderRun>>) {
    const plan = t.plan()
    const setup = plan.setups[0]!
    t.machine.push({
      state: 'Run',
      ...t.machine.job('streaming', {
        plan: {
          planId: plan.id,
          planName: plan.name,
          setupId: setup.id,
          setupName: setup.name,
          setup: 1,
          setups: 1,
        },
      }),
    })
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await within(inspector).findByText(plan.name)
  }

  it('the sheet, then one step at a time: reconnect, check, home, the work zero, resume near where it stopped', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    await interrupted(t)
    // the failure dialog is the short, calm sheet
    const sheet = await screen.findByRole('dialog', { name: 'The run was interrupted' })
    expect(within(sheet).getByText(/23 min into the run/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /stopped with an error/ })).toBeNull()
    await t.user.click(within(sheet).getByRole('button', { name: 'Show the steps' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const panel = within(inspector).getByRole('region', { name: 'The run was interrupted' })
    // no "Start run" while the panel shows, nor "No run yet…" (RC6 screenshots)
    expect(within(inspector).queryByRole('button', { name: 'Start run' })).toBeNull()
    expect(within(inspector).queryByText(/^No run yet/)).toBeNull()
    // the run scene asks once for the plan's missing toolpaths, to draw them with the ghost (RC6)
    await waitFor(() =>
      expect(t.callsOf('plan.toolpath.generate')).toEqual([{ planId: t.plan().id }]),
    )
    // where the job was, each with its source
    expect(panel).toHaveTextContent('Pocket 1 (operation 1 of')
    expect(panel).toHaveTextContent('Tool 1: Flat 6')
    expect(panel).toHaveTextContent('X 12.000 Y 10.000 Z -1.500')
    expect(panel).toHaveTextContent('0.2 s before the run ended')
    expect(panel).toHaveTextContent('It was cutting around lines 16–17')
    expect(panel).toHaveTextContent('may have continued up to line 19')
    expect(panel).toHaveTextContent('Estimated from the last status report.')
    // step 1: the safety line and the live reconnect state
    const steps = within(panel).getByRole('list', { name: 'Steps' })
    expect(within(steps).getByRole('button', { name: /Make it safe/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(panel).toHaveTextContent('The machine may still be moving')
    expect(panel).toHaveTextContent(/Reconnecting… attempt 1 failed, next in [1-4] s/)
    await expectNoAxeViolations()
    await t.user.click(within(panel).getByRole('button', { name: 'Reconnect now' }))
    expect(t.bridge.recoveries).toEqual(['reconnectNow'])
    // reconnected: locked, not homed; step 1 ticks itself, step 2 opens
    t.machine.push({
      connection: {
        state: 'open',
        target: 'virtual',
        timeScale: 1,
        reconnect: { phase: 'reconnected', attempt: 2 },
      },
      state: 'Alarm',
      homed: false,
    })
    expect(await within(steps).findByRole('button', { name: /Check the machine/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(panel).toHaveTextContent('Reconnected. The controller restarted')
    await t.user.click(within(panel).getByRole('checkbox', { name: /The bit is intact/ }))
    await t.user.click(within(panel).getByRole('checkbox', { name: /Chips are cleared/ }))
    await t.user.click(within(panel).getByRole('button', { name: 'Checked' }))
    expect(panel).toHaveTextContent('2 of 3 checked.')
    // step 3: home (the virtual machine: no confirmation)
    await t.user.click(await within(panel).findByRole('button', { name: 'Home the machine' }))
    expect(t.callsOf('run.machine.home').length).toBeGreaterThanOrEqual(2)
    // step 4: the work zero as during the run; the stock was not ticked: re-zero X/Y
    expect(await within(panel).findByText(/The controller kept the work zero/)).toBeVisible()
    expect(panel).toHaveTextContent('You did not tick “the stock has not moved”')
    // Go to the last position: GoTo's safe order, confirmed first
    await t.user.click(within(panel).getByRole('button', { name: 'Go to the last position' }))
    const go = await screen.findByRole('dialog', { name: 'Go to the last position?' })
    expect(within(go).getByRole('list')).toHaveTextContent(/Up to Z .*Across to X/)
    await t.user.click(within(go).getByRole('button', { name: 'Move' }))
    await waitFor(() =>
      expect(t.callsOf('run.machine.jog').map((a) => (a as { to?: number[] }).to?.[0])).toContain(
        -290,
      ),
    )
    await t.user.click(within(panel).getByRole('button', { name: 'The work zero is right' }))
    // step 5: the options, the suggestion first and marked
    const near = await within(panel).findByRole('button', { name: /Resume near where it stopped/ })
    expect(near).toHaveTextContent('Recommended')
    expect(near).toHaveTextContent('line 15')
    expect(
      within(panel).getByRole('button', { name: /Resume from the operation’s start/ }),
    ).toHaveTextContent('line 10')
    await expectNoAxeViolations()
    await t.user.click(near)
    // the RC3 pre-flight at the suggested line, bound to the run's program
    const preflight = await screen.findByRole('dialog', { name: 'Start run?' })
    const start = await within(preflight).findByRole('button', { name: 'Start at line 15' })
    await waitFor(() => expect(start).toBeEnabled())
    await t.user.click(start)
    expect(t.callsOf('run.job.start').at(-1)).toMatchObject({
      planId: t.plan().id,
      fromLine: 15,
      programHash: 'hash-1',
    })
  })

  it('a program changed since the run: the pre-flight says so and does not start at the line', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    await interrupted(t, { programHash: 'another', reason: 'controllerReset' })
    await t.user.click(await screen.findByRole('button', { name: 'Later' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const panel = within(inspector).getByRole('region', { name: 'The run was interrupted' })
    // a controller reset: no "Make it safe" step (the reset stopped it)
    expect(within(panel).queryByRole('button', { name: /Make it safe/ })).toBeNull()
    expect(panel).toHaveTextContent('The controller restarted by itself')
    t.machine.push({ state: 'Idle', homed: true })
    await t.user.click(within(panel).getByRole('button', { name: /Choose how to continue/ }))
    await t.user.click(within(panel).getByRole('button', { name: /Resume near where it stopped/ }))
    const preflight = await screen.findByRole('dialog', { name: 'Start run?' })
    expect(
      await within(preflight).findByText(
        'The plan changed since the run: resume from an operation instead.',
      ),
    ).toBeVisible()
    expect(within(preflight).getByRole('button', { name: /Start/ })).toBeDisabled()
  })

  it('"The machine lost power" after a Stop; "Dismiss…" asks once (Q171)', async () => {
    const t = await renderRun()
    await connectAndHome(t)
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await streaming(t)
    t.machine.outcome = {
      ok: false,
      error: { code: 'op.aborted', message: 'aborted', issues: [], frames: [] },
    }
    const { job: _job, ...idle } = t.machine.status
    t.machine.status = idle
    t.machine.push({ state: 'Idle' })
    const power = await within(inspector).findByRole('button', { name: 'The machine lost power' })
    expect(power).toHaveAccessibleDescription(/marks the position lost/)
    await t.user.click(power)
    expect(t.bridge.recoveries).toEqual(['powerLost'])
    // main answers with the record: the panel takes the run section
    await interrupted(t, { reason: 'controllerReset' })
    const panel = await within(inspector).findByRole('region', { name: 'The run was interrupted' })
    await t.user.click(within(panel).getByRole('button', { name: 'Dismiss…' }))
    expect(panel).toHaveTextContent('Forget where the job stopped?')
    await t.user.click(within(panel).getByRole('button', { name: 'Forget it' }))
    expect(t.bridge.recoveries).toEqual(['powerLost', 'dismiss'])
  })
})

describe('After a crash (DF129 RC6)', () => {
  const lines = ['G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X10 F600', 'G1 X20', 'G1 X30']
  /** The record main restores at launch from a leftover journal: a file run on `machine`. */
  function launched(
    t: Awaited<ReturnType<typeof renderRun>>,
    machine: { target: 'virtual' | 'serial'; port?: { path: string; baud: number } },
    file: 'same' | 'changed' | 'missing' = 'same',
  ) {
    t.machine.push({
      lastRun: {
        jobId: 'run-9',
        file: { name: 'lid.nc', path: '/w/lid.nc' },
        outcome: 'failed',
        interruption: {
          reason: 'appCrashed',
          at: '2026-11-27T14:32:07Z',
          startedAt: '2026-11-27T14:09:07Z',
          lines: lines.length,
          sent: 7,
          acknowledged: 6,
          executing: 5,
          executingFrom: 'estimate',
          lastReport: {
            at: '2026-11-27T14:32:06.800Z',
            state: 'Run',
            mpos: [-290.123456, -190.654321, -51.5],
            wpos: [-1234.567, -2345.678, -101.5],
            feed: 600,
            spindle: 18000,
          },
          workZero: { start: [0, 0, 0], last: [0, 0, 0] },
          spindle: { dir: 'cw', rpm: 18000 },
          programHash: 'hash-9',
          suggestion: { line: 4, kind: 'pass' },
          launch: { machine, file, program: true },
        },
      },
    })
  }

  it('offered at launch: Run mode, open the file, connect to the virtual machine; axe-clean', async () => {
    const t = await renderRun()
    t.bridge.setRunFile('/w/lid.nc', lines.join('\n'))
    t.shell.ui.getState().setMode('design')
    launched(t, { target: 'virtual' })
    // main asks the first window to show the panel: Run mode
    t.bridge.emitShowRecovery()
    await waitFor(() => expect(t.shell.ui.getState().mode).toBe('run'))
    await t.user.click(await screen.findByRole('button', { name: 'Inspector' }))
    const inspector = await screen.findByRole('complementary', { name: 'Inspector' })
    const panel = await within(inspector).findByRole('region', { name: 'The run was interrupted' })
    expect(panel).toHaveTextContent('DFYOM was closed unexpectedly while the run was streaming')
    expect(panel).toHaveTextContent('File lid.nc')
    // the long coordinates: each axis one unbreakable piece
    expect(within(panel).getAllByText(/^(X -1234\.567|Y -2345\.678)$/)).toHaveLength(2)
    // the virtual machine: no "Make it safe" step (nothing ran on after the app went)
    expect(within(panel).queryByRole('button', { name: /Make it safe/ })).toBeNull()
    await expectNoAxeViolations()
    await t.user.click(within(panel).getByRole('button', { name: 'Open file' }))
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Open file' })).toBeNull(),
    )
    // the file is ready, but an interrupted run is not "No run yet…"
    expect(within(inspector).queryByText(/^No run yet/)).toBeNull()
    // the checklist, then connect: never by itself after a restart (Q158)
    await t.user.click(within(panel).getByRole('button', { name: 'Checked' }))
    expect(
      await within(panel).findByText(/DFYOM does not connect by itself after a restart/),
    ).toBeVisible()
    expect(t.callsOf('run.connection.open')).toHaveLength(0)
    await t.user.click(
      within(panel).getByRole('button', { name: 'Connect to the virtual machine' }),
    )
    await waitFor(() => expect(t.callsOf('run.connection.open')).toHaveLength(1))
    expect(t.callsOf('run.connection.open')[0]).toMatchObject({ target: 'virtual' })
  })

  it('a serial machine: Make it safe first; a port that is not listed says so; a changed file', async () => {
    const t = await renderRun()
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    launched(
      t,
      { target: 'serial', port: { path: '/dev/cu.usbmodem1101', baud: 115_200 } },
      'changed',
    )
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const panel = await within(inspector).findByRole('region', { name: 'The run was interrupted' })
    expect(within(panel).getByRole('button', { name: /Make it safe/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(panel).toHaveTextContent('the spindle may still be on')
    expect(panel).toHaveTextContent('The file changed since the run')
    expect(within(panel).getByRole('button', { name: 'Locate file…' })).toBeVisible()
    await t.user.click(
      within(panel).getByRole('button', { name: 'Connect to /dev/cu.usbmodem1101' }),
    )
    expect(
      await within(panel).findByText(
        '/dev/cu.usbmodem1101 is not listed: plug the machine in, then connect.',
      ),
    ).toBeVisible()
    expect(t.callsOf('run.connection.open')).toHaveLength(0)
    await expectNoAxeViolations()
  })

  it('the Position menu: "The machine lost power…" while idle, confirmed (Q171)', async () => {
    const t = await renderRun()
    await t.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const openMenu = async () => {
      within(inspector).getByRole('button', { name: 'Position options' }).focus()
      await t.user.keyboard('{Enter}')
      return screen.findByRole('menuitem', { name: /The machine lost power/ })
    }
    // not connected: the entry says when it is offered
    const off = await openMenu()
    expect(off).toHaveAttribute('aria-disabled', 'true')
    expect(off).toHaveTextContent('Only while the machine is connected, homed and idle.')
    await t.user.keyboard('{Escape}')
    await connectAndHome(t)
    await t.user.click(await openMenu())
    const ask = await screen.findByRole('alertdialog', { name: 'The machine lost power?' })
    await expectNoAxeViolations()
    await t.user.click(within(ask).getByRole('button', { name: 'Mark the position lost' }))
    expect(t.bridge.recoveries).toEqual(['powerLost'])
  })
})
