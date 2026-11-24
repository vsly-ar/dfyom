/**
 * Obstacle prisms of a setup's workholding (WH-B), the derived clearance height (WH-C) and the
 * obstacle interface the link post-pass reads (`WorkholdingObstacles`, for hardening DF64's
 * `planLinks`). Footprints are convex (rectangles, rotated rectangles, circles), so distances are
 * exact and cheap.
 * Doc: docs/modes/workholding.md#obstacles, docs/modes/workholding.md#links-and-safe-heights
 *
 * Pure and headless; mm in the setup frame (WCS: Z0 on the up-facing stock face).
 */
import type { Vec2 } from '../../geometry/model'
import { acrossEdge, type ResolvedItem, type SetupStock } from './items'

/** A convex footprint in the setup frame: a polygon (counter-clockwise) or a circle. */
export type Footprint =
  | { readonly kind: 'polygon'; readonly points: readonly Vec2[] }
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number }

/**
 * One obstacle: a footprint extruded from `zMin` (−∞: down to the table) to `zMax`. Only `zMax`
 * matters for the tool, which is a cylinder from its tip upward (WH-F).
 */
export interface Prism {
  readonly itemId: string
  readonly footprint: Footprint
  readonly zMin: number
  readonly zMax: number
}

const rect = (x0: number, y0: number, x1: number, y1: number): Footprint => ({
  kind: 'polygon',
  points: [
    [Math.min(x0, x1), Math.min(y0, y1)],
    [Math.max(x0, x1), Math.min(y0, y1)],
    [Math.max(x0, x1), Math.max(y0, y1)],
    [Math.min(x0, x1), Math.max(y0, y1)],
  ],
})

/**
 * The prisms of one item (workholding.md § Obstacles): a toe clamp is two (over the stock from
 * Z0, beyond the edge from the table), a vise its two jaws, a screw its head and shank, a block
 * its rotated rectangle; `base` and `surface` are none (the base only matters for breakthrough).
 */
export function itemPrisms(item: ResolvedItem, stock: SetupStock): Prism[] {
  const { length: L, width: W, thickness: T } = stock
  const id = item.id
  switch (item.kind) {
    case 'toeClamp': {
      const a = item.at - item.width / 2
      const b = item.at + item.width / 2
      // [inside, outside] across the edge, measured from the edge line inward
      const across = acrossEdge(item.edge, stock)
      const grip = Math.min(item.grip, across)
      const over = (lo: number, hi: number): Footprint => {
        switch (item.edge) {
          case 'vMin':
            return rect(a, lo, b, hi)
          case 'vMax':
            return rect(a, W - hi, b, W - lo)
          case 'uMin':
            return rect(lo, a, hi, b)
          case 'uMax':
            return rect(L - hi, a, L - lo, b)
        }
      }
      const out: Prism[] = [{ itemId: id, footprint: over(0, grip), zMin: 0, zMax: item.top }]
      if (item.reach > 0)
        out.push({ itemId: id, footprint: over(-item.reach, 0), zMin: -Infinity, zMax: item.top })
      return out
    }
    case 'vise': {
      const t = item.jawThickness
      const half = item.jawLength / 2
      const z = -item.protrusion
      if (item.axis === 'u') {
        const c = W / 2
        return [
          { itemId: id, footprint: rect(-t, c - half, 0, c + half), zMin: -Infinity, zMax: z },
          { itemId: id, footprint: rect(L, c - half, L + t, c + half), zMin: -Infinity, zMax: z },
        ]
      }
      const c = L / 2
      return [
        { itemId: id, footprint: rect(c - half, -t, c + half, 0), zMin: -Infinity, zMax: z },
        { itemId: id, footprint: rect(c - half, W, c + half, W + t), zMin: -Infinity, zMax: z },
      ]
    }
    case 'screw':
      return [
        {
          itemId: id,
          footprint: {
            kind: 'circle',
            center: [item.center[0], item.center[1]],
            radius: item.headDiameter / 2,
          },
          zMin: -Infinity,
          zMax: item.top,
        },
      ]
    case 'block': {
      const a = (item.rotation * Math.PI) / 180
      const [c, s] = [Math.cos(a), Math.sin(a)]
      const [cx, cy] = item.center
      const hl = item.length / 2
      const hw = item.width / 2
      const corners: Vec2[] = (
        [
          [-hl, -hw],
          [hl, -hw],
          [hl, hw],
          [-hl, hw],
        ] as const
      ).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c])
      return [
        {
          itemId: id,
          footprint: { kind: 'polygon', points: corners },
          zMin: item.bottom ?? -T,
          zMax: item.top,
        },
      ]
    }
    case 'base':
    case 'surface':
      return []
  }
}

