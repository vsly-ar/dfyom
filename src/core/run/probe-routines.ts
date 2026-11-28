/**
 * The X/Y probing routines (v0.5 RV4) built on the shared cycle runner: a single X or Y edge, a
 * corner (Z on the top, then X, then Y) and a hole or boss centre. Positioning moves into space
 * the probe has not travelled are `G38.3` (an unexpected contact stops them without an alarm and
 * the routine aborts); moves back along a travelled path are rapids. Results are machine
 * coordinates with the probe's radius and the corner plate's offsets applied; nothing is written.
 * Headless. Doc: docs/modes/run-probing.md#xy-probing-rv4
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { ProbeKind } from '../library/machine.dto'
import type { Vec3 } from '../toolpath/model'
import {
  floorHit,
  floorRefused,
  fmt,
  modalRestore,
  probeResult,
  runProbeCycle,
  type ProbeAxis,
  type ProbeCycleResult,
  type ProbeFloor,
  type ProbePort,
} from './probe-cycle'

export { PROBE_KINDS, type ProbeKind } from '../library/machine.dto'

/** v0.5 RV4: routine defaults (docs/modes/run-probing.md#probe-settings-rv4), mm and mm/min. */
export const ROUTINE_DEFAULTS = {
  reach: 10,
  zDistance: 25,
  depth: 3,
  clearance: 2,
  fastFeed: 100,
  slowFeed: 20,
  moveFeed: 300,
} as const

/** The kinds that can probe X/Y edges and corners. */
export const XY_PROBE_KINDS: readonly ProbeKind[] = ['xyzPlate', 'tool', '3d']

export interface ProbeGeometry {
  readonly kind: ProbeKind
  /** mm: Ø of what touches: the bit (`xyzPlate`, `tool`) or the 3D probe's ball (`3d`). */
  readonly tipDiameter: number
  /** `xyzPlate`: the plate's top above the stock top (mm). */
  readonly plateThickness?: number
  /** `xyzPlate`: the walls' outer faces out from the stock's edges, X and Y (mm). */
  readonly wallOffset?: readonly [number, number]
}

export type ProbeRoutine =
  /** The stock's X− (`side` −1) or X+ (+1) edge, or Y; probed from outside, toward the stock. */
  | { readonly cycle: 'edge'; readonly axis: 'x' | 'y'; readonly side: -1 | 1 }
  /** The stock's corner on these sides (X, Y): Z on the top, then X, then Y. */
  | { readonly cycle: 'corner'; readonly corner: readonly [-1 | 1, -1 | 1] }
  /** A hole (from inside, at the probing depth) or a boss (from above): its centre and Ø. */
  | {
      readonly cycle: 'centre'
      readonly feature: 'hole' | 'boss'
      /** mm: the largest Ø it may have. */
      readonly diameter: number
    }

export interface ProbeRoutineSpec {
  readonly routine: ProbeRoutine
  readonly probe: ProbeGeometry
  /**
   * mm: how far from the start the edge may be (an edge or a corner: the plate's size with an XYZ
   * plate), or the start from the boss's centre.
   */
  readonly reach: number
  /** mm: down from the start to the top at most. */
  readonly zDistance: number
  /** mm below the touched top where X/Y contacts are made. */
  readonly depth: number
  /** mm: the lift above the top and the gap kept when stepping out. */
  readonly clearance: number
  /** mm/min: the seeks. */
  readonly fastFeed: number
  /** mm/min: the slow re-probes. */
  readonly slowFeed: number
  /** mm/min: the `G38.3` positioning moves. */
  readonly moveFeed: number
  readonly travel?: { readonly min: Vec3; readonly max: Vec3 }
  /** v0.5 RV11: the bed (docs/modes/run-surface.md#uses): every cycle and positioning move. */
  readonly floor?: ProbeFloor
  readonly inches?: boolean
  readonly cancelled?: () => boolean
}

/** A probed value (MPos mm) with its uncertainty (± mm). */
export interface ProbedValue {
  readonly value: number
  readonly uncertainty: number
}

