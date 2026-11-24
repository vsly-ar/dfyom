// Pure run-mode view logic over `RunStatus`: the machine state badge, what each control may do
// right now (and why not), DRO formatting. Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-v0.1.md#status
import type { UnitSystem } from '../../../../core/project/document'
import type { RunStatus } from '../../../../core/run/service'
import type { AppErrorData } from '../../../../shared/errors/app-error'
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
 * GRBL's start-up lock (DF46, docs/modes/run.md#run-mode-presentation-df46): `Alarm` with no
 * alarm code on a machine not homed yet. Shown as "Needs homing", not as an error; the gates are
 * those of Alarm all the same.
 */
export const needsHoming = (s: RunStatus): boolean =>
  isConnected(s) && s.state.startsWith('Alarm') && s.alarm === undefined && !s.homed

/** The position is known only once homed (DF46): the DRO shows "—" until then. */
export const positionKnown = (s: RunStatus): boolean => isConnected(s) && s.homed

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
  if (needsHoming(s)) return { state: 'needsHoming', label: m.state.needsHoming }
  if (st.startsWith('Alarm') || isCriticalAlarm(s))
    return { state: 'alarm', label: m.state.alarm(s.alarm?.code) }
  if (st.startsWith('Jog')) return { state: 'moving', label: m.state.jogging }
  if (job?.phase === 'toolChange') return { state: 'action', label: m.state.toolChange }
  if (job?.phase === 'programPause') return { state: 'hold', label: m.state.paused }
  if (job?.phase === 'stopping') return { state: 'moving', label: m.state.stopping }
  if (st === 'Door:0') return { state: 'hold', label: m.state.doorClosed }
  if (st === 'Door:3') return { state: 'hold', label: m.state.doorResuming }
  if (st.startsWith('Door')) return { state: 'hold', label: m.state.door }
  if (isHolding(s)) return { state: 'hold', label: m.state.holding }
  // DF82: a hold DFYOM did not send (docs/modes/run.md#external-holds-df82)
  if (st.startsWith('Hold') && s.holdBy === 'machine')
    return { state: 'hold', label: m.state.heldByMachine }
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

/**
 * A feed hold still decelerating: `Hold:1`, or the run's hold sent and no report since (`Run`).
 * `job.pause` answers once it is `Hold:0` (DF82, docs/modes/run.md#1-emergency-stop-stop-and-reset);
 * a cycle start before then would be lost, so Resume waits.
 */
export function isHolding(s: RunStatus): boolean {
  return s.state === 'Hold:1' || (activeJob(s)?.phase === 'held' && s.state.startsWith('Run'))
}

/**
 * Held and standing still, so a cycle start would resume: `Hold:0`, or a safety door closed again
 * (`Door:0`). Not while the hold decelerates (`isHolding`) or the door is open (`Door:1`/`Door:2`,
 * GRBL ignores `~` then) or already resuming (`Door:3`). DF82, docs/modes/run.md#external-holds-df82
 */
export function canResume(s: RunStatus): boolean {
  return !isHolding(s) && !/^Door:[123]/.test(s.state)
}

/** A held machine (feed hold or safety door), whoever held it. */
export const isHeld = (s: RunStatus): boolean => /^(Hold|Door)/.test(s.state)

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

/**
 * Stop's gate (DF35, docs/modes/run.md#stop-only-when-something-can-be-stopped-df35): allowed with
 * a run job or while the machine moves or is held; otherwise why there is nothing to stop.
 */
export function stopGate(s: RunStatus): Gate {
  if (!isConnected(s)) return m.why.notConnected
  if (activeJob(s) !== undefined) return null
  return /^(Jog|Home|Run|Hold|Door)/.test(s.state) ? null : m.why.nothingToStop
}

/** The navigator's text for a refused action; `undefined` = the code's own message. */
export function actionText(e: AppErrorData, units: UnitSystem): string | undefined {
  if (e.code !== 'run.travel') return undefined
  const d = e.frames[0]?.data as
    { axis?: string; target?: number; min?: number; max?: number; atEdge?: boolean } | undefined
  if (d?.axis === undefined || d.target === undefined || d.min === undefined || d.max === undefined)
    return m.travelUnknown
  if (d.atEdge === true) {
    // a continuous jog from the end of the travel (docs/modes/run-machine.md#machine-readiness-m3)
    const atMax = Math.abs(d.target - d.max) <= Math.abs(d.target - d.min)
    return m.travelAtEdge(
      d.axis.toUpperCase(),
      atMax ? 'max' : 'min',
      formatLength(atMax ? d.max : d.min, units),
      m.dro.units[units],
    )
  }
  const high = d.target > d.max
  return m.travel(
    d.axis.toUpperCase(),
    high ? 'max' : 'min',
    formatLength(high ? d.max : d.min, units),
    formatLength(d.target, units),
    m.dro.units[units],
  )
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

/** How the jog pad jogs: one step per click, or while a button is held (M3). */
export type JogMode = 'step' | 'continuous'

/** Jog steps per unit system, in the project unit (inch values are converted to mm to send). */
export const JOG_STEPS: Readonly<Record<UnitSystem, readonly string[]>> = {
  mm: ['0.1', '1', '10', '100'],
  inch: ['0.001', '0.01', '0.1', '1'],
}

export function stepToMm(step: string, units: UnitSystem): number {
  return Number(step) * (units === 'inch' ? MM_PER_INCH : 1)
}

type Xyz = readonly [number, number, number]

/** Within this (mm) of the spot in X and Y the machine is there: no move offered. */
const AT_SPOT_MM = 0.01

/**
 * The jogs (machine coordinates, mm) of "Move to touch-off spot" at a tool-change wait (DF69,
 * docs/modes/z-reference.md#dfyom-run): up to the setup's clearance height if lower (never down),
 * then X Y to the spot at that height. The clearance is reckoned from the stock top of the current
 * work zero (`zeroLevel`) and capped at the machine top. Empty: already at the spot. Pure.
 */
export function touchOffMoves(
  s: Pick<RunStatus, 'mpos' | 'workZero' | 'zeroLevel'>,
  at: readonly [number, number],
  clearance: number,
): Xyz[] {
  const [x, y, z] = s.mpos
  const tx = s.workZero[0] + at[0]
  const ty = s.workZero[1] + at[1]
  if (Math.abs(x - tx) <= AT_SPOT_MM && Math.abs(y - ty) <= AT_SPOT_MM) return []
  const safe = Math.min(s.workZero[2] - (s.zeroLevel ?? 0) + clearance, 0)
  const up = Math.max(z, safe)
  return [...(up > z + 1e-6 ? [[x, y, up] as Xyz] : []), [tx, ty, up]]
}

/** A tool change's surface without its level ("Facing 1 floor, 0.50 below …" → "Facing 1 floor"). */
export const surfaceName = (surface: string): string =>
  surface.replace(/, [\d.]+ below the stock top$/, '')
