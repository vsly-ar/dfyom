/**
 * Analytic v0.1 contours: offsets, exact elements (lines and arcs) and flattening.
 * One implementation shared by geometry evaluation and toolpaths (exact arcs for G2/G3 come
 * from `contourElements`; meshes use the flattening).
 * Doc: docs/architecture/geometry.md#offset-loft
 */
import { None, Option, Some } from '../../shared/result'
import { CHORD_TOLERANCE, EPSILON, type Contour, type Vec2 } from './model'

/** Design role of a contour element: `wall[i]` (straight, or a whole circle) or `corner[i]`. */
export interface ContourLabel {
  readonly role: 'wall' | 'corner'
  readonly index: number
}

export type ContourElement =
  | { readonly kind: 'line'; readonly label: ContourLabel; readonly from: Vec2; readonly to: Vec2 }
  | {
      readonly kind: 'arc'
      readonly label: ContourLabel
      readonly center: Vec2
      readonly radius: number
      /** Start angle in radians; the arc runs counter-clockwise by `sweep`. */
      readonly start: number
      readonly sweep: number
    }

/**
 * Offset a contour (`offset` > 0 = inward). Sharp corners stay sharp inward and round off
 * outward, as for a true offset of a convex shape. None if the offset passes the medial axis
 * (beyond ε); sizes that reach zero collapse to a segment or point.
 */
export function offsetContour(c: Contour, offset: number): Option<Contour> {
  if (c.kind === 'circle') {
    const radius = c.radius - offset
    if (radius < -EPSILON) return None
    return Some({ kind: 'circle', radius: Math.max(radius, 0) })
  }
  const length = c.length - 2 * offset
  const width = c.width - 2 * offset
  if (length < -EPSILON || width < -EPSILON) return None
  return Some({
    kind: 'rectangle',
    length: Math.max(length, 0),
    width: Math.max(width, 0),
    cornerRadius: Math.max(c.cornerRadius - offset, 0),
  })
}

/**
 * Exact elements, counter-clockwise from the start of `wall[0]` (rectangle: front wall, left
 * end; circle: the front point). Corner `i` precedes wall `i` ("following wall", design.md).
 */
export function contourElements(c: Contour): readonly ContourElement[] {
  if (c.kind === 'circle') {
    return [
      {
        kind: 'arc',
        label: { role: 'wall', index: 0 },
        center: [0, 0],
        radius: c.radius,
        start: -Math.PI / 2,
        sweep: 2 * Math.PI,
      },
    ]
  }
  const r = c.cornerRadius
  const hx = c.length / 2 - r
  const hy = c.width / 2 - r
  const R = c.width / 2
  const X = c.length / 2
  const wall = (index: number, from: Vec2, to: Vec2): ContourElement => ({
    kind: 'line',
    label: { role: 'wall', index },
    from,
    to,
  })
  const corner = (index: number, center: Vec2, start: number): ContourElement => ({
    kind: 'arc',
    label: { role: 'corner', index },
    center,
    radius: r,
    start,
    sweep: Math.PI / 2,
  })
  return [
    wall(0, [-hx, -R], [hx, -R]),
    corner(1, [hx, -hy], -Math.PI / 2),
    wall(1, [X, -hy], [X, hy]),
    corner(2, [hx, hy], 0),
    wall(2, [hx, R], [-hx, R]),
    corner(3, [-hx, hy], Math.PI / 2),
    wall(3, [-X, hy], [-X, -hy]),
    corner(0, [-hx, -hy], Math.PI),
  ]
}

function elementLength(e: ContourElement): number {
  return e.kind === 'line'
    ? Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1])
    : e.radius * e.sweep
}

export function perimeter(c: Contour): number {
  return contourElements(c).reduce((sum, e) => sum + elementLength(e), 0)
}

/** Point at fraction `u` (0..1) along an element. */
function elementPoint(e: ContourElement, u: number): Vec2 {
  if (e.kind === 'line')
    return [e.from[0] + (e.to[0] - e.from[0]) * u, e.from[1] + (e.to[1] - e.from[1]) * u]
  const a = e.start + e.sweep * u
  return [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)]
}

/**
 * Chords per arc so the sagitta stays ≤ `tolerance`: n = ⌈θ / (2·acos(1 − t/r))⌉ ≥ 1.
 * The same bound holds for circumscribed polygons (r/cos(α/2) − r ≈ sagitta).
 */
export function arcSegments(radius: number, sweep: number, tolerance = CHORD_TOLERANCE): number {
  if (radius <= tolerance) return 1
  const step = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - tolerance / radius)))
  // tiny slack: an exact multiple must not round up to one extra chord
  return Math.max(1, Math.ceil(sweep / step - 1e-9))
}

