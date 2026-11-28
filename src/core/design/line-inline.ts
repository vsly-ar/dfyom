/**
 * A Line's inline Straight / Arc path (DF147 SL2) as geometry: the one open path the Line's
 * generators take, in the `on` face's frame, placed as a named shape's (relative to the centre of
 * its bounding box), plus the arc's read-outs (radius, sweep).
 * Doc: docs/modes/engraved-patterns.md#simple-line-straight-and-arc-hardening-df147
 */
import { arc, chainBounds, line, type Element } from '../geometry/2d/model'
import type { Shape as ShapeGeometry, Vec2 } from '../geometry/model'
import type { InlineLinePath, Point } from './operation'

/** Shorter than this (mm) a segment, or an arc's chord, is refused (`lineTooShort`). */
export const INLINE_MIN_LENGTH = 0.01

const mm = (p: Point): Vec2 => [p[0].canonical, p[1].canonical]

/** The circle through three points, or undefined when they are (nearly) collinear. */
export function circleThrough(
  a: Vec2,
  b: Vec2,
  c: Vec2,
): { centre: Vec2; radius: number; ccw: boolean } | undefined {
  const bx = b[0] - a[0]
  const by = b[1] - a[1]
  const cx = c[0] - a[0]
  const cy = c[1] - a[1]
  const d = 2 * (bx * cy - by * cx)
  // collinear: the cross product is tiny against the chord lengths
  const scale = Math.hypot(bx, by) * Math.hypot(cx, cy)
  if (scale === 0 || Math.abs(d) <= 1e-9 * scale) return undefined
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (cy * b2 - by * c2) / d
  const uy = (bx * c2 - cx * b2) / d
  // a → b → c counter-clockwise when b lies left of a → c
  return { centre: [a[0] + ux, a[1] + uy], radius: Math.hypot(ux, uy), ccw: d > 0 }
}

/** The arc's radius (mm) and sweep (°, 0–360) from start through `through` to end. */
export function arcReadout(
  start: Vec2,
  through: Vec2,
  end: Vec2,
): { radius: number; sweep: number } | undefined {
  const c = circleThrough(start, through, end)
  if (c === undefined) return undefined
  const ang = (p: Vec2) => Math.atan2(p[1] - c.centre[1], p[0] - c.centre[0])
  let s = ang(end) - ang(start)
  if (c.ccw) s = s <= 0 ? s + 2 * Math.PI : s
  else s = s >= 0 ? 2 * Math.PI - s : -s
  return { radius: c.radius, sweep: (s * 180) / Math.PI }
}

/** The inline path's element in the face frame (mm); undefined for a degenerate one. */
export function inlineElement(p: InlineLinePath): Element | undefined {
  const s = mm(p.start)
  const e = mm(p.end)
  if (Math.hypot(e[0] - s[0], e[1] - s[1]) < INLINE_MIN_LENGTH) return undefined
  if (p.kind === 'segment') return line(s, e)
  const c = circleThrough(s, mm(p.through), e)
  return c === undefined ? undefined : arc(s, e, c.centre, c.ccw)
}

/**
 * The inline path as a shape geometry: one open path relative to the centre of its bounding box,
 * as a named shape is placed (`placeShape`), so the Line's generators see the same input.
 */
export function inlineGeometry(p: InlineLinePath): ShapeGeometry | undefined {
  const el = inlineElement(p)
  if (el === undefined) return undefined
  const b = chainBounds([el])!
  const c: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  const rel = (q: Vec2): Vec2 => [q[0] - c[0], q[1] - c[1]]
  const local: Element =
    el.kind === 'line'
      ? line(rel(el.a), rel(el.b))
      : arc(rel(el.a), rel(el.b), rel(el.centre), el.ccw)
  return { center: c, contour: { kind: 'path', path: { elements: [local] } } }
}

/** The inline path's bounds in the face frame (mm); its points' for a degenerate one. */
export function inlineBounds(p: InlineLinePath): { min: Vec2; max: Vec2 } {
  const el = inlineElement(p)
  const b = el === undefined ? undefined : chainBounds([el])
  if (b !== undefined) return b
  const s = mm(p.start)
  const e = mm(p.end)
  return {
    min: [Math.min(s[0], e[0]), Math.min(s[1], e[1])],
    max: [Math.max(s[0], e[0]), Math.max(s[1], e[1])],
  }
}
