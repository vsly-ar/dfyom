/**
 * Exact self-crossing test of a closed chain of lines and arcs (no flattening, no library):
 * resolveShape refuses a closed path that crosses itself (`shapeSelfIntersects`) before the
 * 2D port sees it, because the port does not repair self-crossing loops.
 * Doc: docs/architecture/shapes.md#validity, docs/architecture/shapes.md#implementation-k2
 *
 * A **crossing** is a point where the chain passes from one side of itself to the other:
 * transversal intersections inside two elements, a vertex lying on another part of the chain
 * whose neighbours leave on opposite sides, or a stretch traced twice (overlap). Touching
 * (tangency, a vertex touching from one side) is not a crossing: normalise splits such loops.
 */
import type { Vec2 } from '../model'
import { elementPointAt } from './measure'
import {
  arcRadius,
  arcSweep,
  chainBounds,
  POSITION_EPSILON,
  type ArcElement,
  type Bounds2,
  type Element,
} from './model'

/** Where a chain crosses itself: two element indices and the point. */
export interface Crossing {
  readonly a: number
  readonly b: number
  readonly at: Vec2
}

const EPS = POSITION_EPSILON
const TAU = 2 * Math.PI

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** An intersection point with the parameters (0..1) on both elements. */
interface Hit {
  readonly p: Vec2
  readonly s: number
  readonly t: number
}

/** Parameter of a point on an arc's circle (0 at `a`, 1 at `b`), undefined when off the arc. */
function arcParam(e: ArcElement, p: Vec2): number | undefined {
  if (dist(p, e.a) <= EPS) return 0
  if (dist(p, e.b) <= EPS) return 1
  const sweep = arcSweep(e)
  const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const ang = Math.atan2(p[1] - e.centre[1], p[0] - e.centre[0])
  const delta =
    sweep >= 0 ? (((ang - start) % TAU) + TAU) % TAU : (((start - ang) % TAU) + TAU) % TAU
  return delta <= Math.abs(sweep) ? delta / Math.abs(sweep) : undefined
}

/** Parameter of a point on a line (clamped near the ends), undefined when off the segment. */
function lineParam(a: Vec2, b: Vec2, p: Vec2): number | undefined {
  if (dist(p, a) <= EPS) return 0
  if (dist(p, b) <= EPS) return 1
  const d = sub(b, a)
  const len2 = dot(d, d)
  const t = dot(sub(p, a), d) / len2
  const tol = EPS / Math.sqrt(len2)
  return t >= -tol && t <= 1 + tol ? Math.min(1, Math.max(0, t)) : undefined
}

/** Points where a line's carrier meets a circle. */
function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d = sub(b, a)
  const f = sub(a, c)
  const A = dot(d, d)
  const B = 2 * dot(f, d)
  const C = dot(f, f) - r * r
  let disc = B * B - 4 * A * C
  // tangent within the position epsilon: one touching point
  const len = Math.sqrt(A)
  const foot = -B / (2 * A)
  const footPoint: Vec2 = [a[0] + d[0] * foot, a[1] + d[1] * foot]
  if (disc < 0) return Math.abs(dist(footPoint, c) - r) <= EPS ? [footPoint] : []
  disc = Math.sqrt(disc)
  const u1 = (-B - disc) / (2 * A)
  const u2 = (-B + disc) / (2 * A)
  if (Math.abs(u2 - u1) * len <= EPS) return [footPoint]
  return [
    [a[0] + d[0] * u1, a[1] + d[1] * u1],
    [a[0] + d[0] * u2, a[1] + d[1] * u2],
  ]
}

/** Points where two circles meet; undefined when they coincide. */
function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] | undefined {
  const d = dist(c1, c2)
  if (d <= EPS) return Math.abs(r1 - r2) <= EPS ? undefined : []
  if (d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  const ex: Vec2 = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d]
  const m: Vec2 = [c1[0] + ex[0] * a, c1[1] + ex[1] * a]
  if (h2 <= (EPS * EPS) / 4) return [m] // tangent
  const h = Math.sqrt(h2)
  return [
    [m[0] - ex[1] * h, m[1] + ex[0] * h],
    [m[0] + ex[1] * h, m[1] - ex[0] * h],
  ]
}