export interface ProbeRoutineResult {
  readonly cycle: ProbeRoutine['cycle']
  /** The stock's (or boss's) top, MPos Z: the plate's thickness taken off. */
  readonly top?: ProbedValue
  /** The stock's X edge, MPos X: the probe's radius and the plate's wall offset applied. */
  readonly x?: ProbedValue
  readonly y?: ProbedValue
  /** A hole or boss: its centre (MPos X, Y) and Ø. */
  readonly centre?: {
    readonly x: ProbedValue
    readonly y: ProbedValue
    readonly diameter: ProbedValue
  }
  /** Where the routine started (MPos); it ends above it (a centre: above the centre). */
  readonly start: Vec3
}

/** The slow re-probes per contact (their spread is the uncertainty). */
const SLOW_REPEATS = 2
/** Back off before a slow re-probe (mm). */
const BACK_OFF = 1
const where = 'probeRoutine'
const AXES: readonly ProbeAxis[] = ['x', 'y', 'z']

/** `run.state` with a rule: a routine refused or stopped (run-probing.md § X/Y probing). */
function refused(message: string, rule: string, data: Record<string, unknown> = {}) {
  return fail('run.state', message, { where, data, issues: [{ path: [], rule, message }] })
}

function malformed(path: string, message: string): AppResult<never> {
  return fail('input.malformed', message, {
    where,
    issues: [{ path: [path], rule: 'positive', message }],
  })
}

/** The checks before anything is sent: numbers, and a probe kind that can do the routine. */
export function checkRoutine(s: ProbeRoutineSpec): AppResult<void> {
  const positive = (v: number) => Number.isFinite(v) && v > 0
  for (const [k, v] of [
    ['reach', s.reach],
    ['zDistance', s.zDistance],
    ['depth', s.depth],
    ['clearance', s.clearance],
    ['fastFeed', s.fastFeed],
    ['slowFeed', s.slowFeed],
    ['moveFeed', s.moveFeed],
  ] as const)
    if (!positive(v)) return malformed(k, `${k} must be > 0`)
  const p = s.probe
  if (!(Number.isFinite(p.tipDiameter) && p.tipDiameter >= 0))
    return malformed('tipDiameter', 'the tip Ø must be ≥ 0')
  if (s.routine.cycle === 'centre' && !positive(s.routine.diameter))
    return malformed('diameter', 'the diameter must be > 0')
  if (!XY_PROBE_KINDS.includes(p.kind))
    return refused(
      'A Z touch plate probes Z only: X/Y needs an XYZ corner plate, the bit on a conductive stock or a 3D probe. Set the probe kind in Machine settings, or touch the edge with the bit instead.',
      'probeKind',
      { kind: p.kind },
    )
  if (p.kind === 'xyzPlate') {
    if (s.routine.cycle === 'centre')
      return refused(
        'A hole or boss centre needs the bit or a 3D probe touching the part, not the corner plate.',
        'probeKind',
        { kind: p.kind },
      )
    const [wx, wy] = p.wallOffset ?? [NaN, NaN]
    if (
      p.plateThickness === undefined ||
      !(p.plateThickness > 0) ||
      !(wx >= 0) ||
      !(wy >= 0) ||
      !Number.isFinite(wx + wy)
    )
      return refused(
        "The corner plate's thickness and wall offsets are not set: enter them in Machine settings (Probe).",
        'probeGeometry',
      )
  }
  return Ok(undefined)
}

const withAxis = (v: Vec3, i: number, value: number): Vec3 =>
  [i === 0 ? value : v[0], i === 1 ? value : v[1], i === 2 ? value : v[2]] as const

/**
 * The moves a routine makes at most, for the workholding guard and the preview (MPos points the
 * tool passes through, from `start`, each probe to its full distance): `surface` is the expected
 * top under the start (the plate's or the stock's), else the probe's full Z distance is assumed.
 */