/** Every item's prisms, in item order. */
export function obstacles(items: readonly ResolvedItem[], stock: SetupStock): Prism[] {
  return items.flatMap((i) => itemPrisms(i, stock))
}

// ── distances ────────────────────────────────────────────────────────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1]
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0]

/** Closest point on segment ab to p. */
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a)
  const l2 = dot(d, d)
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / l2))
  return [a[0] + t * d[0], a[1] + t * d[1]]
}

function insidePolygon(p: Vec2, pts: readonly Vec2[]): boolean {
  // convex, counter-clockwise: left of (or on) every edge
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    if (cross(sub(b, a), sub(p, a)) < -1e-12) return false
  }
  return true
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a))
  const d2 = cross(sub(b, a), sub(d, a))
  const d3 = cross(sub(d, c), sub(a, c))
  const d4 = cross(sub(d, c), sub(b, c))
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0)
}

/** The distance between segment ab and the footprint (0 when they meet) and the point on ab. */
export function segmentDistance(
  f: Footprint,
  a: Vec2,
  b: Vec2,
): { readonly distance: number; readonly at: Vec2 } {
  if (f.kind === 'circle') {
    const q = closestOnSegment(f.center, a, b)
    return {
      distance: Math.max(0, Math.hypot(q[0] - f.center[0], q[1] - f.center[1]) - f.radius),
      at: q,
    }
  }
  const pts = f.points
  if (insidePolygon(a, pts)) return { distance: 0, at: a }
  if (insidePolygon(b, pts)) return { distance: 0, at: b }
  let best = Infinity
  let at: Vec2 = a
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i]!
    const d = pts[(i + 1) % pts.length]!
    if (segmentsCross(a, b, c, d)) {
      // where ab enters the polygon edge
      const r = sub(b, a)
      const s = sub(d, c)
      const den = cross(r, s)
      const t = den === 0 ? 0 : cross(sub(c, a), s) / den
      return { distance: 0, at: [a[0] + t * r[0], a[1] + t * r[1]] }
    }
    // segment–segment distance without a crossing: an endpoint to the other segment
    for (const [p, on, q] of [
      [a, true, closestOnSegment(a, c, d)],
      [b, true, closestOnSegment(b, c, d)],
      [c, false, closestOnSegment(c, a, b)],
      [d, false, closestOnSegment(d, a, b)],
    ] as const) {
      const dist = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (dist < best) {
        best = dist
        at = on ? p : q
      }
    }
  }
  return { distance: best, at }
}

/** The distance between a point and the footprint (0 inside). */
export const pointDistance = (f: Footprint, p: Vec2): number => segmentDistance(f, p, p).distance

/** Axis-aligned bounds of a footprint: [[xMin, yMin], [xMax, yMax]]. */
export function footprintBounds(f: Footprint, grow = 0): [Vec2, Vec2] {
  if (f.kind === 'circle')
    return [
      [f.center[0] - f.radius - grow, f.center[1] - f.radius - grow],
      [f.center[0] + f.radius + grow, f.center[1] + f.radius + grow],
    ]
  const xs = f.points.map((p) => p[0])
  const ys = f.points.map((p) => p[1])
  return [
    [Math.min(...xs) - grow, Math.min(...ys) - grow],
    [Math.max(...xs) + grow, Math.max(...ys) + grow],
  ]
}

