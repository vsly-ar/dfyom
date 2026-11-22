// Spike S4 (docs/research/s4-offset-clearing.md): loop helpers on top of S1's bulge loops
// (spikes/2d/geom.ts): regions split into components, point-in-region, closest points, splitting
// a loop at a point, convex corners. Throwaway code, not part of the app.

import {
  arcOf,
  area,
  distToSeg,
  flatten,
  pointAt,
  segments,
  type Loop,
  type Pt,
  type Vertex,
} from '../2d/geom.ts'

/** One connected piece of a region: a counter-clockwise outer loop and its clockwise holes. */
export interface Component {
  readonly outer: Loop
  readonly holes: readonly Loop[]
}

export const loopsOf = (c: Component): Loop[] => [c.outer, ...c.holes]

const polyCache = new WeakMap<Loop, Pt[]>()
/** Flattened loop at 1 µm, cached (for inside tests only; distances use the exact segments). */
export function poly(l: Loop): Pt[] {
  let p = polyCache.get(l)
  if (!p) {
    p = flatten(l, 0.001)
    polyCache.set(l, p)
  }
  return p
}

export function insidePoly(pts: readonly Pt[], p: Pt): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!
    const b = pts[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}

export function distToLoops(loops: readonly Loop[], p: Pt): number {
  let best = Infinity
  for (const l of loops) for (const [a, b] of segments(l)) best = Math.min(best, distToSeg(p, a, b))
  return best
}

/** Inside the component, or within `tol` of its boundary. */
export function inComponent(c: Component, p: Pt, tol = 0): boolean {
  const inside = insidePoly(poly(c.outer), p) && !c.holes.some((h) => insidePoly(poly(h), p))
  return inside || (tol > 0 && distToLoops(loopsOf(c), p) <= tol)
}

/** Group offset or boolean output into components (each hole into the smallest outer containing it). */
export function components(loops: readonly Loop[]): Component[] {
  const outers = loops.filter((l) => area(l) > 0).sort((a, b) => area(a) - area(b))
  const holes = loops.filter((l) => area(l) < 0)
  const groups = outers.map((outer) => ({ outer, holes: [] as Loop[] }))
  for (const h of holes) {
    const v = h.verts[0]!
    const g = groups.find((g) => insidePoly(poly(g.outer), { x: v[0], y: v[1] }))
    if (g) g.holes.push(h)
  }
  return groups
}

export interface Closest {
  readonly seg: number
  readonly t: number
  readonly p: Pt
  readonly d: number
}

const TAU = Math.PI * 2

/** Closest point of a closed loop to `q` (segment index, parameter, point, distance). */
export function closest(l: Loop, q: Pt): Closest {
  let best: Closest = { seg: 0, t: 0, p: { x: l.verts[0]![0], y: l.verts[0]![1] }, d: Infinity }
  let i = 0
  for (const [a, b] of segments(l)) {
    const arc = arcOf(a, b)
    let t: number
    if (!arc) {
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      t = len2 < 1e-18 ? 0 : ((q.x - a[0]) * dx + (q.y - a[1]) * dy) / len2
    } else {
      const ang = Math.atan2(q.y - arc.c.y, q.x - arc.c.x)
      const rel =
        arc.sweep >= 0
          ? (((ang - arc.a0) % TAU) + TAU) % TAU
          : -((((arc.a0 - ang) % TAU) + TAU) % TAU)
      t = rel / arc.sweep
      if (t > 1) {
        // off the sweep: the nearer end
        const d0 = Math.hypot(q.x - a[0], q.y - a[1])
        const d1 = Math.hypot(q.x - b[0], q.y - b[1])
        t = d0 < d1 ? 0 : 1
      }
    }
    t = Math.max(0, Math.min(1, t))
    const p = pointAt(a, b, t)
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < best.d) best = { seg: i, t, p, d }
    i++
  }
  return best
}

/** The same closed loop, starting at parameter `t` of segment `seg` (the segment is split there). */
export function startAt(l: Loop, seg: number, t: number): Loop {
  const n = l.verts.length
  const a = l.verts[seg]!
  const b = l.verts[(seg + 1) % n]!
  if (t < 1e-9 || t > 1 - 1e-9) {
    const s = t < 1e-9 ? seg : (seg + 1) % n
    return { closed: true, verts: [...l.verts.slice(s), ...l.verts.slice(0, s)] }
  }
  const arc = arcOf(a, b)
  const sweep = arc ? arc.sweep : 0
  const p = pointAt(a, b, t)
  const head: Vertex = [p.x, p.y, arc ? Math.tan((sweep * (1 - t)) / 4) : 0]
  const tail: Vertex = [a[0], a[1], arc ? Math.tan((sweep * t) / 4) : 0]
  const rest: Vertex[] = []
  for (let k = 1; k < n; k++) rest.push(l.verts[(seg + k) % n]!)
  return { closed: true, verts: [head, ...rest, tail] }
}

export function loopLength(l: Loop): number {
  let s = 0
  for (const [a, b] of segments(l)) {
    const arc = arcOf(a, b)
    s += arc ? arc.r * Math.abs(arc.sweep) : Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return s
}

/** Unit tangent at the start (t = 0) or end (t = 1) of a segment. */
function tangent(a: Vertex, b: Vertex, end: boolean): Pt {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const half = 2 * Math.atan(a[2]) // sweep / 2
  const rot = end ? -half : half
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return { x: (dx * c - dy * s) / len, y: (dx * s + dy * c) / len }
}

/**
 * Smallest interior angle of a convex corner (a left turn with a tangent jump; the region lies
 * left of every loop) over the loops; π when there is none.
 */
export function minConvexCorner(loops: readonly Loop[]): number {
  let min = Math.PI
  for (const l of loops) {
    const segs = [...segments(l)]
    for (let i = 0; i < segs.length; i++) {
      const [a0, b0] = segs[i]!
      const [a1, b1] = segs[(i + 1) % segs.length]!
      if (Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) < 1e-9) continue
      const tin = tangent(a0, b0, true)
      const tout = tangent(a1, b1, false)
      const turn = Math.atan2(tin.x * tout.y - tin.y * tout.x, tin.x * tout.x + tin.y * tout.y)
      if (turn > 1e-6) min = Math.min(min, Math.PI - turn)
    }
  }
  return min
}
