/**
 * Edge chamfer (E1, E2): a chamfer along a general edge, the top edge of a pocket of any shape or
 * of an inside profile (E1), or of an outside profile (E2), every loop (islands included). The
 * path is the edge moved into the air by the tip radius (the 2D port: the air shrunk, or the part
 * grown), at tip Z = face − width / tan(α / 2), so the cone reaches `width` into the material at
 * the face; one loop each, one `finish` pass. On a split piece (`edge.within`, E2) the loops are
 * clipped to the piece's cell grown by the tool's radius at the face: open runs along the
 * source's real edges only. Circular chamfers keep `generateChamfer` (chamfer.ts).
 * Doc: docs/modes/edge-chamfers.md#toolpath-plan, docs/modes/edge-chamfers.md#implementation-e1,
 * docs/modes/edge-chamfers.md#implementation-e2
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  CHAMFER_ANGLE_TOLERANCE,
  coneSlant,
  loopChamferDepth,
  type LoopChamferGeometry,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { loopChamferAxis } from '../geometry/outline'
import { regionLoops } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import type { CutDirection, DrillCuttingParams, GeneratorInput, Toolpath } from './model'
import { flat, MoveBuilder, segLength, segPoint, segReverse, segSlice, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'
import { loopRing, ringFrom, ringStart } from './region-rings'

/** A loop chamfer as the generator reads it: its geometry input without the face direction. */
export type EdgeChamferOperation = Omit<LoopChamferGeometry, 'direction'>

/**
 * Climb runs each loop with the air on its left (counter-clockwise in a pocket, clockwise round
 * an outside edge); one ring.
 */
export interface EdgeChamferStrategy {
  readonly direction: CutDirection
}

export type EdgeChamferInput = GeneratorInput<
  EdgeChamferOperation,
  EdgeChamferStrategy,
  DrillCuttingParams
>

/** The tip Z of an edge chamfer: the bevel's depth below its face. */
export const edgeChamferTipZ = (op: EdgeChamferOperation): number => op.onZ - loopChamferDepth(op)

/**
 * The tool axis loops: the edge moved into the air by the tip radius, in the face frame, each with
 * the air on its left (the climb sense).
 */
export function edgeChamferLoops(
  op: EdgeChamferOperation,
  tipDiameter: number,
  port: Region2dPort,
): AppResult<Seg[][]> {
  return loopChamferAxis(op, port, tipDiameter / 2).map((p) =>
    regionLoops(p).map((l) => loopRing(l, op.edge.side === 'outside')),
  )
}

/** A run of the tool axis: a whole loop, or an open stretch of one clipped to a piece's cell. */
interface Run {
  readonly segs: Seg[]
  readonly closed: boolean
}