export function routinePath(s: ProbeRoutineSpec, start: Vec3, surface?: number): Vec3[] {
  const r = s.probe.tipDiameter / 2
  const out: Vec3[] = []
  const top = Math.max(start[2] - s.zDistance, Math.min(start[2], surface ?? -Infinity))
  const lifted = top + s.clearance
  const probeLow = top - s.depth
  const zFirst = s.routine.cycle !== 'centre' || s.routine.feature === 'boss'
  if (zFirst) {
    out.push([start[0], start[1], top])
    out.push([start[0], start[1], lifted])
  }
  const side = (i: 0 | 1, dir: -1 | 1, distance: number, low: number) => {
    const at = (v: number): Vec3 => withAxis([start[0], start[1], lifted], i, v)
    const o = at(start[i] + dir * distance)
    out.push(o, [o[0], o[1], low], withAxis([o[0], o[1], low], i, start[i]), [o[0], o[1], low])
    out.push(o, at(start[i]))
  }
  const routine = s.routine
  if (routine.cycle === 'edge') {
    side(routine.axis === 'x' ? 0 : 1, routine.side, s.reach + r + s.clearance, probeLow)
  } else if (routine.cycle === 'corner') {
    side(0, routine.corner[0], s.reach + r + s.clearance, probeLow)
    side(1, routine.corner[1], s.reach + r + s.clearance, probeLow)
  } else if (routine.feature === 'boss') {
    const d = routine.diameter / 2 + s.reach + r + s.clearance
    for (const [i, dir] of [
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
    ] as const)
      side(i, dir, d, probeLow)
  } else {
    // a hole: from the start along X and Y both ways, the full Ø each
    for (const [i, dir] of [
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
    ] as const) {
      out.push(withAxis(start, i, start[i] + dir * routine.diameter), start)
    }
  }
  return out
}

/**
 * Runs one routine (docs/modes/run-probing.md#xy-probing-rv4). The start: above the plate or the
 * stock top within `reach` of the edge(s) (an edge or a corner), above the boss, or inside the
 * hole at the probing depth. Failures come back as the runner's (an `ALARM:5` miss is recovered:
 * the routine then returns above its start) or `run.state` (rule `unexpectedContact`).
 */
