/**
 * Probing a stock surface map (v0.5 RV10): the grid over an area, the serpentine order, and one
 * point through the shared cycle runner (up to the travel height along Z, across with `G38.3`, then
 * `G38.2` down with a slow re-probe, retract). The loop over the points is the caller's (the Run
 * dialog, one `run.machine.surfacePoint` job per point, so a failure keeps what was measured).
 * Headless. Doc: docs/modes/run-surface.md#probing-a-map
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { HeightMap } from '../post/height-map'
import type { Vec3 } from '../toolpath/model'
import { fmt, probeResult, runProbeCycle, type ProbePort } from './probe-cycle'

/** Map probing defaults (docs/modes/run-surface.md#probing-a-map), mm and mm/min. */
export const SURFACE_DEFAULTS = {
  margin: 5,
  cols: 5,
  rows: 4,
  /** Lift above each contact: the travel height to the next point. */
  clearance: 2,
  /** Search below the last contact (the first point: `firstDepth` below the start). */
  depth: 5,
  firstDepth: 25,
  fastFeed: 100,
  slowFeed: 20,
  moveFeed: 600,
  minPoints: 3,
  maxPoints: 30,
} as const

/**
 * The virtual machine's stock top tilt (mm per mm in X and Y): about 0.4 mm over 100 mm, so a map
 * shows a range (docs/modes/run-surface.md#virtual-machine).
 */
export const VIRTUAL_TILT: readonly [number, number] = [0.004, -0.002]

/** The grid over `[min, max]` (work X/Y): origin, spacing and every point, row by row. */
export function surfaceGrid(
  min: readonly [number, number],
  max: readonly [number, number],
  cols: number,
  rows: number,
): Pick<HeightMap, 'origin' | 'spacing' | 'cols' | 'rows'> & {
  points: [number, number][]
} {
  const dx = (max[0] - min[0]) / (cols - 1)
  const dy = (max[1] - min[1]) / (rows - 1)
  const points: [number, number][] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) points.push([min[0] + c * dx, min[1] + r * dy])
  return { origin: [min[0], min[1]], spacing: [dx, dy], cols, rows, points }
}

/** Point indices in serpentine order: row by row from the front, alternating direction. */
export function serpentine(cols: number, rows: number): number[] {
  const out: number[] = []
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) out.push(r * cols + (r % 2 === 0 ? k : cols - 1 - k))
  return out
}

/** Counts for a spacing over a side (3–30 points). */
export function pointsFor(side: number, spacing: number): number {
  const n = Math.round(side / spacing) + 1
  return Math.min(SURFACE_DEFAULTS.maxPoints, Math.max(SURFACE_DEFAULTS.minPoints, n))
}

/**
 * The map's time estimate (s): per point the move at the positioning feed, the probe down the
 * clearance at the seek feed, the slow re-probe and the retract (rapids taken as 0.5 s each).
 */
export function mapEstimateSeconds(
  points: readonly (readonly [number, number])[],
  opts: { clearance: number; fastFeed: number; slowFeed: number; moveFeed: number },
): number {
  let s = 0
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!
    const b = points[k]!
    s += (Math.hypot(b[0] - a[0], b[1] - a[1]) / opts.moveFeed) * 60
  }
  const perPoint = (opts.clearance / opts.fastFeed) * 60 + (1 / opts.slowFeed) * 60 + 2 * 0.5
  return s + perPoint * points.length
}

export interface SurfacePointSpec {
  /** The point, MPos X/Y. */
  readonly at: readonly [number, number]
  /** MPos Z the move across is made at (raised to first along Z when lower). */
  readonly travelZ: number
  /** mm: down from the travel height at most. */
  readonly zDistance: number
  /** mm: up from the contact at the end. */
  readonly retract: number
  readonly fastFeed: number
  readonly slowFeed: number
  /** mm/min of the `G38.3` move across. */
  readonly moveFeed: number
  readonly travel?: { readonly min: Vec3; readonly max: Vec3 }
  readonly inches?: boolean
  readonly cancelled?: () => boolean
}

export interface SurfacePointResult {
  /** The contact, MPos Z. */
  readonly z: number
  readonly uncertainty: number
}

