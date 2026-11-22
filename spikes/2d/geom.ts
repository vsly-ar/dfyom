// Spike S1 (docs/decisions/0019-2d-geometry-library.md): library-neutral loop type, bulge maths and
// the oracles (offset distance, crossings, area). Throwaway code, not part of the app.

/** x, y, bulge (tan(sweep / 4), positive = counter-clockwise) of the segment starting here. */
export type Vertex = readonly [number, number, number]
export interface Loop {
  readonly closed: boolean
  readonly verts: readonly Vertex[]
}
export interface Pt {
  x: number
  y: number
}

const TAU = Math.PI * 2

/** Bulge segments shorter than this count as zero-length. */
export const EPS = 1e-9

export interface Arc {
  c: Pt
  r: number
  a0: number
  sweep: number
}

export function arcOf(p0: Vertex, p1: Vertex): Arc | null {
  const b = p0[2]
  if (Math.abs(b) < 1e-12) return null
  const dx = p1[0] - p0[0]
  const dy = p1[1] - p0[1]
  const chord = Math.hypot(dx, dy)
  if (chord < EPS) return null
  const k = (1 - b * b) / (4 * b)
  const c = { x: (p0[0] + p1[0]) / 2 - dy * k, y: (p0[1] + p1[1]) / 2 + dx * k }
  const r = (chord * (1 + b * b)) / (4 * Math.abs(b))
  return { c, r, a0: Math.atan2(p0[1] - c.y, p0[0] - c.x), sweep: 4 * Math.atan(b) }
}

export function segCount(l: Loop): number {
  return l.closed ? l.verts.length : l.verts.length - 1
}

export function* segments(l: Loop): Generator<[Vertex, Vertex]> {
  const n = l.verts.length
  for (let i = 0; i < segCount(l); i++) yield [l.verts[i]!, l.verts[(i + 1) % n]!]
}

export function countKinds(loops: readonly Loop[]): { arcs: number; lines: number } {
  let arcs = 0
  let lines = 0
  for (const l of loops)
    for (const [a] of segments(l)) {
      if (Math.abs(a[2]) > 1e-12) arcs++
      else lines++
    }
  return { arcs, lines }
}

/** Signed area (counter-clockwise positive), exact for arcs. */
export function area(l: Loop): number {
  let s = 0
  for (const [p0, p1] of segments(l)) {
    s += (p0[0] * p1[1] - p1[0] * p0[1]) / 2
    const a = arcOf(p0, p1)
    if (a) s += ((a.r * a.r) / 2) * (a.sweep - Math.sin(a.sweep))
  }
  return s
}

/** Net area of a set of loops (holes clockwise, so they subtract). */
export const netArea = (loops: readonly Loop[]): number => loops.reduce((s, l) => s + area(l), 0)

/** Points along a segment at parameter t in [0, 1]. */
export function pointAt(p0: Vertex, p1: Vertex, t: number): Pt {
  const a = arcOf(p0, p1)
  if (!a) return { x: p0[0] + (p1[0] - p0[0]) * t, y: p0[1] + (p1[1] - p0[1]) * t }
  const ang = a.a0 + a.sweep * t
  return { x: a.c.x + a.r * Math.cos(ang), y: a.c.y + a.r * Math.sin(ang) }
}

/** Inscribed flattening within chord tolerance `tol`; closed loops omit the repeated start. */
export function flatten(l: Loop, tol: number): Pt[] {
  const out: Pt[] = []
  for (const [p0, p1] of segments(l)) {
    out.push({ x: p0[0], y: p0[1] })
    const a = arcOf(p0, p1)
    if (!a) continue
    const step = a.r > tol ? 2 * Math.acos(1 - tol / a.r) : Math.PI
    const n = Math.max(1, Math.ceil(Math.abs(a.sweep) / step))
    for (let k = 1; k < n; k++) out.push(pointAt(p0, p1, k / n))
  }
  if (!l.closed) {
    const last = l.verts[l.verts.length - 1]!
    out.push({ x: last[0], y: last[1] })
  }
  return out
}

function distToLine(p: Pt, a: Vertex, b: Vertex): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t =
    len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2))
  return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy)
}

function onSweep(a: Arc, ang: number): boolean {
  if (a.sweep >= 0) return (((ang - a.a0) % TAU) + TAU) % TAU <= a.sweep
  return (((a.a0 - ang) % TAU) + TAU) % TAU <= -a.sweep
}