export async function runProbeRoutine(
  port: ProbePort,
  spec: ProbeRoutineSpec,
): Promise<AppResult<ProbeRoutineResult>> {
  const checked = checkRoutine(spec)
  if (checked.isErr()) return Err(checked.unwrapErr())
  const r = spec.probe.tipDiameter / 2
  const cancelled = () => spec.cancelled?.() === true

  const st0 = await port.status()
  if (st0.isErr()) return Err(st0.unwrapErr())
  const start = st0.unwrap().mpos
  const s0 = st0.unwrap()
  const wco: Vec3 = [s0.mpos[0] - s0.wpos[0], s0.mpos[1] - s0.wpos[1], s0.mpos[2] - s0.wpos[2]]
  // the routine's own moves change the modal state: read it to put it back at the end
  let restore: string[] | undefined

  const send = async (line: string, timeoutMs?: number) => {
    if (cancelled()) return fail('op.aborted', 'the probe routine was cancelled', { where })
    return port.command(line, timeoutMs === undefined ? {} : { timeoutMs })
  }
  const here = async (): Promise<AppResult<Vec3>> => {
    const s = await port.status()
    return s.isErr() ? Err(s.unwrapErr()) : Ok(s.unwrap().mpos)
  }
  /** A rapid back along a path the probe travelled (machine coordinates). */
  const rapid = async (to: Vec3): Promise<AppResult<void>> => {
    const r2 = await send(`G21 G53 G0 X${fmt(to[0])} Y${fmt(to[1])} Z${fmt(to[2])}`)
    return r2.isErr() ? Err(r2.unwrapErr()) : Ok(undefined)
  }
  /** The retrace after a failure: each point, in order (the path back), then the modal state. */
  const back = async (path: readonly Vec3[]): Promise<AppResult<void>> => {
    for (const p of path) {
      const b = await rapid(p)
      if (b.isErr()) return b
    }
    return finish()
  }
  const finish = async (): Promise<AppResult<void>> => {
    for (const line of [...(restore ?? []), 'G4 P0']) {
      const f = await send(line)
      if (f.isErr()) return Err(f.unwrapErr())
    }
    return Ok(undefined)
  }
  /**
   * A positioning move into untravelled space: `G38.3` (no alarm on a miss); a contact stops it,
   * the tool goes back to where the move began, then along `path` home, and the routine aborts.
   */
  const position = async (
    from: Vec3,
    to: Vec3,
    path: readonly Vec3[],
  ): Promise<AppResult<void>> => {
    const words = AXES.flatMap((a, i) =>
      Math.abs(to[i]! - from[i]!) > 1e-6 ? [`${a.toUpperCase()}${fmt(to[i]! - wco[i]!)}`] : [],
    )
    if (words.length === 0) return Ok(undefined)
    // RV11: never toward the bed: refused before the move, home along the path
    const low = floorHit(spec.floor, from, to)
    if (low !== undefined) {
      const b = await back(path)
      if (b.isErr()) return b
      return floorRefused(low, where)
    }
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    const m = await send(
      `G21 G90 G38.3 ${words.join(' ')} F${fmt(spec.moveFeed)}`,
      (length / spec.moveFeed) * 60_000 + 10_000,
    )
    if (m.isErr()) return Err(m.unwrapErr())
    const prb = probeResult(m.unwrap())
    if (prb?.ok === true) {
      const k = spec.inches === true ? 25.4 : 1
      const at: Vec3 = [prb.pos[0] * k, prb.pos[1] * k, prb.pos[2] * k]
      const b = await back([from, ...path])
      if (b.isErr()) return b
      return refused(
        `The probe touched something on a positioning move at X ${fmt(at[0])} Y ${fmt(at[1])} Z ${fmt(at[2])} (machine): it went back to the start. Check for clamps and chips, and that the edge is within the reach of the start, then probe again.`,
        'unexpectedContact',
        { at, from, to },
      )
    }
    return Ok(undefined)
  }
  /** One runner cycle; a failure (already recovered by the runner) retraces `path`. */
  const cycle = async (
    axis: ProbeAxis,
    direction: -1 | 1,
    maxDistance: number,
    retract: number,
    path: readonly Vec3[],
  ): Promise<AppResult<ProbeCycleResult>> => {
    const c = await runProbeCycle(port, {
      axis,
      direction,
      maxDistance,
      fastFeed: spec.fastFeed,
      slow: { feed: spec.slowFeed, backOff: BACK_OFF, repeats: SLOW_REPEATS },
      retract,
      ...(spec.travel === undefined ? {} : { travel: spec.travel }),
      ...(spec.floor === undefined ? {} : { floor: spec.floor }),
      ...(spec.inches === undefined ? {} : { inches: spec.inches }),
      ...(spec.cancelled === undefined ? {} : { cancelled: spec.cancelled }),
    })
    if (c.isErr()) {
      const e = c.unwrapErr()
      // a recovered miss leaves the tool where the probe began: go home along the path
      if (e.code === 'machine.alarm' && e.frames[0]?.data?.['recovered'] === true) {
        const b = await back(path)
        if (b.isErr()) return Err(b.unwrapErr())
      }
      return Err(e)
    }
    return c
  }

  const routine = spec.routine
  let top: ProbedValue | undefined
  let surface = start[2]
  let lifted: Vec3 = start
  const zFirst = routine.cycle !== 'centre' || routine.feature === 'boss'
  if (zFirst) {
    // ── Z on the top (the plate's or the stock's) ──
    const z = await cycle('z', -1, spec.zDistance, spec.clearance, [])
    if (z.isErr()) return Err(z.unwrapErr())
    const gc = await send('$G')
    if (gc.isErr()) return Err(gc.unwrapErr())
    restore = modalRestore(
      gc
        .unwrap()
        .find((l) => l.startsWith('[GC:'))
        ?.slice(4, -1)
        .split(' ') ?? [],
      spec.inches === true,
    )
    surface = z.unwrap().value
    const h = await here()
    if (h.isErr()) return Err(h.unwrapErr())
    lifted = h.unwrap()
    const plate = spec.probe.kind === 'xyzPlate' ? (spec.probe.plateThickness ?? 0) : 0
    top = { value: surface - plate, uncertainty: z.unwrap().uncertainty }
  } else {
    const gc = await send('$G')
    if (gc.isErr()) return Err(gc.unwrapErr())
    restore = modalRestore(
      gc
        .unwrap()
        .find((l) => l.startsWith('[GC:'))
        ?.slice(4, -1)
        .split(' ') ?? [],
      spec.inches === true,
    )
  }

  /**
   * From `lifted` step out on axis `i` by `distance` (toward `dir`), down to the probing depth,
   * probe back toward the start, return to the step-out point, up and back to `lifted`. The
   * contact (MPos on the axis) comes back.
   */
  const fromOutside = async (
    i: 0 | 1,
    dir: -1 | 1,
    distance: number,
  ): Promise<AppResult<ProbeCycleResult>> => {
    const out = withAxis(lifted, i, lifted[i]! + dir * distance)
    const low: Vec3 = [out[0], out[1], surface - spec.depth]
    const p1 = await position(lifted, out, [lifted])
    if (p1.isErr()) return Err(p1.unwrapErr())
    const p2 = await position(out, low, [out, lifted])
    if (p2.isErr()) return Err(p2.unwrapErr())
    const c = await cycle(AXES[i]!, dir < 0 ? 1 : -1, distance, distance, [out, lifted])
    if (c.isErr()) return c
    // the runner retracted to the step-out point (its start): up and back retrace the way in
    const b1 = await rapid(out)
    if (b1.isErr()) return Err(b1.unwrapErr())
    const b2 = await rapid(lifted)
    if (b2.isErr()) return Err(b2.unwrapErr())
    return c
  }
  const value = (c: ProbeCycleResult, offset: number): ProbedValue => ({
    value: c.value + offset,
    uncertainty: c.uncertainty,
  })
  const wall = (i: 0 | 1) => (spec.probe.kind === 'xyzPlate' ? spec.probe.wallOffset![i]! : 0)

  if (routine.cycle === 'edge' || routine.cycle === 'corner') {
    const sides: [0 | 1, -1 | 1][] =
      routine.cycle === 'edge'
        ? [[routine.axis === 'x' ? 0 : 1, routine.side]]
        : [
            [0, routine.corner[0]],
            [1, routine.corner[1]],
          ]
    const found: (ProbedValue | undefined)[] = [undefined, undefined]
    for (const [i, side] of sides) {
      const c = await fromOutside(i, side, spec.reach + r + spec.clearance)
      if (c.isErr()) return Err(c.unwrapErr())
      // the probe moved toward −side: the edge lies the radius and the wall further on
      found[i] = value(c.unwrap(), -side * (r + wall(i)))
    }
    const f = await finish()
    if (f.isErr()) return Err(f.unwrapErr())
    return Ok({
      cycle: routine.cycle,
      ...(top === undefined ? {} : { top }),
      ...(found[0] === undefined ? {} : { x: found[0] }),
      ...(found[1] === undefined ? {} : { y: found[1] }),
      start,
    })
  }

  // ── a hole or a boss: X both ways, then Y both ways (chords through the start) ──
  const contacts: number[][] = [[], []]
  const uncertainty: number[] = []
  for (const [i, dir] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ] as const) {
    let c: AppResult<ProbeCycleResult>
    if (routine.feature === 'hole') {
      // inside the hole: out along the axis to the wall, back to the start
      c = await cycle(AXES[i]!, dir, routine.diameter, routine.diameter, [])
      if (c.isErr()) return Err(c.unwrapErr())
      const b = await rapid(lifted)
      if (b.isErr()) return Err(b.unwrapErr())
    } else {
      c = await fromOutside(i, dir, routine.diameter / 2 + spec.reach + r + spec.clearance)
      if (c.isErr()) return Err(c.unwrapErr())
    }
    contacts[i]!.push(c.unwrap().value)
    uncertainty.push(c.unwrap().uncertainty)
  }
  // contact centres lie on a circle of radius R ∓ r about the centre; each chord's midpoint is
  // the centre on its axis, and its half-length with the other axis's offset gives the radius
  const [x1, x2] = contacts[0] as [number, number]
  const [y1, y2] = contacts[1] as [number, number]
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = Math.hypot(Math.abs(x1 - x2) / 2, lifted[1] - cy)
  const ry = Math.hypot(Math.abs(y1 - y2) / 2, lifted[0] - cx)
  const toR = (v: number) => (routine.feature === 'hole' ? v + r : v - r)
  const u = Math.max(...uncertainty)
  const centre = {
    x: { value: cx, uncertainty: u },
    y: { value: cy, uncertainty: u },
    diameter: {
      value: toR(rx) + toR(ry),
      uncertainty: Math.max(2 * u, Math.abs(toR(rx) - toR(ry))),
    },
  }
  // end above (or in) the centre: a straight move nothing has travelled
  const p = await position(lifted, [cx, cy, lifted[2]], [lifted])
  if (p.isErr()) return Err(p.unwrapErr())
  const f = await finish()
  if (f.isErr()) return Err(f.unwrapErr())
  return Ok({ cycle: 'centre', ...(top === undefined ? {} : { top }), centre, start })
}
