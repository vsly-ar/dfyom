/**
 * Homing repeatability (v0.5 RV8, Q224): after each homing the same fixed target is probed from
 * the same start; the spread of the contacts per axis says how well homing returns to the same
 * place. `repeatabilityStats` is the result's math; `runTargetProbe` is one probe of the target
 * from the machine top after a homing (an XY move at the top Z, a `G38.3` descent to the start,
 * then the Z cycle or the corner routine through the shared runner, back up to the start). The
 * homing loop itself is the `run.machine.repeatability` job (one `$H` and one probe per cycle).
 * Pure but for the port. Doc: docs/modes/run-machine.md#homing-repeatability-rv8
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import {
  floorHit,
  floorRefused,
  fmt,
  probeResult,
  runProbeCycle,
  type ProbeFloor,
  type ProbePort,
} from './probe-cycle'
import { runProbeRoutine, type ProbeGeometry } from './probe-routines'

type Vec3 = readonly [number, number, number]

/** Q224: a spread under this (mm) passes. */
export const REPEATABILITY_PASS = 0.02
/** Q224: homings per test by default. */
export const REPEATABILITY_CYCLES = 5

const AXES = ['x', 'y', 'z'] as const
export type RepeatAxis = (typeof AXES)[number]

/** One probe of the target: the contact per probed axis (MPos mm). */
export type TargetReading = Partial<Record<RepeatAxis, number>>

/** Per axis: the readings' spread (max − min), standard deviation and mean (mm). */
export interface AxisRepeatability {
  readonly spread: number
  readonly stdDev: number
  readonly mean: number
}

export interface RepeatabilityStats {
  readonly axes: Partial<Record<RepeatAxis, AxisRepeatability>>
  /** Every probed axis's spread under `REPEATABILITY_PASS`; false with fewer than 2 readings. */
  readonly pass: boolean
  /** The worst spread (mm). */
  readonly worst: number
}

/**
 * The spread (max − min), the sample standard deviation and the mean per axis that every reading
 * has; pass when each spread is under the threshold (2 readings at least).
 */
export function repeatabilityStats(
  readings: readonly TargetReading[],
  threshold = REPEATABILITY_PASS,
): RepeatabilityStats {
  const axes: Partial<Record<RepeatAxis, AxisRepeatability>> = {}
  for (const a of AXES) {
    const v = readings.map((r) => r[a])
    if (v.length === 0 || v.some((x) => x === undefined)) continue
    const xs = v as number[]
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    const variance =
      xs.length < 2 ? 0 : xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)
    axes[a] = { spread: Math.max(...xs) - Math.min(...xs), stdDev: Math.sqrt(variance), mean }
  }
  const spreads = Object.values(axes).map((x) => x.spread)
  const worst = spreads.length === 0 ? 0 : Math.max(...spreads)
  return {
    axes,
    pass: readings.length >= 2 && spreads.length > 0 && worst < threshold,
    worst,
  }
}

/**
 * The drift of one reading from a test's means (mm per axis): lost steps since the reference
 * (the before/after-run check, without homing).
 */
export function drift(
  reading: TargetReading,
  means: Partial<Record<RepeatAxis, number>>,
): TargetReading {
  const out: Partial<Record<RepeatAxis, number>> = {}
  for (const a of AXES) {
    const r = reading[a]
    const m = means[a]
    if (r !== undefined && m !== undefined) out[a] = r - m
  }
  return out
}

export interface TargetProbeSpec {
  /** The start above the target the user chose (MPos): the probe begins and ends here. */
  readonly at: Vec3
  /** What probes: a Z plate probes Z only; the other kinds the corner (Z, X, Y). */
  readonly probe: ProbeGeometry
  /** `corner`: which of the target's corners (X, Y sides), as the corner routine. */
  readonly corner: readonly [-1 | 1, -1 | 1]
  /** mm: down from the start to the target at most. */
  readonly zDistance: number
  /** mm: the corner's edges from the start at most. */
  readonly reach: number
  /** mm below the target's top for X/Y contacts. */
  readonly depth: number
  /** mm: the lift above the top. */
  readonly clearance: number
  readonly fastFeed: number
  readonly slowFeed: number
  /** mm/min: the `G38.3` descent to the start (and the routine's positioning). */
  readonly moveFeed: number
  /** mm/min: the XY move to the start at the machine top. */
  readonly travelFeed: number
  readonly travel?: { readonly min: Vec3; readonly max: Vec3 }
  /** v0.5 RV11: the bed (docs/modes/run-surface.md#uses): the descent and every cycle. */
  readonly floor?: ProbeFloor
  readonly inches?: boolean
  readonly cancelled?: () => boolean
}

const where = 'homingRepeatability'

function refused(message: string, rule: string, data: Record<string, unknown> = {}) {
  return fail('run.state', message, { where, data, issues: [{ path: [], rule, message }] })
}

