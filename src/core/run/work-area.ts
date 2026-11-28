/**
 * The work area (v0.5 RV7): the reachable extents the user marked after homing, per axis and side
 * in machine coordinates, less a margin, as DFYOM's inner bound inside the controller's travel
 * (`[−$13x, 0]`, which GRBL's soft limits keep as the outer bound, Q223). Go to, "→0", jogs,
 * probing and the run's soft-limit check use `limitViolation` / `limitBounds`; the marks are
 * compared with `$130–$132` (`travelSuggestions`: a `$13n=` line to copy, never written, Q219).
 * Pure. Doc: docs/modes/run.md#work-area-rv7
 */
import type { Option } from '../../shared/result'
import { DEFAULT_WORK_AREA_MARGIN, type WorkArea } from '../library/machine'
import type { Quantity } from '../quantity/quantity'
import { homesNegative, switchAt, type Envelope } from './grbl/envelope'

type V3 = readonly [number, number, number]

export const WORK_AREA_AXES = ['x', 'y', 'z'] as const
export type WorkAreaAxis = (typeof WORK_AREA_AXES)[number]

/** One axis's marks (MPos, mm): the last safe point toward − and toward +; either may be unset. */
export interface AxisMarks {
  readonly min?: number
  readonly max?: number
}

/** The marked extents (MPos, mm); an unmarked side is bounded by the travel only. */
export type WorkAreaMarks = Partial<Record<WorkAreaAxis, AxisMarks>>

export { DEFAULT_WORK_AREA_MARGIN }

/** A box in machine coordinates (mm). */
export interface Bounds {
  readonly min: V3
  readonly max: V3
}

/** The marks and margin a connection uses (the host's `workArea` action). */
export interface WorkAreaSetting {
  readonly marks: WorkAreaMarks
  /** mm, ≥ 0. */
  readonly margin: number
}

/** True when no side is marked. */
export function marksEmpty(marks: WorkAreaMarks | undefined): boolean {
  return WORK_AREA_AXES.every((a) => marks?.[a]?.min === undefined && marks?.[a]?.max === undefined)
}

/** The controller's travel as a box: `[−travel, 0]` per axis. */
export function travelBounds(travel: V3): Bounds {
  return { min: [-travel[0], -travel[1], -travel[2]], max: [0, 0, 0] }
}

/**
 * The inner bound: per axis the travel, each marked side moved in by the margin (a mark is the
 * last safe point, so the area minus the margin is where moves may end). Never wider than the
 * travel. A margin wider than half a marked span leaves min > max: every move on that axis is
 * outside (the Explore panel says so).
 */