/**
 * The footprint's outline grown by `grow` (>= 0) as a closed counter-clockwise ring: rounded
 * corners (the keep-out zone of a point tool), circles with `segments` points. For drawing only.
 */
export function footprintOutline(f: Footprint, grow = 0, segments = 48): Vec2[] {
  if (f.kind === 'circle') {
    const r = f.radius + grow
    return Array.from({ length: segments }, (_, i): Vec2 => {
      const t = (i / segments) * 2 * Math.PI
      return [f.center[0] + r * Math.cos(t), f.center[1] + r * Math.sin(t)]
    })
  }
  if (grow <= 0) return f.points.map((p): Vec2 => [p[0], p[1]])
  const pts = f.points
  const n = pts.length
  const out: Vec2[] = []
  // the outward normal angle of edge a -> b (counter-clockwise ring: to the right of travel)
  const normal = (a: Vec2, b: Vec2): number => Math.atan2(-(b[0] - a[0]), b[1] - a[1])
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    let a0 = normal(pts[(i + n - 1) % n]!, p)
    const a1 = normal(p, pts[(i + 1) % n]!)
    while (a0 > a1) a0 -= 2 * Math.PI
    const steps = Math.max(1, Math.ceil(((a1 - a0) / (2 * Math.PI)) * segments))
    for (let k = 0; k <= steps; k++) {
      const t = a0 + ((a1 - a0) * k) / steps
      out.push([p[0] + grow * Math.cos(t), p[1] + grow * Math.sin(t)])
    }
  }
  return out
}

// ── clearance and the link interface ─────────────────────────────────────────────────────────

/** The highest prism top, or undefined without prisms. */
export function highestTop(prisms: readonly Prism[]): { zMax: number; itemId: string } | undefined {
  let best: { zMax: number; itemId: string } | undefined
  for (const p of prisms)
    if (best === undefined || p.zMax > best.zMax) best = { zMax: p.zMax, itemId: p.itemId }
  return best
}

/**
 * The obstacles the link post-pass (hardening DF64 `planLinks`, safe-links.md § Clamps) reads in
 * place of the setup's `clampHeight` once a setup has workholding items: the floor a tool of
 * radius `radius` must keep its tip above while its axis moves from `a` to `b`.
 * Doc: docs/modes/workholding.md#links-and-safe-heights
 */
export interface WorkholdingObstacles {
  readonly prisms: readonly Prism[]
  /** mm kept around every prism, sideways and above. */
  readonly margin: number
  /**
   * The highest `zMax + margin` over the prisms whose footprint comes within `radius + margin` of
   * the segment a→b (XY), or −∞ when none does: a link at or above it passes every item.
   */
  floorAlong(a: Vec2, b: Vec2, radius: number): number
}

export function workholdingObstacles(
  prisms: readonly Prism[],
  margin: number,
): WorkholdingObstacles {
  return {
    prisms,
    margin,
    floorAlong(a, b, radius) {
      let floor = -Infinity
      for (const p of prisms)
        if (
          p.zMax + margin > floor &&
          segmentDistance(p.footprint, a, b).distance < radius + margin
        )
          floor = p.zMax + margin
      return floor
    },
  }
}

/**
 * The clearance height a setup programs (mm above Z0, WH-C): as entered when the user set it,
 * else at least the highest prism top + the margin.
 */
export function effectiveClearance(
  stored: number,
  userSet: boolean,
  prisms: readonly Prism[],
  margin: number,
): { readonly value: number; readonly derivedFrom?: string } {
  if (userSet) return { value: stored }
  const top = highestTop(prisms)
  if (top === undefined || top.zMax + margin <= stored) return { value: stored }
  // 0.1 mm steps up, so goldens and the header read clean values
  return { value: Math.ceil((top.zMax + margin) * 10 - 1e-9) / 10, derivedFrom: top.itemId }
}