/** Intersections of two elements, or 'overlap' when they share a stretch longer than ε. */
function intersect(e: Element, f: Element): Hit[] | 'overlap' {
  const hits: Hit[] = []
  const add = (p: Vec2) => {
    const s = e.kind === 'line' ? lineParam(e.a, e.b, p) : arcParam(e, p)
    const t = f.kind === 'line' ? lineParam(f.a, f.b, p) : arcParam(f, p)
    if (s !== undefined && t !== undefined) hits.push({ p, s, t })
  }
  if (e.kind === 'line' && f.kind === 'line') {
    const d1 = sub(e.b, e.a)
    const d2 = sub(f.b, f.a)
    const den = cross(d1, d2)
    const l1 = Math.hypot(d1[0], d1[1])
    const l2 = Math.hypot(d2[0], d2[1])
    if (Math.abs(den) <= 1e-12 * l1 * l2) {
      if (Math.abs(cross(sub(f.a, e.a), d1)) / l1 > EPS) return []
      // collinear: overlap when the parameter intervals share more than ε
      const t0 = dot(sub(f.a, e.a), d1) / (l1 * l1)
      const t1 = dot(sub(f.b, e.a), d1) / (l1 * l1)
      const lo = Math.max(0, Math.min(t0, t1))
      const hi = Math.min(1, Math.max(t0, t1))
      if ((hi - lo) * l1 > EPS) return 'overlap'
      if (hi >= lo - EPS / l1) add([e.a[0] + d1[0] * lo, e.a[1] + d1[1] * lo])
      return hits
    }
    const s = cross(sub(f.a, e.a), d2) / den
    add([e.a[0] + d1[0] * s, e.a[1] + d1[1] * s])
    return hits
  }
  if (e.kind === 'line' || f.kind === 'line') {
    const l = (e.kind === 'line' ? e : f) as Element
    const c = (e.kind === 'arc' ? e : f) as ArcElement
    for (const p of lineCircle(l.a, l.b, c.centre, arcRadius(c))) add(p)
    return hits
  }
  const pts = circleCircle(e.centre, arcRadius(e), f.centre, arcRadius(f))
  if (pts === undefined) {
    // one circle: overlap when the arcs share a stretch, else touching ends only
    const probe = (x: ArcElement, y: ArcElement) =>
      [0.25, 0.5, 0.75].some((k) => arcParam(y, elementPointAt(x, k).point) !== undefined)
    if (probe(e, f) || probe(f, e)) return 'overlap'
    for (const p of [f.a, f.b]) add(p)
    return hits
  }
  for (const p of pts) add(p)
  return hits
}

/** Unit tangent leaving an element's start, and arriving at its end. */
const startTangent = (e: Element): Vec2 => elementPointAt(e, 0).tangent
const endTangent = (e: Element): Vec2 => elementPointAt(e, 1).tangent

/** Whether direction `x` lies strictly inside the counter-clockwise turn from `from` to `to`. */
function between(x: Vec2, from: Vec2, to: Vec2): boolean {
  const ang = (v: Vec2) => {
    const a = Math.atan2(cross(from, v), dot(from, v))
    return a < 0 ? a + TAU : a
  }
  return ang(x) < ang(to)
}

const ANGLE_EPS = 1e-9
const sameDir = (a: Vec2, b: Vec2): boolean =>
  Math.abs(Math.atan2(cross(a, b), dot(a, b))) <= ANGLE_EPS

/**
 * Whether the pair of directions (p1, p2) separates (q1, q2) around a common point: one of q
 * on each side. Coinciding directions (a shared stretch, a tangency) do not separate.
 */
function separates(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  for (const p of [p1, p2]) for (const q of [q1, q2]) if (sameDir(p, q)) return false
  return between(q1, p1, p2) !== between(q2, p1, p2)
}

/**
 * The first crossing of a closed chain with itself (docs above), or undefined. Elements must
 * chain (end of one = start of the next, the last ends at the first's start).
 */
export function closedChainCrossing(elements: readonly Element[]): Crossing | undefined {
  const n = elements.length
  if (n < 2) return undefined
  const boxes: Bounds2[] = elements.map((e) => chainBounds([e])!)
  const order = [...elements.keys()].sort((i, j) => boxes[i]!.min[0] - boxes[j]!.min[0])
  /** The directions leaving a point at parameter `t` of element `k` (two, as a pair). */
  const around = (k: number, t: number): [Vec2, Vec2] => {
    const e = elements[k]!
    if (t <= 0) {
      const prev = elements[(k - 1 + n) % n]!
      const d = endTangent(prev)
      return [[-d[0], -d[1]], startTangent(e)]
    }
    if (t >= 1) {
      const next = elements[(k + 1) % n]!
      const d = endTangent(e)
      return [[-d[0], -d[1]], startTangent(next)]
    }
    const tan = elementPointAt(e, t).tangent
    return [[-tan[0], -tan[1]], tan]
  }
  /** Vertex index of an element end parameter (0 = its start, 1 = its end), else undefined. */
  const vertex = (k: number, t: number): number | undefined =>
    t <= 0 ? k : t >= 1 ? (k + 1) % n : undefined
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi]!
    const bi = boxes[i]!
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj]!
      const bj = boxes[j]!
      if (bj.min[0] > bi.max[0] + EPS) break
      if (bj.min[1] > bi.max[1] + EPS || bi.min[1] > bj.max[1] + EPS) continue
      const lo = Math.min(i, j)
      const hi = Math.max(i, j)
      const hits = intersect(elements[lo]!, elements[hi]!)
      if (hits === 'overlap') return { a: lo, b: hi, at: elements[hi]!.a }
      for (const h of hits) {
        const vs = vertex(lo, h.s)
        const vt = vertex(hi, h.t)
        // the junction two elements share is no crossing
        if (vs !== undefined && vs === vt) continue
        const [p1, p2] = around(lo, h.s)
        const [q1, q2] = around(hi, h.t)
        if (separates(p1, p2, q1, q2)) return { a: lo, b: hi, at: h.p }
      }
    }
  }
  return undefined
}
