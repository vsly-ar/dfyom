// Pure run-mode view logic over `RunStatus`: the machine state badge, what each control may do
// right now (and why not), DRO formatting. Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-v0.1.md#status
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import { runMessages as m } from '../../messages/run'
import type { MachineState } from '../../ui'

type Phase = NonNullable<RunStatus['job']>['phase']

/** Phases after which the run is over (the job ends with them). */
export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(['done', 'failed', 'stopped'])

/** GRBL answers nothing until a reset after these (docs/modes/run-v0.1.md#stop-errors-and-alarms). */
const CRITICAL_ALARMS: ReadonlySet<number> = new Set([1, 2])

export const isConnected = (s: RunStatus): boolean => s.connection.state === 'open'

/** The run job in progress (not yet in a terminal phase), if any. */
export function activeJob(s: RunStatus): RunStatus['job'] {
  return s.job !== undefined && !TERMINAL_PHASES.has(s.job.phase) ? s.job : undefined
}

export const isCriticalAlarm = (s: RunStatus): boolean =>
  s.alarm !== undefined && CRITICAL_ALARMS.has(s.alarm.code)

/**
 * Badge state and label (ui.md#run-mode-safety-ui table: label and shape per state). `setupChange`:
 * the window waits for a setup change between two setups' runs (task E2); shown like a tool change
 * while the machine is idle.
 */
export function machineView(
  s: RunStatus,
  opts: { readonly setupChange?: boolean } = {},
): { state: MachineState; label: string } {
  if (s.connection.state === 'closed') return { state: 'offline', label: m.state.offline }
  if (s.connection.state === 'connecting') return { state: 'offline', label: m.state.connecting }
  const job = activeJob(s)
  const st = s.state
  if (st.startsWith('Alarm') || isCriticalAlarm(s))
    return { state: 'alarm', label: m.state.alarm(s.alarm?.code) }
  if (st.startsWith('Jog')) return { state: 'moving', label: m.state.jogging }
  if (job?.phase === 'toolChange') return { state: 'action', label: m.state.toolChange }
  if (job?.phase === 'programPause') return { state: 'hold', label: m.state.paused }
  if (job?.phase === 'stopping') return { state: 'moving', label: m.state.stopping }
  if (st.startsWith('Door')) return { state: 'hold', label: m.state.door }
  if (st.startsWith('Hold') || job?.phase === 'held') return { state: 'hold', label: m.state.hold }
  if (st.startsWith('Home')) return { state: 'moving', label: m.state.homing }
  if (st.startsWith('Run') || job?.phase === 'streaming')
    return { state: 'moving', label: m.state.running }
  if (st === 'Idle')
    return opts.setupChange === true && job === undefined
      ? { state: 'action', label: m.state.setupChange }
      : { state: 'idle', label: m.state.idle }
  return { state: 'idle', label: m.state.other(st) }
}

/** `null` = allowed; otherwise the reason shown next to the disabled control. */
export type Gate = string | null

export interface RunGates {
  readonly home: Gate
  readonly unlock: Gate
  readonly jog: Gate
  readonly workZero: Gate
  readonly start: Gate
  readonly disconnect: Gate
}

/**
 * What the controls may do now. Mirrors the host's rules (docs/modes/run-v0.1.md#commands-and-
 * queries): the host still refuses with `run.state`, these only explain it before the click.
 */
export function runGates(s: RunStatus, opts: { planChosen: boolean }): RunGates {
  if (!isConnected(s)) {
    const no = m.why.notConnected
    return { home: no, unlock: no, jog: no, workZero: no, start: no, disconnect: no }
  }
  const job = activeJob(s)
  const st = s.state
  const atToolChange = job?.phase === 'toolChange'
  const critical = isCriticalAlarm(s) ? m.why.criticalAlarm : null
  const alarm = st.startsWith('Alarm')
  const idle = st === 'Idle'
  const moving = !idle && !alarm
  return {
    home: critical ?? (job ? m.why.running : moving ? m.why.busy : null),
    unlock: critical ?? (job ? m.why.running : alarm ? null : moving ? m.why.busy : null),
    jog:
      critical ??
      (job && !atToolChange
        ? m.why.running
        : alarm
          ? m.why.homeFirst
          : idle || st.startsWith('Jog')
            ? null
            : m.why.busy),
    workZero:
      critical ??
      (job && !atToolChange ? m.why.running : alarm ? m.why.homeFirst : idle ? null : m.why.busy),
    start:
      critical ??
      (job
        ? m.why.running
        : alarm || !s.homed
          ? m.why.homeFirst
          : !idle
            ? m.why.busy
            : opts.planChosen
              ? null
              : m.why.noPlan),
    disconnect: job ? m.why.running : null,
  }
}

const MM_PER_INCH = 25.4

/** A length in mm shown in the project's unit system: mm with 3 decimals, inch with 4. */
export function formatLength(mm: number, units: UnitSystem): string {
  const v = units === 'inch' ? mm / MM_PER_INCH : mm
  const s = v.toFixed(units === 'inch' ? 4 : 3)
  // no negative zero ("-0.000")
  return /^-0\.0+$/.test(s) ? s.slice(1) : s
}

/** A feed in mm/min shown in the project's unit system. */
export function formatFeed(mmPerMin: number, units: UnitSystem): string {
  return units === 'inch' ? (mmPerMin / MM_PER_INCH).toFixed(1) : mmPerMin.toFixed(0)
}

/** Jog steps per unit system, in the project unit (inch values are converted to mm to send). */
export const JOG_STEPS: Readonly<Record<UnitSystem, readonly string[]>> = {
  mm: ['0.1', '1', '10', '100'],
  inch: ['0.001', '0.01', '0.1', '1'],
}

export function stepToMm(step: string, units: UnitSystem): number {
  return Number(step) * (units === 'inch' ? MM_PER_INCH : 1)
}
