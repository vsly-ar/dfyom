/**
 * Toolpath statistics (cut length, rapid length, estimated time) and drill-cycle expansion.
 * Doc: docs/modes/plan-v0.1.md#toolpath-data-model, expansion: docs/architecture/grbl.md#input-boundary
 */
import type { DrillMove, LineMove, Move, Pass, RapidMove, ToolpathStats, Vec3 } from './model'

/** Rapid back down to this far above the last peck depth (mm; grbl.md: 0.5 mm / 0.02″). */
export const PECK_CLEARANCE = 0.5

/**
 * A drill cycle as rapid and feed moves, from `[at, retract]` back to it (grbl.md): `simple`
 * feeds to the bottom; `peck` retracts fully after each peck and rapids back to `clearance`
 * above the last depth; `chipBreak` only backs off by `back`. Peck depths count from `top`.
 */
export function expandDrill(m: DrillMove, clearance = PECK_CLEARANCE): (RapidMove | LineMove)[] {
  const [x, y] = m.at
  const at = (z: number): Vec3 => [x, y, z]
  const feed = (z: number): LineMove => ({ kind: 'line', to: at(z), feed: m.feed })
  const rapid = (z: number): RapidMove => ({ kind: 'rapid', to: at(z) })
  const peck = m.peck ?? 0
  if (m.cycle === 'simple' || peck <= 0) return [feed(m.bottom), rapid(m.retract)]
  const out: (RapidMove | LineMove)[] = []
  const pecks = Math.max(1, Math.ceil((m.top - m.bottom) / peck - 1e-9))
  let last = m.retract
  for (let k = 1; k <= pecks; k++) {
    const depth = k === pecks ? m.bottom : m.top - k * peck
    if (k > 1) {
      if (m.cycle === 'peck') {
        out.push(rapid(m.retract))
        out.push(rapid(Math.min(m.retract, last + clearance)))
      } else out.push(rapid(Math.min(m.retract, last + (m.back ?? 0))))
    }
    out.push(feed(depth))
    last = depth
  }
  out.push(rapid(m.retract))
  return out
}

/** End point of a move. */
export function moveEnd(m: Move): Vec3 {
  return m.kind === 'drill' ? [m.at[0], m.at[1], m.retract] : m.to
}

/** Signed sweep (counter-clockwise > 0) of an arc move starting at `from`; at most π. */
export function arcSweep(from: Vec3, m: Extract<Move, { kind: 'arc' }>): number {
  const a0 = Math.atan2(from[1] - m.center[1], from[0] - m.center[0])
  const a1 = Math.atan2(m.to[1] - m.center[1], m.to[0] - m.center[0])
  let s = a1 - a0
  if (m.cw) {
    while (s >= 0) s -= 2 * Math.PI
    if (s < -2 * Math.PI) s += 2 * Math.PI
  } else {
    while (s <= 0) s += 2 * Math.PI
    if (s > 2 * Math.PI) s -= 2 * Math.PI
  }
  // a zero-length arc wraps to a full turn above; moves never contain one
  return s
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])

/** Length of a line or arc (helix) move from `from`. */
export function feedLength(from: Vec3, m: LineMove | Extract<Move, { kind: 'arc' }>): number {
  if (m.kind === 'line') return dist(from, m.to)
  const r = Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
  return Math.hypot(r * Math.abs(arcSweep(from, m)), m.to[2] - from[2])
}

/**
 * Stats over all passes. The position before the first move is unknown, so the first move
 * (the horizontal rapid at clearance height) is not counted.
 */
export function toolpathStats(passes: readonly Pass[], maxFeedRate?: Vec3): ToolpathStats {
  let cut = 0
  let rapid = 0
  let seconds = 0
  let pos: Vec3 | undefined
  const visit = (m: Move): void => {
    if (m.kind === 'drill') {
      for (const e of expandDrill(m)) visit(e)
      return
    }
    if (pos !== undefined) {
      if (m.kind === 'rapid') {
        rapid += dist(pos, m.to)
        if (maxFeedRate !== undefined) {
          const t = [0, 1, 2].map((i) => Math.abs(m.to[i]! - pos![i]!) / maxFeedRate[i]!)
          seconds += Math.max(...t) * 60
        }
      } else {
        const len = feedLength(pos, m)
        cut += len
        seconds += (len / m.feed) * 60
      }
    }
    pos = m.to
  }
  for (const p of passes) for (const m of p.moves) visit(m)
  return { cutLength: cut, rapidLength: rapid, estimatedSeconds: seconds }
}
