/**
 * Go to coordinates (hardening DF128): the steps of a move to a typed point in the work or machine
 * frame, in the safe order – Z up first when the target is higher, a lift to the safe height (or
 * the machine top) before an X/Y move made below it, X and Y together, Z down last – each step an
 * absolute machine target for one `run.machine.jog { to }`. Every step's end is checked against
 * the controller's travel. Pure; the run dialog uses it, a later agent tool could too.
 * Doc: docs/modes/run-goto.md#the-move-safe-order
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import type { Envelope } from './grbl/envelope'
import { limitViolation, type Bounds } from './work-area'

/**
 * The controller's travel and, while homed with a marked work area, its inner bound (v0.5 RV7,
 * the status's `envelope`; docs/modes/run.md#work-area-rv7).
 */
export type MoveLimits = Pick<Envelope, 'travel' | 'pullOff'> & {
  readonly workArea?: Bounds | undefined
}

export type Vec3 = readonly [number, number, number]

/** The frame the fields are typed in: work (G54, through the live work offset) or machine (G53). */
export type GoToFrame = 'work' | 'machine'
/** Absolute: the fields are the target; relative: the distance to move. */
export type GoToMode = 'absolute' | 'relative'

/** One straight jog: an absolute machine target, Z alone or X and Y together. */
export interface GoToStep {
  readonly to: Vec3
  readonly axis: 'z' | 'xy'
}

/** Within this (mm) the target equals the position ("Already there"), per axis. */
export const GOTO_EPS_MM = 0.001

/** The safe height above the stock top without a plan's setup clearance (mm). */
export const DEFAULT_GOTO_CLEARANCE_MM = 5

export interface GoToInput {
  /** The machine position (MPos), mm. */
  readonly from: Vec3
  /** The work offset of the last status report (MPos − WPos, `WCO`: G54 plus any G92), mm. */
  readonly wco: Vec3
  /** What the user typed, mm: a point in `frame` (absolute) or the distance to move (relative). */
  readonly target: Vec3
  readonly frame: GoToFrame
  readonly mode: GoToMode
  /** The safe height (machine Z, mm, `goToSafeZ`): X/Y never move below it unless already above. */
  readonly safeZ: number
  /** "Lift to the top first": raise Z to the machine top before any X/Y move. */
  readonly liftToTop: boolean
  /** The controller's travel (and the work area); unknown = no check (the host's and GRBL's stay). */
  readonly envelope?: MoveLimits | undefined
}

/**
 * The highest point Z reaches without touching its switch (machine Z, mm): −pull-off, as after
 * `$H` (Z homes up), or the work area's top when lower (RV7); 0 without a known envelope.
 */
export function machineTopZ(envelope: MoveLimits | undefined): number {
  if (envelope === undefined) return 0
  const top = Math.max(-envelope.pullOff, -envelope.travel[2])
  const area = envelope.workArea?.max[2]
  return area === undefined ? top : Math.min(top, area)
}

/**
 * The safe height (machine Z, mm): the stock top of the current work zero (`zeroLevel`, < 0 when
 * Z was zeroed on a lower surface, DF69) plus the setup's clearance, else 5 mm; capped at the
 * machine top.
 */
export function goToSafeZ(p: {
  readonly wcoZ: number
  readonly zeroLevel?: number | undefined
  readonly clearance?: number | undefined
  readonly envelope?: MoveLimits | undefined
}): number {
  const z = p.wcoZ - (p.zeroLevel ?? 0) + (p.clearance ?? DEFAULT_GOTO_CLEARANCE_MM)
  return Math.min(z, machineTopZ(p.envelope))
}

/** The target as a machine point (mm). */
export function goToTarget(p: Pick<GoToInput, 'from' | 'wco' | 'target' | 'frame' | 'mode'>): Vec3 {
  const t = p.target
  if (p.mode === 'relative') return [p.from[0] + t[0], p.from[1] + t[1], p.from[2] + t[2]]
  if (p.frame === 'work') return [t[0] + p.wco[0], t[1] + p.wco[1], t[2] + p.wco[2]]
  return [t[0], t[1], t[2]]
}

/**
 * The steps of a go-to, in order; empty when the target is the position ("Already there").
 * `Err(run.travel)` when a step would end outside the travel, with the axis, the step's end and
 * the travel (`data: { axis, target, min, max, step }`, mm, machine).
 */