export function distToSeg(p: Pt, p0: Vertex, p1: Vertex): number {
  const a = arcOf(p0, p1)
  if (!a) return distToLine(p, p0, p1)
  if (onSweep(a, Math.atan2(p.y - a.c.y, p.x - a.c.x)))
    return Math.abs(Math.hypot(p.x - a.c.x, p.y - a.c.y) - a.r)
  return Math.min(Math.hypot(p.x - p0[0], p.y - p0[1]), Math.hypot(p.x - p1[0], p.y - p1[1]))
}

/**
 * Offset oracle: every point of the offset boundary of a region lies exactly `d` from the input
 * boundary. Returns the largest deviation over `samples` points per output segment.
 */
export function maxOffsetError(
  input: readonly Loop[],
  output: readonly Loop[],
  d: number,
  samples = 5,
): number {
  const segs = input.flatMap((l) => [...segments(l)])
  let worst = 0
  for (const l of output)
    for (const [p0, p1] of segments(l))
      for (let k = 0; k < samples; k++) {
        const p = pointAt(p0, p1, (k + 0.5) / samples)
        let best = Infinity
        for (const [q0, q1] of segs) best = Math.min(best, distToSeg(p, q0, q1))
        worst = Math.max(worst, Math.abs(best - Math.abs(d)))
      }
  return worst
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/**
 * Proper crossings between edges of the flattened loops (self and mutual), via a uniform grid.
 * Shared endpoints and touching do not count: only transversal crossings, which make a ring
 * invalid as a toolpath or region boundary.
 */
export function crossings(loops: readonly Loop[], tol = 0.002): number {
  const edges: [Pt, Pt, number, number][] = []
  loops.forEach((l, li) => {
    const pts = flatten(l, tol)
    const n = l.closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) edges.push([pts[i]!, pts[(i + 1) % pts.length]!, li, i])
  })
  if (edges.length === 0) return 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [a, b] of edges) {
    minX = Math.min(minX, a.x, b.x)
    minY = Math.min(minY, a.y, b.y)
    maxX = Math.max(maxX, a.x, b.x)
    maxY = Math.max(maxY, a.y, b.y)
  }
  const cell = Math.max((maxX - minX) / Math.sqrt(edges.length), (maxY - minY) / 64, 1e-6)
  const grid = new Map<string, number[]>()
  edges.forEach(([a, b], ei) => {
    const x0 = Math.floor((Math.min(a.x, b.x) - minX) / cell)
    const x1 = Math.floor((Math.max(a.x, b.x) - minX) / cell)
    const y0 = Math.floor((Math.min(a.y, b.y) - minY) / cell)
    const y1 = Math.floor((Math.max(a.y, b.y) - minY) / cell)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`
        const list = grid.get(k)
        if (list) list.push(ei)
        else grid.set(k, [ei])
      }
  })
  const seen = new Set<number>()
  let count = 0
  const e = 1e-12
  for (const list of grid.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const ia = list[i]!
        const ib = list[j]!
        const key = Math.min(ia, ib) * edges.length + Math.max(ia, ib)
        if (seen.has(key)) continue
        seen.add(key)
        const [a, b] = edges[ia]!
        const [c, d] = edges[ib]!
        const o1 = orient(a, b, c)
        const o2 = orient(a, b, d)
        const o3 = orient(c, d, a)
        const o4 = orient(c, d, b)
        if (
          ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) &&
          ((o3 > e && o4 < -e) || (o3 < -e && o4 > e))
        )
          count++
      }
  return count
}

/** Rigid transform helpers for fixtures. */
export function transform(l: Loop, f: (p: Pt) => Pt): Loop {
  return {
    closed: l.closed,
    verts: l.verts.map((v) => [...xy(f({ x: v[0], y: v[1] })), v[2]] as const),
  }
}
const xy = (p: Pt): [number, number] => [p.x, p.y]

export function reverse(l: Loop): Loop {
  const n = l.verts.length
  const verts: Vertex[] = []
  for (let i = 0; i < n; i++) {
    const v = l.verts[(n - i) % n]!
    const prev = l.verts[(n - i - 1 + n) % n]!
    verts.push([v[0], v[1], -prev[2]])
  }
  return { closed: l.closed, verts }
}
