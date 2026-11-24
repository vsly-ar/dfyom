/**
 * The collision check of a setup's program against its workholding (WH-E, WH-F): every move
 * (rapids, links between operations, leads, ramps, helices, expanded drill cycles) against every
 * prism, with the tool as a vertical cylinder of radius max(cutting Ø, shank Ø) / 2 from its tip
 * upward; plus breakthrough into a fixture plate.
 * Doc: docs/modes/workholding.md#collision-check
 *
 * Pure and headless; mm in the setup's WCS. Lines are exact; arcs and helices exact in XY to
 * `ARC_TOLERANCE` (chords, the sagitta subtracted) with Z taken as the move's lowest Z.
 */
import type { Vec2 } from '../../geometry/model'
import type { Move, Vec3 } from '../../toolpath/model'
import { arcSweep, expandDrill, PECK_CLEARANCE } from '../../toolpath/stats'
import { segmentDistance, type Prism } from './obstacles'

/** Chord sagitta of arcs in the check (mm). */
export const ARC_TOLERANCE = 0.001
/** A gap this much under the margin still counts as kept (offset precision of the 2D port). */
export const GAP_TOLERANCE = 0.01

export interface CheckTool {
  /** Cutting diameter (mm). */
  readonly diameter: number
  /** Shank diameter (mm); absent = the cutting diameter. */
  readonly shankDiameter?: number
}

/** One operation of the program, in machining order. */
export interface CheckOperation {
  readonly planOperationId: string
  readonly tool: CheckTool
  /** The final moves in the WCS (drill cycles allowed; they are expanded). */
  readonly moves: readonly Move[]
}

export interface CheckInput {
  readonly operations: readonly CheckOperation[]
  readonly prisms: readonly Prism[]
  readonly margin: number
  /** The program's clearance Z: rapids at it are links between operations. */
  readonly clearanceZ: number
  /** A fixture plate under the stock: cuts below `stockBottom` are breakthrough errors. */
  readonly fixturePlate?: { readonly itemId: string; readonly stockBottom: number }
}

export type CollisionKind = 'rapid' | 'link' | 'cut'

export interface Collision {
  readonly kind: CollisionKind
  readonly planOperationId: string
  readonly itemId: string
  /** Index of the move in its operation's expanded move list. */
  readonly moveIndex: number
  /** The point of the move nearest the item (XY) at its lowest Z there. */
  readonly at: Vec3
  readonly lowestZ: number
  /** Gap between the tool envelope and the item (mm, 0 = touching or inside). */
  readonly gap: number
}

export interface WorkholdingCheck {
  /** The first collision per operation, item and kind, in program order. */
  readonly collisions: readonly Collision[]
  /** Every colliding move. */
  readonly collisionCount: number
  /**
   * Rapids and links passing beside an item below its top + margin with a gap under 2 × margin
   * (not colliding): first per operation and item. Passing over it at its top + margin is fine.
   */
  readonly close: readonly Collision[]
  /** Cuts below the stock bottom over a fixture plate: first per operation. */
  readonly breakthrough: readonly Collision[]
  /** The smallest gap of any move that passes below an item's top + margin (mm), or null. */
  readonly minGap: number | null
}

interface Segment {
  readonly a: Vec3
  readonly b: Vec3
  /** Arc chords: the sagitta to subtract, and the arc's lowest Z for the whole chord. */
  readonly slack: number
  readonly flatZ?: number
}

/** XY chords of an arc from `from`, each with the arc's lowest Z (conservative). */
function arcSegments(from: Vec3, m: Extract<Move, { kind: 'arc' }>): Segment[] {
  const sweep = arcSweep(from, m)
  const r = Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
  // sagitta r (1 − cos(θ/2)) ≤ tol
  const step = r <= ARC_TOLERANCE ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - ARC_TOLERANCE / r))
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step))
  const a0 = Math.atan2(from[1] - m.center[1], from[0] - m.center[0])
  const lowest = Math.min(from[2], m.to[2])
  const slack = r * (1 - Math.cos(Math.abs(sweep) / n / 2))
  const pts: Vec2[] = []
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n
    pts.push(
      k === n ? [m.to[0], m.to[1]] : [m.center[0] + r * Math.cos(a), m.center[1] + r * Math.sin(a)],
    )
  }
  const out: Segment[] = []
  for (let k = 0; k < n; k++)
    out.push({
      a: [pts[k]![0], pts[k]![1], lowest],
      b: [pts[k + 1]![0], pts[k + 1]![1], lowest],
      slack,
      flatZ: lowest,
    })
  return out
}