export function goToMoves(p: GoToInput): AppResult<GoToStep[]> {
  const [fx, fy, fz] = p.from
  const [tx, ty, tz] = goToTarget(p)
  const moves = (a: number, b: number) => Math.abs(a - b) > GOTO_EPS_MM
  const xy = moves(tx, fx) || moves(ty, fy)
  if (!xy && !moves(tz, fz)) return Ok([])

  const steps: GoToStep[] = []
  // up first: to the target Z when higher, and before X/Y to the safe height (or the top)
  const lift = xy ? (p.liftToTop ? machineTopZ(p.envelope) : p.safeZ) : -Infinity
  const up = Math.max(fz, tz, lift)
  let z = fz
  if (up > fz + GOTO_EPS_MM) {
    z = up
    steps.push({ to: [fx, fy, z], axis: 'z' })
  }
  if (xy) steps.push({ to: [tx, ty, z], axis: 'xy' })
  if (moves(tz, z)) steps.push({ to: [tx, ty, tz], axis: 'z' })

  const outside = stepsViolation(p.from, steps, p.envelope, 'goToMoves', 'the go-to')
  return outside === undefined ? Ok(steps) : outside
}

/**
 * `run.travel` for the first step that ends outside the travel or the work area (RV7: a step may
 * start outside the area and not go further out), with the axis, the end, the bound and the step
 * (`data: { axis, target, min, max, step, workArea? }`, mm, machine); undefined when all fit.
 */
export function stepsViolation(
  from: Vec3,
  steps: readonly { readonly to: Vec3 }[],
  limits: MoveLimits | undefined,
  where: string,
  what: string,
): AppResult<never> | undefined {
  if (limits === undefined) return undefined
  let at = from
  for (const [i, s] of steps.entries()) {
    const v = limitViolation(limits, s.to, at)
    at = s.to
    if (v === undefined) continue
    const bound = v.workArea === true ? 'work area' : 'travel'
    return fail(
      'run.travel',
      `${v.axis.toUpperCase()} would leave the ${bound}: ${what} would reach ${v.target.toFixed(3)} mm, the ${bound} is ${v.min.toFixed(3)} to ${v.max.toFixed(3)} mm`,
      { where, data: { ...v, step: i } },
    )
  }
  return undefined
}

/** Length of each step (mm). */
export function goToLengths(from: Vec3, steps: readonly GoToStep[]): number[] {
  let at = from
  return steps.map((s) => {
    const d = Math.hypot(s.to[0] - at[0], s.to[1] - at[1], s.to[2] - at[2])
    at = s.to
    return d
  })
}

/** Seconds of the steps at their feeds (mm/min), without acceleration, rounded up. */
export function goToSeconds(
  from: Vec3,
  steps: readonly GoToStep[],
  feed: { readonly xy: number; readonly z: number },
): number {
  const lengths = goToLengths(from, steps)
  const min = steps.reduce((t, s, i) => t + lengths[i]! / (s.axis === 'z' ? feed.z : feed.xy), 0)
  return Math.ceil(min * 60 - 1e-9)
}

/**
 * Hardening DF140: the work-frame target of the DRO's "→0" (go to the work zero of one axis):
 * that axis at 0, the others where they are. X or Y never lowers Z: Z goes to the higher of the
 * current Z and the safe height, so with `goToMoves` the tool rises to the safe height (when
 * below it) before X/Y and stays there, never back down beside the zero. Z moves Z alone.
 * Doc: docs/modes/run-goto.md#go-to-work-zero-per-axis-df140
 */
export function goToZeroTarget(p: {
  /** The work position (WPos), mm. */
  readonly wpos: Vec3
  /** The work offset (MPos − WPos), mm. */
  readonly wco: Vec3
  readonly axis: 'x' | 'y' | 'z'
  /** The safe height (machine Z, mm, `goToSafeZ`). */
  readonly safeZ: number
}): Vec3 {
  const [x, y, z] = p.wpos
  if (p.axis === 'z') return [x, y, 0]
  const zUp = Math.max(z, p.safeZ - p.wco[2])
  return p.axis === 'x' ? [0, y, zUp] : [x, 0, zUp]
}
