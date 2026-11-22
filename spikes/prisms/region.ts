/**
 * Spike S3 (docs/plans/v0.3.md § Spikes; report: spikes/prisms/results.md): regions of lines and
 * arcs in the 2D model of docs/architecture/shapes.md § 2D model, flattened at the chord tolerance,
 * plus the generators the measurements use. Throwaway code, not part of the app.
 */
import { arcSegments } from '../../src/core/geometry/contour'
import { CHORD_TOLERANCE, type Vec2 } from '../../src/core/geometry/model'

export type Element =
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 }
  | {
      readonly kind: 'arc'
      readonly a: Vec2
      readonly b: Vec2
      readonly centre: Vec2
      readonly ccw: boolean
    }

/** A closed chain of elements (each `b` is the next `a`). */
export type Loop = readonly Element[]

/** Outer loop counter-clockwise first, holes (islands) clockwise. */
export interface Region {
  readonly loops: readonly Loop[]
}

/** One flattened loop: its points and, per chord `points[i] → points[i + 1]`, the element index. */
export interface Ring {
  readonly points: readonly Vec2[]
  readonly element: readonly number[]
}

export const elementCount = (r: Region): number => r.loops.reduce((n, l) => n + l.length, 0)

function sweepOf(e: Extract<Element, { kind: 'arc' }>): number {
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
  let s = e.ccw ? a1 - a0 : a0 - a1
  while (s <= 1e-12) s += 2 * Math.PI
  return s
}

/**
 * Inscribed flattening (vertices on the arcs: removals shrink, as v0.1 does), element indices
 * running over all loops (loop 0 first): `wall[i]` / `corner[i]` of design-v0.3.md § Surfaces.
 */
export function flatten(region: Region, tolerance = CHORD_TOLERANCE): Ring[] {
  let index = 0
  return region.loops.map((loop) => {
    const points: Vec2[] = []
    const element: number[] = []
    for (const e of loop) {
      const i = index++
      points.push(e.a)
      element.push(i)
      if (e.kind === 'line') continue
      const sweep = sweepOf(e)
      const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
      const n = arcSegments(r, sweep, tolerance)
      const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const dir = e.ccw ? 1 : -1
      for (let k = 1; k < n; k++) {
        const t = a0 + (dir * sweep * k) / n
        points.push([e.centre[0] + r * Math.cos(t), e.centre[1] + r * Math.sin(t)])
        element.push(i)
      }
    }
    return { points, element }
  })
}

/** Signed area of the flattened region (outer positive, holes negative). */
export function ringArea(rings: readonly Ring[]): number {
  let a = 0
  for (const { points } of rings)
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      const q = points[(i + 1) % points.length]!
      a += p[0] * q[1] - q[0] * p[1]
    }
  return a / 2
}

const at = (c: Vec2, r: number, t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]

/** A circle as two half arcs, counter-clockwise (outer) or clockwise (hole). */
export function circle(c: Vec2, r: number, ccw: boolean): Loop {
  const p = at(c, r, 0)
  const q = at(c, r, Math.PI)
  return [
    { kind: 'arc', a: p, b: q, centre: c, ccw },
    { kind: 'arc', a: q, b: p, centre: c, ccw },
  ]
}

/** Axis-aligned rectangle with corner radius `r` (> 0): 4 lines + 4 arcs; hole when `!ccw`. */
export function roundedRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  ccw = true,
): Loop {
  const ccwLoop: Element[] = [
    { kind: 'line', a: [x0 + r, y0], b: [x1 - r, y0] },
    { kind: 'arc', a: [x1 - r, y0], b: [x1, y0 + r], centre: [x1 - r, y0 + r], ccw: true },
    { kind: 'line', a: [x1, y0 + r], b: [x1, y1 - r] },
    { kind: 'arc', a: [x1, y1 - r], b: [x1 - r, y1], centre: [x1 - r, y1 - r], ccw: true },
    { kind: 'line', a: [x1 - r, y1], b: [x0 + r, y1] },
    { kind: 'arc', a: [x0 + r, y1], b: [x0, y1 - r], centre: [x0 + r, y1 - r], ccw: true },
    { kind: 'line', a: [x0, y1 - r], b: [x0, y0 + r] },
    { kind: 'arc', a: [x0, y0 + r], b: [x0 + r, y0], centre: [x0 + r, y0 + r], ccw: true },
  ]
  return ccw ? ccwLoop : reverse(ccwLoop)
}

