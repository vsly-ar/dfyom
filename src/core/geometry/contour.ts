/**
 * Analytic v0.1 contours: offsets, exact elements (lines and arcs) and flattening.
 * One implementation shared by geometry evaluation and toolpaths (exact arcs for G2/G3 come
 * from `contourElements`; meshes use the flattening).
 * Doc: docs/architecture/geometry.md#offset-loft
 */
import { None, Option, Some } from '../../shared/result'
import { CHORD_TOLERANCE, EPSILON, type AnalyticContour as Contour, type Vec2 } from './model'

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
 * Segments per arc so the flattening stays within `tolerance` of the arc:
 * - inscribed (sagitta r(1 − cos(α/2)) ≤ t): n = ⌈θ / (2·acos(1 − t/r))⌉;
 * - circumscribed (vertex excess r(1/cos(α/2) − 1) ≤ t): n = ⌈θ / (2·acos(r / (r + t)))⌉,
 *   slightly more segments than inscribed.
 * n ≥ 1; a closed circle needs at least 3 (inscribed) or 4 (circumscribed) so that even a
 * circle below the tolerance stays a polygon of about its size.
 */
export function arcSegments(
  radius: number,
  sweep: number,
  tolerance = CHORD_TOLERANCE,
  mode: FlattenMode = 'inscribed',
): number {
  const closed = sweep >= 2 * Math.PI - 1e-12
  const minimum = closed ? (mode === 'inscribed' ? 3 : 4) : 1
  if (radius <= 0) return minimum
  const half =
    mode === 'inscribed'
      ? Math.acos(Math.max(-1, 1 - tolerance / radius))
      : Math.acos(radius / (radius + tolerance))
  // tiny slack: an exact multiple must not round up to one extra segment
  return Math.max(minimum, Math.ceil(sweep / (2 * half) - 1e-9))
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
    return arcSegments(radius, e.sweep, tolerance, mode)
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

/** A point on a contour with its inward unit normal and the element it lies on. */
export interface ContourFrame {
  readonly point: Vec2
  readonly normal: Vec2
  /** Index into `contourElements(c)`. */
  readonly element: number
  /** Distance along that element from its start, and its length. */
  readonly along: number
  readonly length: number
}

/**
 * Frame at arc length `s` from the start of `wall[0]` (wraps). At a sharp corner (a zero-length
 * arc) the preceding wall's end is used. A contour of zero perimeter has no frame.
 */
export function contourFrame(c: Contour, s: number): Option<ContourFrame> {
  const els = contourElements(c)
  const lengths = els.map(elementLength)
  const total = lengths.reduce((a, b) => a + b, 0)
  if (total <= 0) return None
  const u = ((s % total) + total) % total
  let acc = 0
  let last = -1
  for (let i = 0; i < els.length; i++) {
    const len = lengths[i]!
    if (len > 0) last = i
    if (len > 0 && u <= acc + len + 1e-12) return Some(frameOn(els[i]!, i, u - acc, len))
    acc += len
  }
  return Some(frameOn(els[last]!, last, lengths[last]!, lengths[last]!))
}

function frameOn(e: ContourElement, element: number, at: number, length: number): ContourFrame {
  const along = Math.min(length, Math.max(0, at))
  const f = along / length
  const point = elementPoint(e, f)
  if (e.kind === 'line') {
    const dx = (e.to[0] - e.from[0]) / length
    const dy = (e.to[1] - e.from[1]) / length
    // left of the direction is inward on a counter-clockwise contour
    return { point, normal: [-dy, dx], element, along, length }
  }
  const a = e.start + e.sweep * f
  return { point, normal: [-Math.cos(a), -Math.sin(a)], element, along, length }
}

/** Arc length (from the start of `wall[0]`) of the contour point nearest to `q`. */
export function contourParam(c: Contour, q: Vec2): number {
  let best = Infinity
  let param = 0
  let acc = 0
  for (const e of contourElements(c)) {
    const len = elementLength(e)
    let f: number
    if (e.kind === 'line') {
      const dx = e.to[0] - e.from[0]
      const dy = e.to[1] - e.from[1]
      const l2 = dx * dx + dy * dy
      f = l2 === 0 ? 0 : ((q[0] - e.from[0]) * dx + (q[1] - e.from[1]) * dy) / l2
    } else {
      let a = Math.atan2(q[1] - e.center[1], q[0] - e.center[0]) - e.start
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      f = e.sweep === 0 ? 0 : a / e.sweep
    }
    f = Math.min(1, Math.max(0, f))
    const p = elementPoint(e, f)
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d < best - 1e-12) {
      best = d
      param = acc + f * len
    }
    acc += len
  }
  return param
}

/**
 * Open sub-path of the contour offset by `offset`, between arc lengths `from` < `to` measured
 * along the un-offset contour from the start of `wall[0]` (wraps past the perimeter). Points
 * correspond across offsets by element parameter. Inscribed flattening.
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
