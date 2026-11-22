/**
 * Intersections of two 2D elements (lines and circular arcs) for the SVG import's fill repair:
 * crossing and touching points with the parameter on each element, and the ends of collinear or
 * concentric overlaps. Pure TS on the analytic elements.
 * Doc: docs/architecture/shapes.md#svg-import
 */
import type { Vec2 } from '../../geometry/model'
import { arcRadius, arcSweep, type Element } from '../../geometry/2d/model'

/** A common point; `s` and `t` are the parameters (0…1) on the first and second element. */
export interface Hit {
  readonly p: Vec2
  readonly s: number
  readonly t: number
}

/** Points closer than this (mm) are one point. */
export const HIT_EPSILON = 1e-7

const TAU = 2 * Math.PI

/** Parameter (0…1, may fall outside) of point `p` projected onto element `e`. */
export function paramOn(e: Element, p: Vec2): number {
  if (e.kind === 'line') {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const l2 = dx * dx + dy * dy
    return l2 === 0 ? 0 : ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / l2
  }
  const sweep = arcSweep(e)
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const ang = Math.atan2(p[1] - e.centre[1], p[0] - e.centre[0])
  let rel = sweep >= 0 ? ang - a0 : a0 - ang
  rel = ((rel % TAU) + TAU) % TAU
  const s = Math.abs(sweep)
  // angles just before the start come back near 2π: map them below 0 when closer to the start
  if (rel > s && rel - s > TAU - rel) rel -= TAU
  return rel / s
}

/** Whether parameter `u` lies on the element (with a tolerance of `HIT_EPSILON` in length). */
function onElement(e: Element, u: number): boolean {
  const l =
    e.kind === 'line'
      ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
      : arcRadius(e) * Math.abs(arcSweep(e))
  const eps = l > 0 ? HIT_EPSILON / l : 0
  return u >= -eps && u <= 1 + eps
}

const clamp01 = (u: number): number => Math.min(1, Math.max(0, u))

function hit(e: Element, f: Element, p: Vec2, out: Hit[]): void {
  const s = paramOn(e, p)
  const t = paramOn(f, p)
  if (!onElement(e, s) || !onElement(f, t)) return
  for (const h of out) if (Math.hypot(h.p[0] - p[0], h.p[1] - p[1]) <= HIT_EPSILON) return
  out.push({ p, s: clamp01(s), t: clamp01(t) })
}

/** Every common point of `e` and `f` (overlaps give the overlap's end points). */
export function intersect(e: Element, f: Element): Hit[] {
  const out: Hit[] = []
  if (e.kind === 'line' && f.kind === 'line') lineLine(e.a, e.b, f.a, f.b, e, f, out)
  else if (e.kind === 'line' && f.kind === 'arc')
    lineCircle(e, f, f.centre, arcRadius(f), e, f, out)
  else if (e.kind === 'arc' && f.kind === 'line')
    lineCircle(f, e, e.centre, arcRadius(e), e, f, out)
  else if (e.kind === 'arc' && f.kind === 'arc') circleCircle(e, f, out)
  return out
}

function overlapEnds(e: Element, f: Element, out: Hit[]): void {
  hit(e, f, f.a, out)
  hit(e, f, f.b, out)
  hit(e, f, e.a, out)
  hit(e, f, e.b, out)
}

function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2, e: Element, f: Element, out: Hit[]): void {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const den = rx * sy - ry * sx
  const lr = Math.hypot(rx, ry)
  const ls = Math.hypot(sx, sy)
  if (lr === 0 || ls === 0) return
  const qx = c[0] - a[0]
  const qy = c[1] - a[1]
  if (Math.abs(den) <= 1e-12 * lr * ls) {
    // parallel: overlap when collinear
    const off = Math.abs(qx * ry - qy * rx) / lr
    if (off <= HIT_EPSILON) overlapEnds(e, f, out)
    return
  }
  const u = (qx * sy - qy * sx) / den
  hit(e, f, [a[0] + rx * u, a[1] + ry * u], out)
}

function lineCircle(
  l: Element,
  arcEl: Element,
  c: Vec2,
  r: number,
  e: Element,
  f: Element,
  out: Hit[],
): void {
  const dx = l.b[0] - l.a[0]
  const dy = l.b[1] - l.a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0 || arcEl.kind !== 'arc') return
  const ux = dx / len
  const uy = dy / len
  // foot of the perpendicular from the centre
  const t0 = (c[0] - l.a[0]) * ux + (c[1] - l.a[1]) * uy
  const fx = l.a[0] + ux * t0
  const fy = l.a[1] + uy * t0
  const h = Math.hypot(c[0] - fx, c[1] - fy)
  if (h > r + HIT_EPSILON) return
  if (h >= r - HIT_EPSILON) {
    hit(e, f, [fx, fy], out)
    return
  }
  const k = Math.sqrt(r * r - h * h)
  hit(e, f, [fx - ux * k, fy - uy * k], out)
  hit(e, f, [fx + ux * k, fy + uy * k], out)
}

function circleCircle(e: Element, f: Element, out: Hit[]): void {
  if (e.kind !== 'arc' || f.kind !== 'arc') return
  const r1 = arcRadius(e)
  const r2 = arcRadius(f)
  const dx = f.centre[0] - e.centre[0]
  const dy = f.centre[1] - e.centre[1]
  const d = Math.hypot(dx, dy)
  if (d <= HIT_EPSILON && Math.abs(r1 - r2) <= HIT_EPSILON) {
    overlapEnds(e, f, out)
    return
  }
  if (d === 0 || d > r1 + r2 + HIT_EPSILON || d < Math.abs(r1 - r2) - HIT_EPSILON) return
  const a = (d * d + r1 * r1 - r2 * r2) / (2 * d)
  const h2 = r1 * r1 - a * a
  const mx = e.centre[0] + (dx * a) / d
  const my = e.centre[1] + (dy * a) / d
  if (h2 <= (HIT_EPSILON * Math.max(1, r1)) ** 2) {
    hit(e, f, [mx, my], out)
    return
  }
  const h = Math.sqrt(h2)
  hit(e, f, [mx - (dy * h) / d, my + (dx * h) / d], out)
  hit(e, f, [mx + (dy * h) / d, my - (dx * h) / d], out)
}