export function generateEdgeChamfer(
  input: EdgeChamferInput,
  port: Region2dPort,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const issues = commonIssues(input)
  issues.positive('operation.width', op.width)
  if (!(op.angle > 0 && op.angle < 180))
    issues.rule('invariant', 'operation.angle', 'range', 'angle must be in (0°, 180°)', {
      angle: op.angle,
    })
  const tip = tool.tipDiameter ?? 0
  if (tool.type !== 'chamferMill' || tool.angle === undefined)
    issues.rule('check', 'tool.type', 'toolType', 'a chamfer needs a chamfer mill')
  else {
    if (Math.abs(tool.angle - op.angle) > CHAMFER_ANGLE_TOLERANCE)
      issues.rule('check', 'tool.angle', 'angle', 'the tool angle differs from the chamfer angle', {
        angle: tool.angle,
        chamfer: op.angle,
      })
    // one ring: the cutting edge covers the bevel, (DC − dt) / 2 ≥ width (rule `slant`)
    const edge = coneSlant(tip, tool.diameter, tool.angle)
    const slant = coneSlant(0, 2 * op.width, op.angle)
    if (edge + TOOL_FIT_TOLERANCE < slant)
      issues.rule('check', 'tool.diameter', 'slant', 'the cutting edge is shorter than the slant', {
        cuttingEdge: edge,
        slant,
      })
  }
  const loops = edgeChamferLoops(op, tip, port)
  if (loops.isErr()) return Err(loops.unwrapErr())
  const rings = loops.unwrap().filter((r) => r.length > 0)
  const w = op.edge.within
  // on a split piece: the stretches within the cell grown by the tool's radius at the face
  const reach = tip / 2 + op.width
  const runs: Run[] =
    w === undefined
      ? rings.map((segs) => ({ segs, closed: true }))
      : rings.flatMap((r) =>
          clipRing(r, [w.min[0] - reach, w.min[1] - reach], [w.max[0] + reach, w.max[1] + reach]),
        )
  // air narrower than the tip everywhere: nothing of the edge is reached
  if (rings.length === 0)
    issues.rule('check', 'tool.tipDiameter', 'tip', "the tip does not fit the edge's opening", {
      tipDiameter: tip,
    })
  const ok = issues.result('generateEdgeChamfer', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  const tipZ = edgeChamferTipZ(op)
  const retract = op.onZ + heights.retractHeight
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const b = new MoveBuilder()
  b.pass('finish')
  let here: Vec2 = [0, 0]
  const left = runs.map((r) => {
    const segs = st.direction === 'climb' ? r.segs : [...r.segs].reverse().map(segReverse)
    return r.closed ? startAtLongest(segs) : segs
  })
  for (let k = 0; left.length > 0; k++) {
    const step = steps.step({
      done: k,
      total: runs.length,
      label: `loop ${k + 1}/${runs.length}`,
    })
    if (step.isErr()) return Err(step.unwrapErr())
    // loops in nearest-neighbour order of their start points
    let best = 0
    left.forEach((r, i) => {
      if (dist(ringStart(r), here) < dist(ringStart(left[best]!), here) - 1e-12) best = i
    })
    const ring = left.splice(best, 1)[0]!
    const start = ringStart(ring)
    // down in the air beside the edge (the edge's operation cut it), one loop, out
    b.rapid(at(start, heights.clearanceHeight))
    b.rapid(at(start, retract))
    b.line(at(start, tipZ), cutting.plungeRate)
    for (const s of flat(ring, tipZ)) b.seg(s, cutting.feedRate)
    b.rapid(at(start, heights.clearanceHeight))
    here = start
  }
  return Ok(toolpath(input, b.build()))
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

const TAU = 2 * Math.PI

/** Fractions u ∈ (0, 1) where `s` crosses the vertical (axis 0) or horizontal (axis 1) line at c. */
function crossings(s: Seg, axis: 0 | 1, c: number): number[] {
  if (s.kind === 'line') {
    const d = s.to[axis] - s.from[axis]
    if (Math.abs(d) < 1e-12) return []
    const u = (c - s.from[axis]) / d
    return u > 0 && u < 1 ? [u] : []
  }
  const k = (c - s.center[axis]) / s.radius
  if (Math.abs(k) > 1) return []
  const base = axis === 0 ? Math.acos(k) : Math.asin(k)
  const angles = axis === 0 ? [base, -base] : [base, Math.PI - base]
  const out: number[] = []
  for (const a of angles) {
    const rel =
      s.sweep >= 0 ? (((a - s.start) % TAU) + TAU) % TAU : (((s.start - a) % TAU) + TAU) % TAU
    const u = rel / Math.abs(s.sweep)
    if (u > 0 && u < 1) out.push(u)
  }
  return out
}

/**
 * The stretches of `ring` inside the box [lo, hi] (E2, a split piece's cell grown by the tool's
 * reach), in ring order: the whole ring when it lies inside, else open runs from where it enters
 * the box to where it leaves.
 */
export function clipRing(ring: readonly Seg[], lo: Vec2, hi: Vec2): Run[] {
  const inside = (p: Vec2) =>
    p[0] >= lo[0] - 1e-9 && p[0] <= hi[0] + 1e-9 && p[1] >= lo[1] - 1e-9 && p[1] <= hi[1] + 1e-9
  const pieces: { seg: Seg; keep: boolean }[] = []
  for (const s of ring) {
    const us = [
      0,
      ...crossings(s, 0, lo[0]),
      ...crossings(s, 0, hi[0]),
      ...crossings(s, 1, lo[1]),
      ...crossings(s, 1, hi[1]),
      1,
    ].sort((a, b) => a - b)
    for (let i = 0; i + 1 < us.length; i++) {
      if (us[i + 1]! - us[i]! < 1e-9) continue
      const piece = segSlice(s, us[i]!, us[i + 1]!)
      pieces.push({ seg: piece, keep: inside(segPoint(piece, 0.5)) })
    }
  }
  if (pieces.every((p) => p.keep)) return [{ segs: [...ring], closed: true }]
  // start after a dropped piece, so no run wraps round the ring's start
  const first = pieces.findIndex((p) => !p.keep)
  const ordered = [...pieces.slice(first), ...pieces.slice(0, first)]
  const runs: Run[] = []
  let cur: Seg[] = []
  for (const p of ordered) {
    if (p.keep) cur.push(p.seg)
    else if (cur.length > 0) {
      runs.push({ segs: cur, closed: false })
      cur = []
    }
  }
  if (cur.length > 0) runs.push({ segs: cur, closed: false })
  return runs
}

/**
 * The ring from the middle of its longest line, else its longest arc (the pocket finishing
 * pass's rule, plan-v0.3.md § Implementation (T1)): the plunge stays off the corners.
 */
function startAtLongest(ring: readonly Seg[]): Seg[] {
  let li = 0
  ring.forEach((s, i) => {
    const better =
      (s.kind === 'line') !== (ring[li]!.kind === 'line')
        ? s.kind === 'line'
        : segLength(s) > segLength(ring[li]!) + 1e-9
    if (better) li = i
  })
  return ringFrom(ring, li, 0.5)
}
