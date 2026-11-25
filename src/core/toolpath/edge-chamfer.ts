/**
 * Edge chamfer (E1, E2, E4a): a chamfer along a general edge, the top edge of a pocket of any
 * shape or of an inside profile (E1), or of an outside profile (E2), every loop (islands
 * included) or the chosen ones (E4a). The path is the edge moved into the air by the tip radius
 * (the 2D port: the air shrunk, or the part grown), at tip Z = face − width / tan(α / 2), so the
 * cone reaches `width` into the material at the face; one loop each, one `finish` pass. A bevel
 * wider than the tool's cutting edge is cut in levels stepping down and out (E4a,
 * `edgeChamferPasses`); `cornerLift` climbs the V-bit up the mitre of sharp inside corners (E4a).
 * On a split piece (`edge.within`, E2) the loops are clipped to the piece's cell grown by the
 * tool's radius at the face: open runs along the source's real edges only. Circular chamfers
 * keep `generateChamfer` (chamfer.ts).
 * Doc: docs/modes/edge-chamfers.md#toolpath-plan, docs/modes/edge-chamfers.md#implementation-e1,
 * docs/modes/edge-chamfers.md#implementation-e2, docs/modes/edge-chamfers.md#implementation-e4a
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  CHAMFER_ANGLE_TOLERANCE,
  loopChamferDepth,
  type LoopChamferGeometry,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import {
  choosesEveryLoop,
  loopChamferAxis,
  loopChamferEdgeLoops,
  loopChamferLiftCorners,
  nearChosenLoop,
  type LiftCorner,
} from '../geometry/outline'
import { regionLoops } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import type { CutDirection, DrillCuttingParams, GeneratorInput, PassKind, Toolpath } from './model'
import { flat, MoveBuilder, segLength, segPoint, segReverse, segSlice, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'
import { loopRing, ringFrom, ringStart, segClosest } from './region-rings'

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
 * The tool axis loops: the edge moved into the air by `offset` (negative: into the material), in
 * the face frame, each with the air on its left (the climb sense).
 */
export function edgeChamferRings(
  op: EdgeChamferOperation,
  offset: number,
  port: Region2dPort,
): AppResult<Seg[][]> {
  return loopChamferAxis(op, port, offset).map((p) =>
    regionLoops(p).map((l) => loopRing(l, op.edge.side === 'outside')),
  )
}

/** The final ring's loops: the edge moved into the air by the tip radius. */
export const edgeChamferLoops = (
  op: EdgeChamferOperation,
  tipDiameter: number,
  port: Region2dPort,
): AppResult<Seg[][]> => edgeChamferRings(op, tipDiameter / 2, port)

/** One ring of an edge chamfer (E4a): its axis offset into the air and its tip depth. */
export interface EdgeChamferRing {
  /** Offset of the tool axis from the edge into the air (mm); negative = into the material. */
  readonly offset: number
  /** Tip depth below the face (mm). */
  readonly depth: number
  /** The ring whose cone touches the bevel (a `finish` pass; the corner lifts run on it). */
  readonly bevel: boolean
}

/**
 * The rings of an edge chamfer by level (E4a, edge-chamfers.md § Implementation (E4a)): one
 * level of one ring (the E1 ring) when the cutting edge c = (DC − dt) / 2 covers the width; else
 * n levels of tip depth k·h/n, Δ = c/t − cusp apart, each from the edge's ring (dt/2 in the air)
 * out into the material in steps ≤ c to the ring touching the bevel. Empty without a cutting edge.
 */
export function edgeChamferPasses(
  op: { readonly width: number; readonly angle: number },
  tool: { readonly diameter: number; readonly tipDiameter?: number },
): EdgeChamferRing[][] {
  const dt = tool.tipDiameter ?? 0
  const r0 = dt / 2
  const c = (tool.diameter - dt) / 2
  const h = loopChamferDepth(op)
  if (!(c > 0)) return []
  if (op.width <= c + TOOL_FIT_TOLERANCE) return [[{ offset: r0, depth: h, bevel: true }]]
  const t = Math.tan(((op.angle / 2) * Math.PI) / 180)
  const cusp = Math.max(0, c - dt) / (2 * t)
  const step = c / t - cusp
  const n = Math.ceil(h / step - 1e-9)
  const levels: EdgeChamferRing[][] = []
  for (let k = 1; k <= n; k++) {
    const z = (h * k) / n
    // the bevel ring's axis: width − z·t − dt/2 into the material
    const bevel = r0 - (op.width - z * t)
    const m = Math.max(0, Math.ceil((r0 - bevel) / c - 1e-9))
    const rings: EdgeChamferRing[] = []
    for (let j = 0; j <= m; j++)
      rings.push({
        offset: m === 0 ? bevel : r0 - ((r0 - bevel) * j) / m,
        depth: z,
        bevel: j === m,
      })
    levels.push(rings)
  }
  return levels
}