/** The part of segment ab below `z` (parameter range), or undefined. */
function below(s: Segment, z: number): { a: Vec3; b: Vec3 } | undefined {
  const za = s.a[2]
  const zb = s.b[2]
  if (za >= z && zb >= z) return undefined
  if (za < z && zb < z) return { a: s.a, b: s.b }
  const t = (z - za) / (zb - za)
  const m: Vec3 = [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1]), z]
  return za < z ? { a: s.a, b: m } : { a: m, b: s.b }
}

/** Every move of the program against the prisms; never fails. */
export function checkWorkholding(input: CheckInput): WorkholdingCheck {
  const { prisms, margin, clearanceZ } = input
  const collisions: Collision[] = []
  const close: Collision[] = []
  const breakthrough: Collision[] = []
  const seen = new Set<string>()
  let count = 0
  let minGap: number | null = null
  let pos: Vec3 | undefined
  const eps = 1e-6
  for (const op of input.operations) {
    const R = Math.max(op.tool.diameter, op.tool.shankDiameter ?? 0) / 2
    const moves: Exclude<Move, { kind: 'drill' }>[] = []
    for (const m of op.moves)
      if (m.kind === 'drill') {
        moves.push({ kind: 'rapid', to: [m.at[0], m.at[1], m.retract] })
        moves.push(...expandDrill(m, PECK_CLEARANCE))
      } else moves.push(m)
    moves.forEach((m, index) => {
      const from = pos
      pos = m.to
      // from an unknown position (program start, after a pause): the end point only
      const start: Vec3 = from ?? m.to
      const cut = m.kind !== 'rapid'
      const kind: CollisionKind = cut
        ? 'cut'
        : start[2] >= clearanceZ - eps && m.to[2] >= clearanceZ - eps
          ? 'link'
          : 'rapid'
      const segs: Segment[] =
        m.kind === 'arc' ? arcSegments(start, m) : [{ a: start, b: m.to, slack: 0 }]
      if (cut && input.fixturePlate !== undefined) {
        const lowest = Math.min(start[2], m.to[2])
        const key = `b:${op.planOperationId}`
        if (lowest < input.fixturePlate.stockBottom - 1e-4 && !seen.has(key)) {
          seen.add(key)
          breakthrough.push({
            kind: 'cut',
            planOperationId: op.planOperationId,
            itemId: input.fixturePlate.itemId,
            moveIndex: index,
            at: start[2] < m.to[2] ? start : m.to,
            lowestZ: lowest,
            gap: 0,
          })
        }
      }
      for (const p of prisms) {
        const top = p.zMax + margin
        let hit: { gap: number; at: Vec3; lowest: number } | undefined
        let nearest: { gap: number; at: Vec3; lowest: number } | undefined
        for (const s of segs) {
          const part = below(s, top)
          if (part === undefined) continue
          const d = segmentDistance(p.footprint, [part.a[0], part.a[1]], [part.b[0], part.b[1]])
          const gap = Math.max(0, d.distance - s.slack - R)
          const lowest = Math.min(part.a[2], part.b[2])
          const at: Vec3 = [d.at[0], d.at[1], lowest]
          if (minGap === null || gap < minGap) minGap = gap
          if (gap < margin - GAP_TOLERANCE) {
            if (hit === undefined || gap < hit.gap) hit = { gap, at, lowest }
          } else if (!cut && gap < 2 * margin - GAP_TOLERANCE) {
            // close: a rapid beside the item, below its top + margin
            if (nearest === undefined || gap < nearest.gap) nearest = { gap, at, lowest }
          }
        }
        if (hit !== undefined) {
          count++
          const key = `c:${op.planOperationId}:${p.itemId}:${kind}`
          if (!seen.has(key)) {
            seen.add(key)
            collisions.push({
              kind,
              planOperationId: op.planOperationId,
              itemId: p.itemId,
              moveIndex: index,
              at: hit.at,
              lowestZ: hit.lowest,
              gap: hit.gap,
            })
          }
        } else if (nearest !== undefined) {
          const key = `n:${op.planOperationId}:${p.itemId}`
          if (!seen.has(key)) {
            seen.add(key)
            close.push({
              kind,
              planOperationId: op.planOperationId,
              itemId: p.itemId,
              moveIndex: index,
              at: nearest.at,
              lowestZ: nearest.lowest,
              gap: nearest.gap,
            })
          }
        }
      }
    })
  }
  return { collisions, collisionCount: count, close, breakthrough, minGap }
}