/**
 * One probe of the target (docs/modes/run-machine.md#homing-repeatability-rv8): from at or above
 * the start's Z (the machine top after homing) along X/Y to above the start (`G53 G1`, nothing
 * below), down to the start with `G38.3` (a contact on the way stops it: refused), then the Z
 * cycle (a Z plate: `G38.2` down at most `zDistance`, slow re-probes) or the corner routine, and
 * back up to the start. Returns the contact per probed axis (MPos; the routine's edge values with
 * the probe's radius and walls applied, as RV4).
 */
export async function runTargetProbe(
  port: ProbePort,
  spec: TargetProbeSpec,
): Promise<AppResult<TargetReading>> {
  const cancelled = () => spec.cancelled?.() === true
  const send = async (line: string, timeoutMs?: number) => {
    if (cancelled()) return fail('op.aborted', 'the repeatability test was stopped', { where })
    return port.command(line, timeoutMs === undefined ? {} : { timeoutMs })
  }
  const st = await port.status()
  if (st.isErr()) return Err(st.unwrapErr())
  const s0 = st.unwrap()
  const from = s0.mpos
  const at = spec.at
  if (from[2] < at[2] - 1e-3)
    return refused(
      `The tool is below the target's start (Z ${fmt(from[2])}, start ${fmt(at[2])} machine): home first.`,
      'belowStart',
      { from, at },
    )
  // RV11: the descent to the start stays 1 mm above the bed (refused before anything moves)
  const low = floorHit(spec.floor, [at[0], at[1], from[2]], at)
  if (low !== undefined) return floorRefused(low, where)
  // 1. across at this Z (the machine top after homing): the move a Go to makes at its lift
  const xy = Math.hypot(at[0] - from[0], at[1] - from[1])
  if (xy > 1e-6) {
    const r = await send(
      `G21 G53 G1 X${fmt(at[0])} Y${fmt(at[1])} F${fmt(spec.travelFeed)}`,
      (xy / spec.travelFeed) * 60_000 + 10_000,
    )
    if (r.isErr()) return Err(r.unwrapErr())
  }
  // 2. down to the start: `G38.3`, so an unexpected contact stops it (in work coordinates)
  const down = from[2] - at[2]
  if (down > 1e-6) {
    const wcoZ = s0.mpos[2] - s0.wpos[2]
    const r = await send(
      `G21 G90 G38.3 Z${fmt(at[2] - wcoZ)} F${fmt(spec.moveFeed)}`,
      (down / spec.moveFeed) * 60_000 + 10_000,
    )
    if (r.isErr()) return Err(r.unwrapErr())
    const prb = probeResult(r.unwrap())
    if (prb?.ok === true) {
      const back = await send(`G21 G53 G0 Z${fmt(from[2])}`)
      if (back.isErr()) return Err(back.unwrapErr())
      return refused(
        `The probe touched something on the way down to the target's start (Z ${fmt(prb.pos[2])} machine): it went back up. Check the target and the start, then test again.`,
        'unexpectedContact',
        { at },
      )
    }
  }
  // 3. the probe
  const out: Partial<Record<RepeatAxis, number>> = {}
  if (spec.probe.kind === 'zPlate') {
    const c = await runProbeCycle(port, {
      axis: 'z',
      direction: -1,
      maxDistance: spec.zDistance,
      fastFeed: spec.fastFeed,
      slow: { feed: spec.slowFeed, backOff: 1, repeats: 2 },
      retract: 0,
      ...(spec.travel === undefined ? {} : { travel: spec.travel }),
      ...(spec.floor === undefined ? {} : { floor: spec.floor }),
      ...(spec.inches === undefined ? {} : { inches: spec.inches }),
      cancelled,
    })
    if (c.isErr()) return Err(c.unwrapErr())
    out.z = c.unwrap().value
  } else {
    const r = await runProbeRoutine(port, {
      routine: { cycle: 'corner', corner: spec.corner },
      probe: spec.probe,
      reach: spec.reach,
      zDistance: spec.zDistance,
      depth: spec.depth,
      clearance: spec.clearance,
      fastFeed: spec.fastFeed,
      slowFeed: spec.slowFeed,
      moveFeed: spec.moveFeed,
      ...(spec.travel === undefined ? {} : { travel: spec.travel }),
      ...(spec.floor === undefined ? {} : { floor: spec.floor }),
      ...(spec.inches === undefined ? {} : { inches: spec.inches }),
      cancelled,
    })
    if (r.isErr()) return Err(r.unwrapErr())
    const v = r.unwrap()
    if (v.top !== undefined) out.z = v.top.value
    if (v.x !== undefined) out.x = v.x.value
    if (v.y !== undefined) out.y = v.y.value
  }
  // 4. back up to the start (the path the probe travelled)
  const up = await send(`G21 G53 G0 Z${fmt(at[2])}`)
  if (up.isErr()) return Err(up.unwrapErr())
  const done = await send('G4 P0')
  if (done.isErr()) return Err(done.unwrapErr())
  return Ok(out)
}