/** A run of the tool axis: a whole loop, or an open stretch of one. */
interface Run {
  readonly segs: Seg[]
  readonly closed: boolean
}

/** A lift at a corner (E4a): from the ring's point along the bisector to `crease`, up to `top`. */
interface Lift {
  readonly crease: Vec2
  readonly top: Vec2
}

type Item = { readonly seg: Seg } | { readonly lift: Lift }

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
    // E4a: any cutting edge does (several levels when it is shorter than the bevel)
    if (!(tool.diameter - tip > 2 * TOOL_FIT_TOLERANCE))
      issues.rule('check', 'tool.diameter', 'slant', 'the tool has no cutting edge', {
        cuttingEdge: Math.max(0, (tool.diameter - tip) / 2),
      })
  }
  const loops = edgeChamferLoops(op, tip, port)
  if (loops.isErr()) return Err(loops.unwrapErr())
  // air narrower than the tip everywhere: nothing of the edge is reached
  if (loops.unwrap().filter((r) => r.length > 0).length === 0)
    issues.rule('check', 'tool.tipDiameter', 'tip', "the tip does not fit the edge's opening", {
      tipDiameter: tip,
    })
  const ok = issues.result('generateEdgeChamfer', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  const levels = edgeChamferPasses(op, { diameter: tool.diameter, tipDiameter: tip })
  const edges = loopChamferEdgeLoops(op)
  const every = choosesEveryLoop(op)
  const corners = op.cornerLift === true ? loopChamferLiftCorners(op) : []
  const w = op.edge.within
  // on a split piece: the stretches within the cell grown by the tool's radius at the face
  const reach = tip / 2 + op.width
  const box: [Vec2, Vec2] | undefined =
    w === undefined
      ? undefined
      : [
          [w.min[0] - reach, w.min[1] - reach],
          [w.max[0] + reach, w.max[1] + reach],
        ]
  const keep = every ? undefined : (p: Vec2) => nearChosenLoop(edges, p)

  const retract = op.onZ + heights.retractHeight
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const b = new MoveBuilder()
  let kind: PassKind | undefined
  let here: Vec2 = [0, 0]
  // per level the rings from the edge out to the bevel; each ring's loops nearest-neighbour
  const groups: { items: Item[]; kind: PassKind; z: number }[][] = []
  for (const ring of levels.flat()) {
    const rings = ring.offset === tip / 2 ? loops : edgeChamferRings(op, ring.offset, port)
    if (rings.isErr()) return Err(rings.unwrapErr())
    const z = op.onZ - ring.depth
    const lifts = ring.bevel ? corners.map((c) => liftAt(c, ring, op.width, tip / 2)) : []
    const group: { items: Item[]; kind: PassKind; z: number }[] = []
    for (const r of rings.unwrap().filter((x) => x.length > 0))
      for (const run of runsOf(r, box, keep)) {
        const segs = st.direction === 'climb' ? run.segs : [...run.segs].reverse().map(segReverse)
        group.push({
          items: withLifts(run.closed ? startAtLongest(segs) : segs, lifts),
          kind: ring.bevel ? 'finish' : 'rough',
          z,
        })
      }
    groups.push(group)
  }
  const total = groups.reduce((s, g) => s + g.length, 0)
  const single = levels.length === 1 && levels[0]!.length === 1
  let done = 0
  for (const left of groups) {
    while (left.length > 0) {
      const step = steps.step({ done, total, label: `loop ${done + 1}/${total}` })
      if (step.isErr()) return Err(step.unwrapErr())
      // loops in nearest-neighbour order of their start points
      let best = 0
      left.forEach((r, i) => {
        if (dist(itemsStart(r.items), here) < dist(itemsStart(left[best]!.items), here) - 1e-12)
          best = i
      })
      const ring = left.splice(best, 1)[0]!
      // one `finish` pass for the one-ring chamfer (E1); rough and finish rings by kind (E4a)
      const k = single ? 'finish' : ring.kind
      if (k !== kind) b.pass((kind = k))
      const start = itemsStart(ring.items)
      // down in the air beside the edge (the edge's operation cut it), one loop, out
      b.rapid(at(start, heights.clearanceHeight))
      b.rapid(at(start, retract))
      b.line(at(start, ring.z), cutting.plungeRate)
      let p = start
      for (const it of ring.items) {
        if ('seg' in it) {
          for (const s of flat([it.seg], ring.z)) b.seg(s, cutting.feedRate)
          p = segPoint(it.seg, 1)
          continue
        }
        // the corner lift: along the bisector to the crease, up it to the face, back
        b.line(at(it.lift.crease, ring.z), cutting.feedRate)
        b.line(at(it.lift.top, op.onZ), cutting.feedRate)
        b.line(at(it.lift.crease, ring.z), cutting.feedRate)
        b.line(at(p, ring.z), cutting.feedRate)
      }
      b.rapid(at(start, heights.clearanceHeight))
      here = start
      done++
    }
  }
  return Ok(toolpath(input, b.build()))
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const along = (p: Vec2, d: Vec2, k: number): Vec2 => [p[0] + d[0] * k, p[1] + d[1] * k]

/** The first point of a ring's items (a lift never comes first). */
function itemsStart(items: readonly Item[]): Vec2 {
  for (const it of items) if ('seg' in it) return ringStart([it.seg])
  return [0, 0]
}

/**
 * Where a ring meets a lift corner and where the lift goes (E4a): the ring passes the bisector
 * at the sharp vertex offset/sinHalf on the air side (offset ≥ 0) or at its corner arc's middle
 * |offset| into the material; the crease at the ring's depth is (w − dt/2 − z·t) / sinHalf along
 * it, the face (w − dt/2) / sinHalf.
 */
function liftAt(
  c: LiftCorner,
  ring: EdgeChamferRing,
  width: number,
  r0: number,
): { readonly on: Vec2; readonly lift: Lift } {
  const on =
    ring.offset >= 0
      ? along(c.v, c.bisector, -ring.offset / c.sinHalf)
      : along(c.v, c.bisector, -ring.offset)
  // the bevel ring's axis is width − z·t − dt/2 into the material: z·t from its offset
  const zt = width - r0 + ring.offset
  return {
    on,
    lift: {
      crease: along(c.v, c.bisector, (width - r0 - zt) / c.sinHalf),
      top: along(c.v, c.bisector, (width - r0) / c.sinHalf),
    },
  }
}

/** Distance within which a lift corner's point is on a ring (mm). */
const ON_RING = 1e-5

/** The ring's segments with each lift inserted where the ring passes its corner (E4a). */
function withLifts(
  segs: readonly Seg[],
  lifts: readonly { readonly on: Vec2; readonly lift: Lift }[],
): Item[] {
  let items: Item[] = segs.map((seg) => ({ seg }))
  for (const l of lifts) {
    const i = items.findIndex(
      (it) => 'seg' in it && dist(segPoint(it.seg, segClosest(it.seg, l.on)), l.on) < ON_RING,
    )
    if (i < 0) continue
    const s = (items[i] as { seg: Seg }).seg
    const u = segClosest(s, l.on)
    const parts: Item[] =
      u * segLength(s) < ON_RING
        ? i === 0
          ? // at the ring's start: lifted at its end, where the tool comes back
            [{ seg: s }]
          : [{ lift: l.lift }, { seg: s }]
        : (1 - u) * segLength(s) < ON_RING
          ? [{ seg: s }, { lift: l.lift }]
          : [{ seg: segSlice(s, 0, u) }, { lift: l.lift }, { seg: segSlice(s, u, 1) }]
    items = [...items.slice(0, i), ...parts, ...items.slice(i + 1)]
    if (i === 0 && u * segLength(s) < ON_RING) items.push({ lift: l.lift })
  }
  return items
}

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
  return runsOf(ring, [lo, hi])
}

