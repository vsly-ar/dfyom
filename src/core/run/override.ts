/**
 * Feed and spindle override targets (hardening DF85): the controller's override range, the byte
 * steps from the current override to a target, the cap the machine profile puts on it for the
 * programmed F and S, and the programmed F and S along a program.
 * Doc: docs/modes/run-machine.md#overrides-m6
 */
import type { OverrideStep } from './host/protocol'

/** Controller kinds DFYOM talks to (the machine profile's `controller`). */
export type ControllerKind = 'grbl'

export type OverrideKind = 'feed' | 'spindle'

/** Inclusive percent range a controller accepts for one override. */
export interface OverrideRange {
  readonly min: number
  readonly max: number
}

/** What a controller's real-time overrides can do; data, so another controller can widen it. */
export interface OverrideLimits {
  readonly feed: OverrideRange
  readonly spindle: OverrideRange
  /** Percent per coarse and per fine step. */
  readonly coarse: number
  readonly fine: number
}

/**
 * Per controller kind. GRBL 1.1: feed and spindle 10–200 % (`MIN/MAX_FEED_RATE_OVERRIDE`,
 * `MIN/MAX_SPINDLE_SPEED_OVERRIDE`), 10 % coarse and 1 % fine steps.
 */
export const CONTROLLER_OVERRIDE_LIMITS: Readonly<Record<ControllerKind, OverrideLimits>> = {
  grbl: {
    feed: { min: 10, max: 200 },
    spindle: { min: 10, max: 200 },
    coarse: 10,
    fine: 1,
  },
}

export function overrideLimits(controller: ControllerKind = 'grbl'): OverrideLimits {
  return CONTROLLER_OVERRIDE_LIMITS[controller]
}

/** The override after one step, clamped like the controller clamps it. */
export function applyOverrideStep(
  value: number,
  step: OverrideStep,
  range: OverrideRange,
  limits: OverrideLimits = overrideLimits(),
): number {
  const d: Record<OverrideStep, number> = {
    reset: 0,
    '+10': limits.coarse,
    '-10': -limits.coarse,
    '+1': limits.fine,
    '-1': -limits.fine,
  }
  if (step === 'reset') return 100
  return Math.min(range.max, Math.max(range.min, value + d[step]))
}

/**
 * The shortest byte steps from `from` (undefined: not known, so the steps start with a reset) to
 * `to`, ordered so that no step is clamped by the controller (each step then moves by exactly its
 * size, whatever the controller does with steps that arrive together). Empty when already there.
 * `to` must lie in `range` and on the fine grid.
 */
export function overrideSteps(
  from: number | undefined,
  to: number,
  range: OverrideRange,
  limits: OverrideLimits = overrideLimits(),
): OverrideStep[] {
  if (from === to) return []
  const starts: { value: number; prefix: OverrideStep[] }[] = [{ value: 100, prefix: ['reset'] }]
  if (from !== undefined && from >= range.min && from <= range.max)
    starts.unshift({ value: from, prefix: [] })
  let best: OverrideStep[] | undefined
  for (const start of starts) {
    const d = to - start.value
    const maxCoarse = Math.ceil(Math.abs(d) / limits.coarse) + 1
    for (let k = -maxCoarse; k <= maxCoarse; k++) {
      const rest = d - k * limits.coarse
      if (rest % limits.fine !== 0) continue
      const f = rest / limits.fine
      const length = start.prefix.length + Math.abs(k) + Math.abs(f)
      if (best !== undefined && length >= best.length) continue
      const order = unclampedOrder(start.value, k, f, range, limits)
      if (order !== undefined) best = [...start.prefix, ...order]
    }
  }
  return best ?? []
}

/** `k` coarse and `f` fine steps (signed) in an order that never leaves `range`, coarse first. */
function unclampedOrder(
  value: number,
  k: number,
  f: number,
  range: OverrideRange,
  limits: OverrideLimits,
): OverrideStep[] | undefined {
  const left = { coarse: Math.abs(k), fine: Math.abs(f) }
  const coarse = { step: (k > 0 ? '+10' : '-10') as OverrideStep, by: Math.sign(k) * limits.coarse }
  const fine = { step: (f > 0 ? '+1' : '-1') as OverrideStep, by: Math.sign(f) * limits.fine }
  const out: OverrideStep[] = []
  let v = value
  const fits = (x: number) => x >= range.min && x <= range.max
  while (left.coarse + left.fine > 0) {
    if (left.coarse > 0 && fits(v + coarse.by)) {
      v += coarse.by
      left.coarse--
      out.push(coarse.step)
    } else if (left.fine > 0 && fits(v + fine.by)) {
      v += fine.by
      left.fine--
      out.push(fine.step)
    } else return undefined
  }
  return out
}

/** Where the reachable range of an override ends, and why. */
export interface OverrideCap {
  readonly min: number
  readonly max: number
  /** `machine`: the profile's max feed or spindle speed ends it below the controller's limit. */
  readonly by: 'controller' | 'machine'
}

/**
 * The reachable override range: the controller's, its top lowered so that `programmed` × % stays
 * at or below `machineMax` (mm/min or rpm). Without a programmed value (no run, spindle off) or a
 * machine maximum only the controller limits it. Never below the controller's minimum.
 */
export function overrideCap(
  range: OverrideRange,
  programmed: number | undefined,
  machineMax: number | undefined,
): OverrideCap {
  if (programmed === undefined || !(programmed > 0) || machineMax === undefined)
    return { min: range.min, max: range.max, by: 'controller' }
  const pct = Math.floor((machineMax / programmed) * 100 + 1e-9)
  if (pct >= range.max) return { min: range.min, max: range.max, by: 'controller' }
  return { min: range.min, max: Math.max(range.min, pct), by: 'machine' }
}

/** Programmed feed (mm/min) and spindle speed (rpm, 0 while the spindle is off). */
export interface ProgrammedRates {
  readonly feed: number
  readonly spindle: number
}

const INCH = 25.4

/**
 * The modal F and S after each line of a program (index 0 = line 1), from its `F`, `S`, `G20`/
 * `G21` and `M3`/`M4`/`M5` words; comments are skipped. Feeds in inch programs are converted.
 */
export function programmedRates(lines: readonly string[]): {
  readonly feed: Float64Array
  readonly spindle: Float64Array
} {
  const feed = new Float64Array(lines.length)
  const spindle = new Float64Array(lines.length)
  let f = 0
  let s = 0
  let on = false
  let inch = false
  lines.forEach((raw, i) => {
    const line = raw
      .replace(/\([^)]*\)/g, '')
      .replace(/;.*$/, '')
      .toUpperCase()
    for (const m of line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
      const word = m[1]
      const n = Number(m[2])
      if (word === 'G' && n === 20) inch = true
      else if (word === 'G' && n === 21) inch = false
      else if (word === 'M' && (n === 3 || n === 4)) on = true
      else if (word === 'M' && (n === 5 || n === 2 || n === 30)) on = false
      else if (word === 'F') f = inch ? n * INCH : n
      else if (word === 'S') s = n
    }
    feed[i] = f
    spindle[i] = on ? s : 0
  })
  return { feed, spindle }
}