/**
 * - `inscribed`: vertices on the arcs, chords inside (the region shrinks).
 * - `circumscribed`: edges tangent to the arcs, vertices outside (the region grows).
 * Removals use `inscribed` and the solids subtracted from them (the kept side) `circumscribed`,
 * so meshes always keep slightly more material.
 */
export type FlattenMode = 'inscribed' | 'circumscribed'

/** One flattening shared by every offset of a contour, so rings correspond slot by slot. */
export interface Parameterization {
  readonly contour: Contour
  readonly mode: FlattenMode
  /** Chords per element (0 for lines), from the largest radius over all offsets. */
  readonly segments: readonly number[]
}

export function parameterize(
  contour: Contour,
  offsets: readonly number[],
  mode: FlattenMode = 'inscribed',
  tolerance = CHORD_TOLERANCE,
): Parameterization {
  const segments = contourElements(contour).map((e) => {
    if (e.kind === 'line') return 0
    const radius = Math.max(0, ...offsets.map((o) => e.radius - o))
    return arcSegments(radius, e.sweep, tolerance)
  })
  return { contour, mode, segments }
}

export interface RingSlot {
  readonly point: Vec2
  /** Label of the segment from this slot to the next. */
  readonly label: ContourLabel
}

/**
 * The closed ring of the contour offset by `offset`, one slot per parameter (not deduplicated:
 * a collapsed arc repeats its point, so rings of all offsets have the same length).
 * None if the offset passes the medial axis.
 */
export function flattenRing(p: Parameterization, offset: number): Option<readonly RingSlot[]> {
  return offsetContour(p.contour, offset).map((oc) => {
    const els = contourElements(oc)
    const slots: RingSlot[] = []
    els.forEach((e, i) => {
      if (e.kind === 'line') return
      const next = els[(i + 1) % els.length]!.label
      const closed = els.length === 1
      const n = p.segments[i]!
      const alpha = e.sweep / n
      const on = (a: number): Vec2 => [
        e.center[0] + e.radius * Math.cos(a),
        e.center[1] + e.radius * Math.sin(a),
      ]
      if (p.mode === 'inscribed') {
        for (let k = 0; k < n; k++) slots.push({ point: on(e.start + k * alpha), label: e.label })
      } else {
        const rOut = e.radius / Math.cos(alpha / 2)
        slots.push({ point: on(e.start), label: e.label })
        for (let k = 0; k < n; k++) {
          const a = e.start + (k + 0.5) * alpha
          slots.push({
            point: [e.center[0] + rOut * Math.cos(a), e.center[1] + rOut * Math.sin(a)],
            label: e.label,
          })
        }
      }
      if (!closed) slots.push({ point: on(e.start + e.sweep), label: next })
    })
    return slots
  })
}

/**
 * Open sub-path of the contour offset by `offset`, between arc lengths `from` < `to` measured
 * along the un-offset contour from the start of `wall[0]` (wraps past the perimeter). Points
 * correspond across offsets (same element parameters), so the sub-paths of two offsets bound a
 * band whose end faces are normal to the contour. Inscribed flattening.
 */
export function flattenPath(
  p: Parameterization,
  offset: number,
  from: number,
  to: number,
): Option<readonly Vec2[]> {
  const base = contourElements(p.contour)
  const lengths = base.map(elementLength)
  const total = lengths.reduce((a, b) => a + b, 0)
  const start = ((from % total) + total) % total
  const end = start + (to - from)
  return offsetContour(p.contour, offset).map((oc) => {
    const els = contourElements(oc)
    const out: Vec2[] = []
    /** Point at arc length `s` (already unrolled) on the offset contour. */
    const at = (s: number): Vec2 => {
      let acc = Math.floor(s / total) * total
      for (let i = 0; i < els.length; i++) {
        const len = lengths[i]!
        if (s <= acc + len + 1e-12 && len > 0) return elementPoint(els[i]!, (s - acc) / len)
        acc += len
      }
      return elementPoint(els[0]!, 0)
    }
    out.push(at(start))
    for (let lap = 0; lap * total < end; lap++) {
      let acc = lap * total
      els.forEach((e, i) => {
        const len = lengths[i]!
        if (e.kind === 'arc') {
          // Arc slots incl. both ends (the ends are the neighbouring lines' ends); a closed
          // circle skips its end, which is the next lap's start. A zero-length (sharp) corner
          // has all slots at one s but spreads into an arc at outward offsets.
          const n = p.segments[i]!
          const last = els.length === 1 ? n - 1 : n
          for (let k = 0; k <= last; k++) {
            const s = acc + (len * k) / n
            if (s > start && s < end) out.push(elementPoint(e, k / n))
          }
        }
        acc += len
      })
    }
    out.push(at(end))
    return out
  })
}
