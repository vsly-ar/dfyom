/**
 * The ring tree of offset clearing for regions (task T1) and the planar helpers its traversal
 * needs: 2D-model loops as toolpath `Seg`s (exact arcs, degenerate arcs as lines), closest points
 * and restarting a ring there, the straight-link test, and a region's deepest point.
 * Doc: docs/modes/plan-v0.3.md#pocket-offset-clearing-of-a-region (spike: spikes/clearing/)
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import type { Vec2 } from '../geometry/model'
import {
  arcRadius,
  arcSweep,
  regionLoops,
  type Element,
  type Loop,
  type Region,
  type RegionPiece,
} from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { segLength, segPoint, segReverse, segSlice, type Seg } from './path'

/** Arcs sweeping less than this become lines (plan-v0.3.md § Arcs in, G2/G3 out). */
export const MIN_ARC_SWEEP = 1e-4
/** Arcs of a smaller radius become lines (mm): the offset of a corner arc just above zero. */
export const MIN_ARC_RADIUS = 0.005
/** Pieces shorter than this are dropped from rings (mm). */
const MIN_SEG_LENGTH = 1e-9

/** One element as a `Seg`: exact arcs, degenerate arcs as lines; undefined if zero length. */
export function elementSeg(e: Element): Seg | undefined {
  if (e.kind === 'arc') {
    const radius = arcRadius(e)
    const sweep = arcSweep(e)
    if (Math.abs(sweep) >= MIN_ARC_SWEEP && radius >= MIN_ARC_RADIUS)
      return {
        kind: 'arc',
        center: e.centre,
        radius,
        start: Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0]),
        sweep,
      }
  }
  const s: Seg = { kind: 'line', from: e.a, to: e.b }
  return segLength(s) > MIN_SEG_LENGTH ? s : undefined
}

/** A closed loop as a ring of `Seg`s in its own direction, or reversed. */
export function loopRing(l: Loop, reverse = false): Seg[] {
  const out: Seg[] = []
  for (const e of l.elements) {
    const s = elementSeg(e)
    if (s !== undefined) out.push(s)
  }
  return reverse ? out.reverse().map(segReverse) : out
}

const TAU = 2 * Math.PI

/** Fraction (0..1) of the point of `s` closest to `p`. */
export function segClosest(s: Seg, p: Vec2): number {
  if (s.kind === 'line') {
    const dx = s.to[0] - s.from[0]
    const dy = s.to[1] - s.from[1]
    const len2 = dx * dx + dy * dy
    if (len2 === 0) return 0
    return Math.max(0, Math.min(1, ((p[0] - s.from[0]) * dx + (p[1] - s.from[1]) * dy) / len2))
  }
  const ang = Math.atan2(p[1] - s.center[1], p[0] - s.center[0])
  const rel =
    s.sweep >= 0 ? (((ang - s.start) % TAU) + TAU) % TAU : -((((s.start - ang) % TAU) + TAU) % TAU)
  const u = rel / s.sweep
  if (u <= 1) return u
  const a = segPoint(s, 0)
  const b = segPoint(s, 1)
  return Math.hypot(p[0] - a[0], p[1] - a[1]) <= Math.hypot(p[0] - b[0], p[1] - b[1]) ? 0 : 1
}

export interface RingPoint {
  readonly index: number
  readonly u: number
  readonly point: Vec2
  readonly distance: number
}

/** Closest point of a ring to `p`; undefined for an empty ring. */
export function ringClosest(ring: readonly Seg[], p: Vec2): RingPoint | undefined {
  let best: RingPoint | undefined
  ring.forEach((s, index) => {
    const u = segClosest(s, p)
    const point = segPoint(s, u)
    const distance = Math.hypot(point[0] - p[0], point[1] - p[1])
    if (best === undefined || distance < best.distance) best = { index, u, point, distance }
  })
  return best
}

/** The same closed ring, starting at fraction `u` of piece `index` (that piece is split). */
export function ringFrom(ring: readonly Seg[], index: number, u: number): Seg[] {
  const s = ring[index]!
  const head = segSlice(s, u, 1)
  const tail = segSlice(s, 0, u)
  const out = [head, ...ring.slice(index + 1), ...ring.slice(0, index), tail]
  return out.filter((x) => segLength(x) > MIN_SEG_LENGTH)
}

/** Start of a ring (the end of its last piece is the same point). */
export const ringStart = (ring: readonly Seg[]): Vec2 => segPoint(ring[0]!, 0)

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx

/** Angle `ang` on the arc of `s` (within `eps` rad). */
function onArc(s: Extract<Seg, { kind: 'arc' }>, ang: number, eps: number): boolean {
  const rel =
    s.sweep >= 0 ? (((ang - s.start) % TAU) + TAU) % TAU : (((s.start - ang) % TAU) + TAU) % TAU
  const sw = Math.abs(s.sweep)
  return rel <= sw + eps || rel >= TAU - eps
}

/**
 * Parameters t ∈ (0, 1) along the segment `p`–`q` where it meets the piece `s`: crossings and
 * touches, and both ends of a collinear overlap.
 */