export function workAreaBounds(travel: V3, setting: WorkAreaSetting): Bounds {
  const min = [-travel[0], -travel[1], -travel[2]]
  const max = [0, 0, 0]
  WORK_AREA_AXES.forEach((a, i) => {
    const m = setting.marks[a]
    if (m?.min !== undefined) min[i] = Math.max(min[i]!, m.min + setting.margin)
    if (m?.max !== undefined) max[i] = Math.min(max[i]!, m.max - setting.margin)
  })
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

/** What the run checks against: the travel and, when marked and homed, the work area's bound. */
export interface Limits {
  readonly travel: V3
  /** The inner bound (`workAreaBounds`, the margin included); absent: the travel only. */
  readonly workArea?: Bounds | undefined
}

/** The tightest box of `limits` (MPos, mm). */
export function limitBounds(limits: Limits): Bounds {
  return limits.workArea ?? travelBounds(limits.travel)
}

/** A target outside the limits: the axis, where it would end and the bound it leaves (mm). */
export interface LimitViolation {
  readonly axis: WorkAreaAxis
  /** MPos the move would end at, mm. */
  readonly target: number
  readonly min: number
  readonly max: number
  /** The work area's bound (not the controller's travel). */
  readonly workArea?: true
}

const SLACK = 1e-6

/** How far `v` lies below `min` and above `max` (0 inside). */
const excess = (v: number, min: number, max: number) =>
  [Math.max(0, min - v), Math.max(0, v - max)] as const

/**
 * The first axis of `target` outside the travel (GRBL's µm slack) or the work area. The work area
 * allows a move that starts outside it when it goes no further out on that axis, on the same side
 * (`from`): after homing the machine may sit between the travel's end and a marked side, and must be
 * able to move away from there (Z up included).
 */
export function limitViolation(
  limits: Limits,
  target: V3,
  from?: V3 | undefined,
): LimitViolation | undefined {
  for (let i = 0; i < 3; i++) {
    const v = target[i]!
    const min = -limits.travel[i]!
    if (v > SLACK || v < min - SLACK) return { axis: WORK_AREA_AXES[i]!, target: v, min, max: 0 }
  }
  const area = limits.workArea
  if (area === undefined) return undefined
  for (let i = 0; i < 3; i++) {
    const v = target[i]!
    const [below, above] = excess(v, area.min[i]!, area.max[i]!)
    if (below <= SLACK && above <= SLACK) continue
    // further out on the same side, or out on the other side, is refused
    if (from !== undefined) {
      const [fromBelow, fromAbove] = excess(from[i]!, area.min[i]!, area.max[i]!)
      if (below <= fromBelow + SLACK && above <= fromAbove + SLACK) continue
    }
    return {
      axis: WORK_AREA_AXES[i]!,
      target: v,
      min: area.min[i]!,
      max: area.max[i]!,
      workArea: true,
    }
  }
  return undefined
}

/** The size of the bound per axis (mm, 0 when min > max). */
export function boundsSize(b: Bounds): V3 {
  const s = (i: number) => Math.max(0, b.max[i]! - b.min[i]!)
  return [s(0), s(1), s(2)]
}

/**
 * The usable size per axis of a plan's machine copy (mm): the travel, less each marked side and
 * its margin, as Plan's fit check reads it (sizes only: where the work zero sits is unknown).
 * Marks are MPos `[−travel, 0]`, so the size does not depend on the homing corner.
 */
export function workAreaSize(travel: V3, setting: WorkAreaSetting): V3 {
  return boundsSize(workAreaBounds(travel, setting))
}

/** A `$13n` line to copy for one axis (Q219: DFYOM never writes it). */
export interface TravelSuggestion {
  readonly axis: WorkAreaAxis
  /** `$130`, `$131`, `$132`. */
  readonly setting: string
  /** From the homing switch to the far mark (mm). */
  readonly reach: number
  /** The controller's travel on this axis (mm). */
  readonly travel: number
  /** `raise`: the machine reaches beyond the travel (soft limits off); `lower`: the area ends first. */
  readonly kind: 'raise' | 'lower'
  /** The line to paste into the user's own sender, e.g. `$130=380.000`. */
  readonly line: string
}

/** Differences under this (mm) are not worth a settings change. */
export const TRAVEL_SUGGESTION_MIN = 0.5

/**
 * Per axis with its far side marked (the side away from the homing switch: X− for a machine
 * homing to X+): the distance from the switch to that mark against `$13n`. GRBL's soft limits
 * span from the switch, so `$13n=<reach>` makes the controller stop at the mark too.
 */
export function travelSuggestions(
  envelope: Pick<Envelope, 'travel' | 'homingMask'>,
  marks: WorkAreaMarks,
): TravelSuggestion[] {
  const out: TravelSuggestion[] = []
  WORK_AREA_AXES.forEach((a, i) => {
    const neg = homesNegative(envelope.homingMask, i)
    const far = neg ? marks[a]?.max : marks[a]?.min
    if (far === undefined) return
    const reach = Math.abs(far - switchAt(envelope, i))
    const travel = envelope.travel[i]!
    if (Math.abs(reach - travel) < TRAVEL_SUGGESTION_MIN) return
    out.push({
      axis: a,
      setting: `$13${i}`,
      reach,
      travel,
      kind: reach > travel ? 'raise' : 'lower',
      line: `$13${i}=${reach.toFixed(3)}`,
    })
  })
  return out
}

/** The marks with one side set (MPos, mm) or cleared (`undefined`). */
export function withMark(
  marks: WorkAreaMarks,
  axis: WorkAreaAxis,
  side: 'min' | 'max',
  value: number | undefined,
): WorkAreaMarks {
  const { [side]: _old, ...rest } = marks[axis] ?? {}
  const next: AxisMarks = value === undefined ? rest : { ...rest, [side]: value }
  const { [axis]: _axis, ...others } = marks
  return next.min === undefined && next.max === undefined ? others : { ...others, [axis]: next }
}

/** Why a mark may not be taken: it would leave a marked span of 0 or less. */
export function markProblem(
  marks: WorkAreaMarks,
  axis: WorkAreaAxis,
  side: 'min' | 'max',
  value: number,
): 'crossed' | undefined {
  const other = side === 'min' ? marks[axis]?.max : marks[axis]?.min
  if (other === undefined) return undefined
  return (side === 'min' ? value < other : value > other) ? undefined : 'crossed'
}

/**
 * The work area of a machine model (lengths → mm); undefined when nothing is marked. The margin
 * unset is `DEFAULT_WORK_AREA_MARGIN`.
 */
export function machineWorkArea(m: {
  readonly workArea: Option<WorkArea>
  readonly workAreaMargin: Option<Quantity>
}): WorkAreaSetting | undefined {
  if (m.workArea.isNone()) return undefined
  const area = m.workArea.unwrap()
  const marks: Record<string, AxisMarks> = {}
  for (const a of WORK_AREA_AXES) {
    const side = area[a]
    if (side === undefined) continue
    const min = side.min.isSome() ? side.min.unwrap().canonical : undefined
    const max = side.max.isSome() ? side.max.unwrap().canonical : undefined
    if (min === undefined && max === undefined) continue
    marks[a] = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
  }
  if (marksEmpty(marks)) return undefined
  return { marks, margin: m.workAreaMargin.mapOr(DEFAULT_WORK_AREA_MARGIN, (q) => q.canonical) }
}
