/** Generic toolpath property checks for tests. Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210 */
import type { Vec3 } from '../../geometry/model'
import type { Toolpath } from '../model'
import { arcSweep, expandDrill } from '../stats'
import { samples, type FlatMove } from './oracles'

export interface PathRules {
  readonly feedRate: number
  readonly plungeRate: number
  /** Steepest allowed descent with XY motion faster than the plunge rate (degrees). */
  readonly rampAngle?: number
  /** Rapids move horizontally only at or above this Z. */
  readonly retractZ: number
  readonly clearanceZ: number
  /** Does the tool with its tip at `p` stay within the removal region (with tolerance)? */
  readonly contains: (p: Vec3) => boolean
}

const fmt = (p: readonly number[]) => p.map((n) => n.toFixed(3)).join(',')

/**
 * Generic toolpath properties; returns violations (empty = fine): starts and ends with a rapid
 * at clearance, arcs continuous (start and end on one circle) and ≤ 180°, no plunge faster
 * than the plunge rate, ramps no steeper than the ramp angle, rapids horizontal only above the
 * retract plane, feeds ≤ the feed rate, every feed move within the removal region.
 */
export function violations(tp: Toolpath, rules: PathRules, step = 0.2): string[] {
  const out: string[] = []
  const all = tp.passes.flatMap((p) => p.moves)
  const first = all[0]
  const last = all.at(-1)
  if (first?.kind !== 'rapid' || Math.abs(first.to[2] - rules.clearanceZ) > 1e-9)
    out.push('first move is not a rapid at clearance')
  if (last?.kind !== 'rapid' || Math.abs(last.to[2] - rules.clearanceZ) > 1e-9)
    out.push('last move is not a rapid to clearance')
  const tan = rules.rampAngle === undefined ? 0 : Math.tan((rules.rampAngle * Math.PI) / 180)
  const check = (m: FlatMove, from: Vec3, inDrill: boolean) => {
    const where = `${m.kind} to ${fmt(m.to)}`
    const dz = m.to[2] - from[2]
    if (m.kind === 'rapid') {
      const horizontal = Math.hypot(m.to[0] - from[0], m.to[1] - from[1]) > 1e-9
      const low = horizontal ? Math.min(from[2], m.to[2]) : m.to[2]
      if (!inDrill && low < rules.retractZ - 1e-9) out.push(`rapid below retract: ${where}`)
      return
    }
    if (m.feed > rules.feedRate + 1e-9) out.push(`feed above feed rate: ${where}`)
    let horizontal: number
    if (m.kind === 'arc') {
      const r0 = Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
      const r1 = Math.hypot(m.to[0] - m.center[0], m.to[1] - m.center[1])
      if (Math.abs(r0 - r1) > 1e-6) out.push(`arc not continuous (${r0} vs ${r1}): ${where}`)
      const sweep = Math.abs(arcSweep(from, m))
      if (sweep > Math.PI + 1e-9) out.push(`arc over 180°: ${where}`)
      horizontal = r0 * sweep
    } else horizontal = Math.hypot(m.to[0] - from[0], m.to[1] - from[1])
    if (dz < -1e-9 && m.feed > rules.plungeRate + 1e-9) {
      if (horizontal < 1e-6) out.push(`plunge faster than plunge rate: ${where}`)
      else if (-dz / horizontal > tan + 1e-9) out.push(`ramp too steep: ${where}`)
    }
    for (const p of samples({ from, move: m, pass: 0 }, step))
      if (!rules.contains(p)) {
        out.push(`outside the removal region at ${fmt(p)}: ${where}`)
        break
      }
  }
  let pos: Vec3 | undefined
  for (const m of all) {
    if (pos !== undefined) {
      if (m.kind === 'drill') {
        let p = pos
        for (const e of expandDrill(m)) {
          check(e, p, true)
          p = e.to
        }
      } else check(m, pos, false)
    }
    pos = m.kind === 'drill' ? [m.at[0], m.at[1], m.retract] : m.to
  }
  return out
}

/** Distinct Z values of horizontal feed moves, highest first: the cutting levels. */
export function cuttingLevels(tp: Toolpath, kind?: 'rough' | 'finish'): number[] {
  const zs: number[] = []
  let pos: Vec3 | undefined
  for (const p of tp.passes)
    for (const m of p.moves) {
      if (m.kind === 'drill') continue
      if (pos !== undefined && m.kind !== 'rapid' && (kind === undefined || p.kind === kind)) {
        const horizontal = Math.hypot(m.to[0] - pos[0], m.to[1] - pos[1]) > 1e-6
        const level = Math.abs(m.to[2] - pos[2]) < 1e-9
        if (horizontal && level && !zs.some((z) => Math.abs(z - m.to[2]) < 1e-6)) zs.push(m.to[2])
      }
      pos = m.to
    }
  return zs.sort((a, b) => b - a)
}

/** Every level step (from `top`) is at most `stepdown`. */
export function stepsWithin(levelsZ: readonly number[], top: number, stepdown: number): boolean {
  let prev = top
  for (const z of levelsZ) {
    if (prev - z > stepdown + 1e-9) return false
    prev = z
  }
  return true
}