export function segmentHits(p: Vec2, q: Vec2, s: Seg): number[] {
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return []
  const out: number[] = []
  const push = (t: number) => {
    if (t > 0 && t < 1) out.push(t)
  }
  if (s.kind === 'line') {
    const ex = s.to[0] - s.from[0]
    const ey = s.to[1] - s.from[1]
    const elen = Math.hypot(ex, ey)
    const den = cross(dx, dy, ex, ey)
    const wx = s.from[0] - p[0]
    const wy = s.from[1] - p[1]
    if (Math.abs(den) <= 1e-12 * len * elen) {
      // parallel: only a collinear overlap meets; its ends split the segment
      if (Math.abs(cross(dx, dy, wx, wy)) / len > 1e-9) return out
      push((wx * dx + wy * dy) / (len * len))
      push(((s.to[0] - p[0]) * dx + (s.to[1] - p[1]) * dy) / (len * len))
      return out
    }
    const t = cross(wx, wy, ex, ey) / den
    const u = cross(wx, wy, dx, dy) / den
    const ue = 1e-9 / elen
    if (u >= -ue && u <= 1 + ue) push(t)
    return out
  }
  const fx = p[0] - s.center[0]
  const fy = p[1] - s.center[1]
  const a = len * len
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - s.radius * s.radius
  const disc = b * b - 4 * a * c
  if (disc < -1e-12 * a * s.radius * s.radius) return out
  const sq = Math.sqrt(Math.max(0, disc))
  const eps = 1e-9 / s.radius
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    const x = p[0] + dx * t - s.center[0]
    const y = p[1] + dy * t - s.center[1]
    if (onArc(s, Math.atan2(y, x), eps)) push(t)
  }
  return out
}

/**
 * Whether the straight segment `p`–`q` stays inside the region bounded by `rings` (its boundary
 * included): between consecutive hits of the boundary the segment is wholly inside or outside,
 * so each such stretch's midpoint decides. Running along a ring just cut is inside.
 */
export function linkInside(
  port: Region2dPort,
  region: Region,
  rings: readonly (readonly Seg[])[],
  p: Vec2,
  q: Vec2,
): boolean {
  const ts = [0, 1]
  for (const ring of rings) for (const s of ring) ts.push(...segmentHits(p, q, s))
  ts.sort((x, y) => x - y)
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1]!
    const t1 = ts[i]!
    if (t1 - t0 < 1e-9) continue
    const t = (t0 + t1) / 2
    if (!port.contains(region, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])) return false
  }
  return true
}

/** Distance from `p` to a region (0 inside). */
export function regionDistance(port: Region2dPort, region: Region, p: Vec2): number {
  if (port.contains(region, p)) return 0
  return port.distance(regionLoops(region), p)?.distance ?? Infinity
}

// ---------------------------------------------------------------- ring tree

/**
 * One node of the ring tree: a connected component of an inward offset (an outer ring and its
 * island rings). Its children are the components of its own offset by the step.
 */
export interface RingNode {
  readonly piece: RegionPiece
  readonly region: Region
  /** Offset of its rings from the region boundary (mm). */
  readonly offset: number
  readonly children: readonly RingNode[]
}

/**
 * The ring tree: one root per piece of `roots` (the tool-centre region of the roughing), each
 * node's children the pieces of its own offset by `step`, until empty. `step()` per node.
 */
export function ringTree(
  port: Region2dPort,
  roots: Region,
  rootOffset: number,
  step: number,
  steps: Steps = noSteps,
): AppResult<RingNode[]> {
  interface Draft {
    piece: RegionPiece
    offset: number
    children: Draft[]
  }
  const top: Draft[] = roots.pieces.map((piece) => ({ piece, offset: rootOffset, children: [] }))
  const todo = [...top]
  while (todo.length > 0) {
    const s = steps.step()
    if (s.isErr()) return Err(s.unwrapErr())
    const d = todo.pop()!
    const off = port.offset({ pieces: [d.piece] }, step)
    if (off.isErr()) return Err(off.unwrapErr())
    for (const piece of off.unwrap().pieces) {
      const child: Draft = { piece, offset: d.offset + step, children: [] }
      d.children.push(child)
      todo.push(child)
    }
  }
  const freeze = (d: Draft): RingNode => ({
    piece: d.piece,
    region: { pieces: [d.piece] },
    offset: d.offset,
    children: d.children.map(freeze),
  })
  return Ok(top.map(freeze))
}

export function* walkTree(nodes: readonly RingNode[]): Generator<RingNode> {
  for (const n of nodes) {
    yield n
    yield* walkTree(n.children)
  }
}

/**
 * Centre of (about) the largest circle inside `region`, whose offset by `upper` is empty: the
 * offset is bisected to 1e-4 mm and the last non-empty one's centre taken. `radius` is the offset
 * reached, a lower bound of the distance from `point` to the region's boundary.
 */
export function deepestPoint(
  port: Region2dPort,
  region: Region,
  upper: number,
): AppResult<{ point: Vec2; radius: number }> {
  let lo = 0
  let hi = upper
  let last = region
  while (hi - lo > 1e-4) {
    const mid = (lo + hi) / 2
    const r = port.offset(region, mid)
    // An offset just before the region collapses can come back invalid from the 2D library
    // (T3: "an offset hole lies in no outer loop" on a turned gear); bisect on as if empty, so
    // `radius` stays a lower bound and the entry only gets more careful.
    if (r.isErr()) {
      hi = mid
      continue
    }
    const got = r.unwrap()
    if (got.pieces.length > 0) {
      lo = mid
      last = got
    } else hi = mid
  }
  const outer = last.pieces[0]!.outer
  let sx = 0
  let sy = 0
  for (const e of outer.elements) {
    sx += e.a[0]
    sy += e.a[1]
  }
  const n = outer.elements.length
  let point: Vec2 = [sx / n, sy / n]
  if (!port.contains(last, point)) {
    // not convex enough for the vertex mean: a point on its boundary
    const s = elementSeg(outer.elements[0]!)
    point = s === undefined ? outer.elements[0]!.a : segPoint(s, 0.5)
  }
  return Ok({ point, radius: lo })
}
