/**
 * The collision check of a setup's program against its workholding (WH-E, WH-F): every move
 * (rapids, links between operations, leads, ramps, helices, expanded drill cycles) against every
 * prism, with the tool as a vertical cylinder of radius max(cutting Ø, shank Ø) / 2 from its tip
 * upward; plus breakthrough into a fixture plate. With a holder and a stickout (DF132 H2) the
 * collet nut and the spindle body above the tool are checked too (`toolEnvelope`): a hit by them
 * alone is kind `holder`.
 * Doc: docs/modes/workholding.md#collision-check, docs/modes/tool-holder.md#checks
 *
 * Pure and headless; mm in the setup's WCS. Lines are exact; arcs and helices exact in XY to
 * `ARC_TOLERANCE` (chords, the sagitta subtracted) with Z taken as the move's lowest Z.
 */
import type { Vec2 } from '../../geometry/model'
import type { Move, Vec3 } from '../../toolpath/model'
import { arcSweep, expandDrill, PECK_CLEARANCE } from '../../toolpath/stats'
import { STICKOUT_CLEARANCE } from '../checks'
import { toolEnvelope, type HolderSizes } from './envelope'
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
  /** Stickout from the nut face (mm); with `holder` the nut and body are checked (DF132). */
  readonly stickout?: number
  /** The holder the tool sits in (DF132); absent = the WH-F cylinder only. */
  readonly holder?: HolderSizes
  /**
   * The longest stickout the tool gives with its minimum grip in the collet (DF138 F2,
   * `usableStickout`): stickout remedies never go beyond it; absent = not bounded.
   */
  readonly usable?: { readonly max: number; readonly grip: number; readonly overallLength: number }
}

/** One operation of the program, in machining order. */
export interface CheckOperation {
  readonly planOperationId: string
  readonly tool: CheckTool
  /** The final moves in the WCS (drill cycles allowed; they are expanded). */
  readonly moves: readonly Move[]
  /** DF130's minimum stickout (deepest cut + 5 mm), for H3's read-out and messages (DF132). */
  readonly stickoutNeeded?: number
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

/** `holder`: the tool clears the item but the collet nut or the spindle body does not (DF132). */
export type CollisionKind = 'rapid' | 'link' | 'cut' | 'holder'

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
  /** Kind `holder`: the part that hits and its lowest Z there (the tip's is `lowestZ`). */
  readonly part?: 'nut' | 'body'
  readonly partZ?: number
  /**
   * Kind `holder`: the stickout that lifts the nut and body `STICKOUT_CLEARANCE` above the item
   * on every colliding move of the operation (mm, not rounded).
   */
  readonly needed?: number
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

/** A straight piece of a move in XY (an arc's chord carries its sagitta and lowest Z). */
export interface Segment {
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

/** An operation's moves as the check walks them: drill cycles expanded (retract, pecks). */
export function checkMoves(op: CheckOperation): Exclude<Move, { kind: 'drill' }>[] {
  const moves: Exclude<Move, { kind: 'drill' }>[] = []
  for (const m of op.moves)
    if (m.kind === 'drill') {
      moves.push({ kind: 'rapid', to: [m.at[0], m.at[1], m.retract] })
      moves.push(...expandDrill(m, PECK_CLEARANCE))
    } else moves.push(m)
  return moves
}

/** A move from `start` as XY segments: a line as itself, an arc as chords at its lowest Z. */
export function moveSegments(start: Vec3, m: Exclude<Move, { kind: 'drill' }>): Segment[] {
  return m.kind === 'arc' ? arcSegments(start, m) : [{ a: start, b: m.to, slack: 0 }]
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
  // DF132: the first holder collision per operation and item, by its index in `collisions`
  const firstHolder = new Map<string, number>()
  let count = 0
  let minGap: number | null = null
  let pos: Vec3 | undefined
  const eps = 1e-6
  for (const op of input.operations) {
    const envelope = toolEnvelope(op.tool, op.tool.stickout, op.tool.holder)
    const R = envelope[0]!.radius
    const holder = envelope.slice(1)
    const moves = checkMoves(op)
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
      const segs = moveSegments(start, m)
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
        // DF132: the nut and the body, each from its height above the tip (the wider body covers
        // the nut's top, the tool keeps WH-F's cylinder to infinity)
        let held:
          { gap: number; at: Vec3; lowest: number; part: 'nut' | 'body'; zFrom: number } | undefined
        let needed = 0
        if (hit === undefined)
          for (const e of holder) {
            if (e.part === 'tool') continue
            for (const s of segs) {
              const part = below(s, top - e.zFrom)
              if (part === undefined) continue
              const d = segmentDistance(p.footprint, [part.a[0], part.a[1]], [part.b[0], part.b[1]])
              const gap = Math.max(0, d.distance - s.slack - e.radius)
              if (gap >= margin - GAP_TOLERANCE) continue
              const lowest = Math.min(part.a[2], part.b[2])
              // the nut before the body (it is lower), then the smallest gap
              if (held === undefined || (e.part === held.part ? gap < held.gap : e.part === 'nut'))
                held = { gap, at: [d.at[0], d.at[1], lowest], lowest, part: e.part, zFrom: e.zFrom }
              // the stickout that lifts this part STICKOUT_CLEARANCE above the item here
              const above = e.zFrom - (op.tool.stickout ?? 0)
              needed = Math.max(needed, p.zMax - lowest - above + STICKOUT_CLEARANCE)
            }
          }
        if (hit === undefined && held !== undefined) {
          count++
          const key = `c:${op.planOperationId}:${p.itemId}:holder`
          const first = firstHolder.get(key)
          if (first === undefined) {
            const c: Collision = {
              kind: 'holder',
              planOperationId: op.planOperationId,
              itemId: p.itemId,
              moveIndex: index,
              at: held.at,
              lowestZ: held.lowest,
              gap: held.gap,
              part: held.part,
              partZ: held.lowest + held.zFrom,
              needed,
            }
            firstHolder.set(key, collisions.length)
            collisions.push(c)
          } else {
            const c = collisions[first]!
            if (needed > (c.needed ?? 0)) collisions[first] = { ...c, needed }
          }
        } else if (hit !== undefined) {
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