const where = 'surfacePoint'

/**
 * One map point (docs/modes/run-surface.md#probing-a-map): a rapid up along Z to `travelZ` when
 * lower, across to the point with `G38.3` (a contact on the way: back to where it was, refused
 * `unexpectedContact`), then the Z cycle (`G38.2` down at most `zDistance`, one slow re-probe at
 * 1 mm back-off, retract). No contact is the runner's `machine.alarm` (recovered: back at the
 * travel height). Writes nothing.
 */
export async function probeSurfacePoint(
  port: ProbePort,
  spec: SurfacePointSpec,
): Promise<AppResult<SurfacePointResult>> {
  const cancelled = () => spec.cancelled?.() === true
  for (const [k, v] of [
    ['zDistance', spec.zDistance],
    ['retract', spec.retract],
    ['fastFeed', spec.fastFeed],
    ['slowFeed', spec.slowFeed],
    ['moveFeed', spec.moveFeed],
  ] as const)
    if (!(Number.isFinite(v) && v > 0))
      return fail('input.malformed', `${k} must be > 0`, {
        where,
        issues: [{ path: [k], rule: 'positive', message: `${k} must be > 0` }],
      })
  const send = async (line: string, timeoutMs?: number) => {
    if (cancelled()) return fail('op.aborted', 'the surface map was stopped', { where })
    return port.command(line, timeoutMs === undefined ? {} : { timeoutMs })
  }
  const st = await port.status()
  if (st.isErr()) return Err(st.unwrapErr())
  const s0 = st.unwrap()
  if (s0.state !== 'Idle')
    return fail('run.state', `cannot probe in state ${s0.state}`, {
      where,
      data: { state: s0.state },
    })
  const from = s0.mpos
  const top = spec.travel === undefined ? 0 : spec.travel.max[2]
  const travelZ = Math.min(top, spec.travelZ)
  // 1. up along Z: the path the last retract travelled (or straight up from the start)
  if (from[2] < travelZ - 1e-4) {
    const r = await send(`G21 G53 G0 Z${fmt(travelZ)}`)
    if (r.isErr()) return Err(r.unwrapErr())
  }
  const z = Math.max(from[2], travelZ)
  // 2. across: G38.3 in work coordinates (GRBL rejects G53 with G38.x)
  const xy = Math.hypot(spec.at[0] - from[0], spec.at[1] - from[1])
  if (xy > 1e-4) {
    const wx = spec.at[0] - (s0.mpos[0] - s0.wpos[0])
    const wy = spec.at[1] - (s0.mpos[1] - s0.wpos[1])
    const r = await send(
      `G21 G90 G38.3 X${fmt(wx)} Y${fmt(wy)} F${fmt(spec.moveFeed)}`,
      (xy / spec.moveFeed) * 60_000 + 10_000,
    )
    if (r.isErr()) return Err(r.unwrapErr())
    const prb = probeResult(r.unwrap())
    if (prb?.ok === true) {
      const back = await send(`G21 G53 G0 X${fmt(from[0])} Y${fmt(from[1])}`)
      if (back.isErr()) return Err(back.unwrapErr())
      const message = `The probe touched something on the way to the point at X ${fmt(prb.pos[0])} Y ${fmt(prb.pos[1])} (machine): it went back. Check for clamps and chips, raise the clearance, then retry.`
      return fail('run.state', message, {
        where,
        data: { at: [...spec.at], z },
        issues: [{ path: [], rule: 'unexpectedContact', message }],
      })
    }
  }
  // 3. down through the shared runner
  const c = await runProbeCycle(port, {
    axis: 'z',
    direction: -1,
    maxDistance: spec.zDistance,
    fastFeed: spec.fastFeed,
    slow: { feed: spec.slowFeed, backOff: 1, repeats: 1 },
    retract: spec.retract,
    ...(spec.travel === undefined ? {} : { travel: spec.travel }),
    ...(spec.inches === undefined ? {} : { inches: spec.inches }),
    cancelled,
  })
  if (c.isErr()) return Err(c.unwrapErr())
  return Ok({ z: c.unwrap().value, uncertainty: c.unwrap().uncertainty })
}