/**
 * The stretches of `ring` to cut: within `box` (a split piece, E2) and beside a chosen loop
 * (`keep`, E4a), in ring order; the whole ring when nothing is dropped.
 */
function runsOf(ring: readonly Seg[], box?: [Vec2, Vec2], keep?: (p: Vec2) => boolean): Run[] {
  if (box === undefined && keep === undefined) return [{ segs: [...ring], closed: true }]
  const inside = (p: Vec2) =>
    box === undefined ||
    (p[0] >= box[0][0] - 1e-9 &&
      p[0] <= box[1][0] + 1e-9 &&
      p[1] >= box[0][1] - 1e-9 &&
      p[1] <= box[1][1] + 1e-9)
  const pieces: { seg: Seg; keep: boolean }[] = []
  for (const s of ring) {
    const us =
      box === undefined
        ? [0, 1]
        : [
            0,
            ...crossings(s, 0, box[0][0]),
            ...crossings(s, 0, box[1][0]),
            ...crossings(s, 1, box[0][1]),
            ...crossings(s, 1, box[1][1]),
            1,
          ].sort((a, b) => a - b)
    for (let i = 0; i + 1 < us.length; i++) {
      if (us[i + 1]! - us[i]! < 1e-9) continue
      const piece = us.length === 2 ? s : segSlice(s, us[i]!, us[i + 1]!)
      const mid = segPoint(piece, 0.5)
      pieces.push({ seg: piece, keep: inside(mid) && (keep === undefined || keep(mid)) })
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