/** The same loop run the other way. */
export function reverse(loop: Loop): Loop {
  return [...loop]
    .reverse()
    .map((e) =>
      e.kind === 'line' ? { ...e, a: e.b, b: e.a } : { ...e, a: e.b, b: e.a, ccw: !e.ccw },
    )
}

/** Polygon of lines through `points` (closed). */
export function polygon(points: readonly Vec2[]): Loop {
  return points.map((a, i) => ({ kind: 'line', a, b: points[(i + 1) % points.length]! }))
}

/**
 * "Scalloped star" around `c`: `k` sectors, each a line on the circle of radius `R` followed by a
 * concave arc notch (clockwise, radius 2× its half chord) – non-convex, 2k elements.
 */
export function scallop(c: Vec2, R: number, k: number): Loop {
  const out: Element[] = []
  const sector = (2 * Math.PI) / k
  for (let i = 0; i < k; i++) {
    const t0 = i * sector
    const a = at(c, R, t0)
    const b = at(c, R, t0 + sector / 2)
    const next = at(c, R, t0 + sector)
    out.push({ kind: 'line', a, b })
    // centre on the bisector, beyond the chord: radius 2 × half chord, the arc dips into the region
    const half = Math.hypot(next[0] - b[0], next[1] - b[1]) / 2
    const mid: Vec2 = [(b[0] + next[0]) / 2, (b[1] + next[1]) / 2]
    const ux = (mid[0] - c[0]) / Math.hypot(mid[0] - c[0], mid[1] - c[1])
    const uy = (mid[1] - c[1]) / Math.hypot(mid[0] - c[0], mid[1] - c[1])
    const off = Math.sqrt(3) * half // r = 2·half → distance from the chord √3·half
    out.push({
      kind: 'arc',
      a: b,
      b: next,
      centre: [mid[0] + ux * off, mid[1] + uy * off],
      ccw: false,
    })
  }
  return out
}

/** Family "star": one scalloped outer loop plus two circular islands; `n` ≈ elements. */
export function starRegion(n: number, c: Vec2 = [100, 60], R = 50): Region {
  const k = Math.max(3, Math.round((n - 4) / 2))
  return {
    loops: [
      scallop(c, R, k),
      circle([c[0] - R / 3, c[1]], R / 8, false),
      circle([c[0] + R / 3, c[1]], R / 8, false),
    ],
  }
}

/**
 * Family "islands": an outer rounded rectangle and a grid of rounded-square islands (8 elements
 * each) – many holes for the triangulator; `n` ≈ elements.
 */
export function islandsRegion(n: number, x0 = 10, y0 = 10, x1 = 190, y1 = 110): Region {
  const count = Math.max(1, Math.round((n - 8) / 8))
  const cols = Math.ceil(Math.sqrt((count * (x1 - x0)) / (y1 - y0)))
  const rows = Math.ceil(count / cols)
  const cw = (x1 - x0) / cols
  const ch = (y1 - y0) / rows
  const s = Math.min(cw, ch) * 0.5
  const loops: Loop[] = [roundedRect(x0, y0, x1, y1, 5)]
  for (let i = 0; i < count; i++) {
    const cx = x0 + cw * ((i % cols) + 0.5)
    const cy = y0 + ch * (Math.floor(i / cols) + 0.5)
    loops.push(roundedRect(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, s / 5, false))
  }
  return { loops }
}
