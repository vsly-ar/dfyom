// Snapping (task U3), pure: the target under a dragged point – shape points (ends, centres,
// midpoints), stock corners and edges, the reference section, grid points – within a tolerance in
// screen pixels, by priority and then distance. Works in any 2D frame given its pixels per unit
// (the flat view's face frame in mm, or the 3D viewport's screen in px).
// Doc: docs/conventions/ui.md#snap-and-measure, docs/modes/design-v0.3.md#measure-and-snap
import type { Element } from '../../../core/geometry/2d/model'
import type { Vec2 } from '../../../core/geometry/model'

/** What a snap landed on; the glyph's shape and the label chip follow from it. */
export type SnapKind = 'end' | 'corner' | 'centre' | 'midpoint' | 'edge' | 'reference' | 'grid'

export interface SnapPoint {
  readonly kind: 'end' | 'corner' | 'centre' | 'midpoint'
  readonly at: Vec2
}

export interface SnapTargets {
  readonly points: readonly SnapPoint[]
  /** Stock edges: `[a, b]` segments, snapped to their nearest point. */
  readonly edges: readonly (readonly [Vec2, Vec2])[]
  /** The reference section: `[u0, v0, u1, v1, …]`, snapped to its nearest point. */
  readonly reference?: Float32Array | null
  /** Grid step (frame units), or null for no grid. Grid points are its multiples from the origin. */
  readonly grid?: number | null
}

export interface Snap {
  readonly at: Vec2
  readonly kind: SnapKind
}

/** Pointer distance (px) within which a target pulls the point (ui.md § Snap and measure). */
export const SNAP_PX = 8

/**
 * Lower wins: points beat curves, curves beat the grid, so a corner 6 px away is taken over an
 * edge under the pointer, and the grid only fills in where nothing else is near.
 */
export const SNAP_PRIORITY: Readonly<Record<SnapKind, number>> = {
  end: 0,
  corner: 0,
  centre: 1,
  midpoint: 2,
  edge: 3,
  reference: 3,
  grid: 4,
}

/** Whether a snap lands on an exact number (grid, stock, shape points) or on a sampled mesh. */
export const isExactSnap = (kind: SnapKind): boolean => kind !== 'reference'

const near = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9

function nearestOnSegment(
  p: Vec2,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number, number] {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
  const x = ax + t * dx
  const y = ay + t * dy
  return [x, y, Math.hypot(p[0] - x, p[1] - y)]
}

/**
 * The snap for point `p` (frame units), or null when no target lies within `tolerancePx`.
 * `exclude` drops a point target at that position (the dragged handle where it started).
 */
export function snapPoint(
  p: Vec2,
  targets: SnapTargets,
  opts: { readonly pxPerUnit: number; readonly tolerancePx?: number; readonly exclude?: Vec2 },
): Snap | null {
  const tol = (opts.tolerancePx ?? SNAP_PX) / opts.pxPerUnit
  let best: Snap | null = null
  let bestRank = Infinity
  let bestDist = Infinity
  const offer = (at: Vec2, kind: SnapKind, d: number) => {
    if (d > tol) return
    const rank = SNAP_PRIORITY[kind]
    if (rank < bestRank || (rank === bestRank && d < bestDist)) {
      best = { at, kind }
      bestRank = rank
      bestDist = d
    }
  }
  for (const t of targets.points) {
    if (opts.exclude !== undefined && near(t.at, opts.exclude)) continue
    offer(t.at, t.kind, Math.hypot(p[0] - t.at[0], p[1] - t.at[1]))
  }
  for (const [a, b] of targets.edges) {
    const [x, y, d] = nearestOnSegment(p, a[0], a[1], b[0], b[1])
    offer([x, y], 'edge', d)
  }
  const ref = targets.reference
  if (ref) {
    let rx = 0
    let ry = 0
    let rd = Infinity
    for (let i = 0; i + 3 < ref.length; i += 4) {
      // cheap reject on the segment's box
      const x0 = Math.min(ref[i]!, ref[i + 2]!) - tol
      const x1 = Math.max(ref[i]!, ref[i + 2]!) + tol
      if (p[0] < x0 || p[0] > x1) continue
      const y0 = Math.min(ref[i + 1]!, ref[i + 3]!) - tol
      const y1 = Math.max(ref[i + 1]!, ref[i + 3]!) + tol
      if (p[1] < y0 || p[1] > y1) continue
      const [x, y, d] = nearestOnSegment(p, ref[i]!, ref[i + 1]!, ref[i + 2]!, ref[i + 3]!)
      if (d < rd) [rx, ry, rd] = [x, y, d]
    }
    if (rd < Infinity) offer([rx, ry], 'reference', rd)
  }
  const g = targets.grid
  if (g != null && g > 0) {
    const at: Vec2 = [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g]
    offer(at, 'grid', Math.hypot(p[0] - at[0], p[1] - at[1]))
  }
  return best
}

/** Shape points of loops: every element's ends and midpoint, and every arc's centre. */
export function shapePoints(loops: readonly (readonly Element[])[]): SnapPoint[] {
  const out: SnapPoint[] = []
  const seen = new Set<string>()
  const add = (kind: SnapPoint['kind'], at: Vec2) => {
    const key = `${kind}:${at[0].toFixed(6)},${at[1].toFixed(6)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, at })
  }
  for (const elements of loops)
    for (const e of elements) {
      add('end', e.a)
      add('end', e.b)
      if (e.kind === 'line') {
        add('midpoint', [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2])
        continue
      }
      add('centre', e.centre)
      const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
      const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
      let sweep = e.ccw ? a1 - a0 : a0 - a1
      while (sweep <= 0) sweep += 2 * Math.PI
      const mid = a0 + ((e.ccw ? 1 : -1) * sweep) / 2
      add('midpoint', [e.centre[0] + r * Math.cos(mid), e.centre[1] + r * Math.sin(mid)])
    }
  return out
}

/** The stock face `[0, 0]`–`[length, width]`: its corners and its four edges. */
export function stockTargets(
  length: number,
  width: number,
): { points: SnapPoint[]; edges: [Vec2, Vec2][] } {
  const c: Vec2[] = [
    [0, 0],
    [length, 0],
    [length, width],
    [0, width],
  ]
  return {
    points: c.map((at) => ({ kind: 'corner', at })),
    edges: c.map((a, i) => [a, c[(i + 1) % 4]!]),
  }
}

/** The grid step (mm) of the snap grid setting for the project's unit system. */
export function snapGridMm(
  setting: { readonly mm: number; readonly inch: number },
  units: 'mm' | 'inch',
): number {
  return units === 'mm' ? setting.mm : setting.inch * 25.4
}
