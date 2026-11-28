// Pure run-mode view logic over `RunStatus`: the machine state badge, what each control may do
// right now (and why not), DRO formatting. Doc: docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-v0.1.md#status
import type { UnitSystem } from '../../../../core/project/document'
import { limitSwitches } from '../../../../core/run/grbl/status'
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

/** ALARM:1/2 not yet followed by a reset: GRBL answers nothing but the reset. */
export const isCriticalAlarm = (s: RunStatus): boolean =>
  s.alarm !== undefined && CRITICAL_ALARMS.has(s.alarm.code) && s.alarm.reset !== true

/**
 * DF134: a critical alarm the controller was reset from: GRBL waits locked for `$H` (recommended:
 * a hard limit stops the motors at once) or `$X` (docs/modes/run-machine.md#after-a-hard-limit-df134).
 */
export const isResetAlarm = (s: RunStatus): boolean =>
  isConnected(s) &&
  s.alarm !== undefined &&
  CRITICAL_ALARMS.has(s.alarm.code) &&
  s.alarm.reset === true &&
  s.state.startsWith('Alarm')

/** DF134: the safety door's input is active (`Pn:D`): GRBL refuses `$H` and `$X`. */
export const doorPinOpen = (s: RunStatus): boolean => s.pins?.includes('D') === true

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
  // DF134: a pressed limit switch or an open door, said before the click (the host refuses too)
  const door = doorPinOpen(s) ? m.why.doorOpen : null
  const limits = limitSwitches(s.pins)
  const pressed = limits.length > 0 ? m.why.limitPressed(limits) : null
  return {
    // v0.5 RV1: GRBL would home with the spindle turning (the host refuses it too)
    home:
      critical ??
      (job
        ? m.why.running
        : moving
          ? m.why.busy
          : s.spindle > 0
            ? m.goTo.spindleOn
            : (door ?? pressed)),
    unlock: critical ?? (job ? m.why.running : alarm ? door : moving ? m.why.busy : null),
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
 * DF128: whether a DRO value may open the Go to dialog (docs/modes/run-goto.md#checks): the
 * position known, no run job (a tool-change or pause wait has its own jog pad).
 */
export function goToOpenGate(s: RunStatus): Gate {
  if (!isConnected(s)) return m.why.notConnected
  if (!s.homed) return m.goTo.unknown
  return activeJob(s) !== undefined ? m.why.running : null
}

/**
 * DF128: why Go cannot start now, or null: the open gate, then the jog gate's reasons (alarm,
 * hold, door, homing …), a jog still running, a spindle reported running.
 */
export function goToGate(s: RunStatus): Gate {
  return (
    goToOpenGate(s) ??
    runGates(s, { planChosen: false }).jog ??
    (s.state.startsWith('Jog') ? m.goTo.jogging : s.spindle > 0 ? m.goTo.spindleOn : null)
  )
}

/**
 * v0.5 RV1: why "Start spindle" cannot act now, or null (docs/modes/run-machine.md#spindle-while-jogging-rv1):
 * connected, no run job (not even at a wait), Idle; in a jog the reason says to stop it first.
 */
export function spindleStartGate(s: RunStatus): Gate {
  if (!isConnected(s)) return m.why.notConnected
  if (activeJob(s) !== undefined) return m.spindle.runOwns
  if (s.state.startsWith('Jog')) return m.spindle.notIdle
  return runGates(s, { planChosen: false }).workZero
}

/** v0.5 RV1: "Stop spindle": whenever connected, except while a run streams or holds. */
export function spindleStopGate(s: RunStatus): Gate {
  if (!isConnected(s)) return m.why.notConnected
  const job = activeJob(s)
  return job !== undefined && job.phase !== 'toolChange' ? m.spindle.runOwns : null
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
  // v0.5 RV1: the spindle's refusals in words (docs/modes/run-machine.md#spindle-while-jogging-rv1)
  const rule = e.issues[0]?.rule
  if ((e.code === 'run.state' || e.code === 'machine.reset') && rule !== undefined)
    return m.spindle.refused[rule]
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

// ── Jog step and feed (DF88, docs/conventions/ui.md#jog-position-and-probing-df88) ──────────

/** Jog step presets per unit system, in the project unit (the usual inch ladder for inch). */
export const JOG_PRESETS: Readonly<Record<UnitSystem, readonly number[]>> = {
  mm: [0.1, 1, 5, 10, 20, 50, 100],
  inch: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1],
}
/** The step before one is chosen, in the project unit. */
export const DEFAULT_JOG_STEP: Readonly<Record<UnitSystem, number>> = { mm: 10, inch: 0.1 }
/** The largest custom step (mm). */
export const MAX_JOG_STEP_MM = 1000

/** A length in the project unit → mm. */
export const toMm = (v: number, units: UnitSystem): number =>
  units === 'inch' ? v * MM_PER_INCH : v
/** mm → the project unit. */
export const fromMm = (mm: number, units: UnitSystem): number =>
  units === 'inch' ? mm / MM_PER_INCH : mm

/** The step (mm) to jog: the chosen one, else the unit's default. */
export const jogStepMm = (step: number | undefined, units: UnitSystem): number =>
  step ?? toMm(DEFAULT_JOG_STEP[units], units)

/** The preset `stepMm` is in this unit system, if any (else it is a custom step). */
export function jogPresetOf(stepMm: number, units: UnitSystem): number | undefined {
  const v = fromMm(stepMm, units)
  return JOG_PRESETS[units].find((p) => Math.abs(p - v) <= p * 1e-9)
}

/** A step value in the project unit as the step picker shows it ("0.1", "0.001", "2.5"). */
export const formatStep = (v: number): string => String(+v.toPrecision(6))

/** Jog feed default and limit when the machine's is unknown (mm/min). */
export const JOG_FEED_DEFAULT = 2000
/** v0.5 RV1 (Q217): the jog feed while the spindle turns, before one is chosen (mm/min). */
export const CUTTING_JOG_FEED_DEFAULT = 600
export const JOG_FEED_FALLBACK_MAX = 5000

export interface JogFeedRange {
  /** mm/min. */
  readonly min: number
  readonly max: number
  readonly step: number
}

/**
 * The jog feed slider's range (mm/min): 100 mm/min steps (5 in/min in inch projects) from one
 * step up to the machine's limit (the lower X/Y max feed rate), else 5000 mm/min.
 */
export function jogFeedRange(units: UnitSystem, machineMax: number | undefined): JogFeedRange {
  const step = units === 'inch' ? 5 * MM_PER_INCH : 100
  const limit = machineMax ?? JOG_FEED_FALLBACK_MAX
  return { min: step, max: Math.max(step, Math.floor(limit / step + 1e-9) * step), step }
}

/** A feed snapped to the range's steps and inside it. */
export function clampJogFeed(feed: number, r: JogFeedRange): number {
  const snapped = Math.round(feed / r.step) * r.step
  return Math.min(r.max, Math.max(r.min, snapped))
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
