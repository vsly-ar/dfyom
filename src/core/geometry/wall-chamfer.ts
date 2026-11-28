/**
 * One-sided chamfer along a through Line (DF147 SL4): the paths a V-bit's axis follows along the
 * slot's wall on the side that stays. The wall is the Line's centre element offset by the slot's
 * half width toward `side`; a cone whose axis runs at `d` from the centre element, its tip `z`
 * deep, bevels that wall only (the slot is air on the other side). Open ends (on or past the face's
 * edge) run on along the tangent to the face's edge, as the slot's own lead does; an inner end is
 * shortened by the cone's reach at the face, so the cone never passes the slot's round end (round
 * ends are not chamfered). Pure, headless; shared by the removal solid and the toolpath.
 * Doc: docs/modes/engraved-patterns.md#one-sided-chamfer-along-a-line
 */
import type { Element } from './2d/model'
import type { Vec2 } from './model'

/** The side of a path, from its start to its end, that stays (`edgeSide`). */
export type EdgeSide = 'left' | 'right'

/** A one-sided chamfer's wall: the slot's centre element (face frame), half width, kept side. */
export interface ChamferWall {
  readonly element: Element
  /** Half the slot's width at the face (mm). */
  readonly halfWidth: number
  readonly side: EdgeSide
}

const EPS = 1e-6

const insideRect = (p: Vec2, L: number, W: number): boolean =>
  p[0] > EPS && p[0] < L - EPS && p[1] > EPS && p[1] < W - EPS

/** Distance along unit `t` from `p` (inside the rectangle) to its edge. */
function exitDistance(p: Vec2, t: Vec2, L: number, W: number): number {
  let best = Infinity
  const bounds: [number, number][] = [
    [0, L],
    [0, W],
  ]
  for (let i = 0; i < 2; i++) {
    const [lo, hi] = bounds[i]!
    if (t[i]! > EPS) best = Math.min(best, (hi - p[i]!) / t[i]!)
    else if (t[i]! < -EPS) best = Math.min(best, (lo - p[i]!) / t[i]!)
  }
  return Number.isFinite(best) ? Math.max(0, best) : 0
}

/** Unit tangent along `e` at its start (`u` = 0) or end (`u` = 1). */
function tangent(e: Element, u: 0 | 1): Vec2 {
  if (e.kind === 'line') {
    const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
    return [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l]
  }
  const p = u === 0 ? e.a : e.b
  const r: Vec2 = [p[0] - e.centre[0], p[1] - e.centre[1]]
  const l = Math.hypot(r[0], r[1])
  return e.ccw ? [-r[1] / l, r[0] / l] : [r[1] / l, -r[0] / l]
}

const angleOf = (c: Vec2, p: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0])
const polar = (c: Vec2, r: number, a: number): Vec2 => [
  c[0] + r * Math.cos(a),
  c[1] + r * Math.sin(a),
]

/** The element offset by `s` (> 0 left of its direction), undefined for an arc shrunk to nothing. */
function offset(e: Element, s: number): Element | undefined {
  if (e.kind === 'line') {
    const t = tangent(e, 0)
    const n: Vec2 = [-t[1] * s, t[0] * s]
    return { kind: 'line', a: [e.a[0] + n[0], e.a[1] + n[1]], b: [e.b[0] + n[0], e.b[1] + n[1]] }
  }
  const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
  // left of a counter-clockwise arc is its centre
  const r2 = e.ccw ? r - s : r + s
  if (!(r2 > EPS)) return undefined
  return {
    kind: 'arc',
    a: polar(e.centre, r2, angleOf(e.centre, e.a)),
    b: polar(e.centre, r2, angleOf(e.centre, e.b)),
    centre: e.centre,
    ccw: e.ccw,
  }
}

/** Sweep of an arc along its direction (rad, > 0). */
function sweepOf(e: Extract<Element, { kind: 'arc' }>): number {
  let s = e.ccw
    ? angleOf(e.centre, e.b) - angleOf(e.centre, e.a)
    : angleOf(e.centre, e.a) - angleOf(e.centre, e.b)
  while (s <= EPS) s += 2 * Math.PI
  return s
}

/** `e` shortened by `t0` at its start and `t1` at its end (the cone's reach); undefined if gone. */
function trimmed(e: Element, t0: number, t1: number): Element | undefined {
  if (t0 <= 0 && t1 <= 0) return e
  if (e.kind === 'line') {
    const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
    if (t0 + t1 >= l - EPS) return undefined
    const t = tangent(e, 0)
    return {
      kind: 'line',
      a: [e.a[0] + t[0] * t0, e.a[1] + t[1] * t0],
      b: [e.b[0] - t[0] * t1, e.b[1] - t[1] * t1],
    }
  }
  const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
  // the cone's disc clears the radial line through the end: r · sin θ ≥ reach
  const angle = (t: number): number | undefined =>
    t <= 0 ? 0 : t >= r ? undefined : Math.asin(t / r)
  const a0 = angle(t0)
  const a1 = angle(t1)
  if (a0 === undefined || a1 === undefined || a0 + a1 >= sweepOf(e) - EPS) return undefined
  const dir = e.ccw ? 1 : -1
  return {
    ...e,
    a: polar(e.centre, r, angleOf(e.centre, e.a) + dir * a0),
    b: polar(e.centre, r, angleOf(e.centre, e.b) - dir * a1),
  }
}

/**
 * The axis path at `d` from the centre element toward the kept side (face frame, start to end), on
 * a face `length` × `width`: an open end runs on along the tangent to the face's edge, an inner
 * end is shortened by `reach` (the cone's radius at the face). Undefined when nothing is left.
 */
export function wallPath(
  wall: ChamferWall,
  d: number,
  reach: number,
  face: { readonly length: number; readonly width: number },
): Element[] | undefined {
  const { length: L, width: W } = face
  const e = wall.element
  const open0 = !insideRect(e.a, L, W)
  const open1 = !insideRect(e.b, L, W)
  const s = wall.side === 'left' ? d : -d
  const o = offset(e, s)
  if (o === undefined) return undefined
  const core = trimmed(o, open0 ? 0 : reach, open1 ? 0 : reach)
  if (core === undefined) return undefined
  const out: Element[] = [core]
  if (open0) {
    const t = tangent(core, 0)
    const back: Vec2 = [-t[0], -t[1]]
    const l = insideRect(core.a, L, W) ? exitDistance(core.a, back, L, W) : 0
    if (l > EPS)
      out.unshift({
        kind: 'line',
        a: [core.a[0] + back[0] * l, core.a[1] + back[1] * l],
        b: core.a,
      })
  }
  if (open1) {
    const t = tangent(core, 1)
    const l = insideRect(core.b, L, W) ? exitDistance(core.b, t, L, W) : 0
    if (l > EPS)
      out.push({ kind: 'line', a: core.b, b: [core.b[0] + t[0] * l, core.b[1] + t[1] * l] })
  }
  return out
}

/** Depth of the bevel below the face: width / tan(α / 2) (mm). */
export const wallChamferDepth = (c: { readonly width: number; readonly angle: number }): number =>
  c.width / Math.tan(((c.angle / 2) * Math.PI) / 180)

/** The wall chamfer's bounds on its face: the centre element grown by half the slot and the width. */
export function wallBounds(
  wall: ChamferWall,
  width: number,
): { readonly min: Vec2; readonly max: Vec2 } {
  const e = wall.element
  const pts: Vec2[] = [e.a, e.b]
  if (e.kind === 'arc') {
    const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
    const a0 = angleOf(e.centre, e.a)
    const sweep = sweepOf(e)
    for (let k = 1; k < 32; k++)
      pts.push(polar(e.centre, r, a0 + ((e.ccw ? 1 : -1) * sweep * k) / 32))
  }
  const g = wall.halfWidth + width
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    min: [Math.min(...xs) - g, Math.min(...ys) - g],
    max: [Math.max(...xs) + g, Math.max(...ys) + g],
  }
}

/**
 * The bevel's band on the face (the wall out to `width` on the kept side, arcs as chords) as a
 * counter-clockwise polygon: what the flat-patch check counts as cut.
 */
export function wallBand(wall: ChamferWall, width: number): Vec2[] | undefined {
  const s = wall.side === 'left' ? 1 : -1
  const inner = offset(wall.element, s * wall.halfWidth)
  const outer = offset(wall.element, s * (wall.halfWidth + width))
  if (inner === undefined || outer === undefined) return undefined
  const pts = (e: Element): Vec2[] => {
    if (e.kind === 'line') return [e.a, e.b]
    const r = Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])
    const a0 = angleOf(e.centre, e.a)
    const sweep = sweepOf(e)
    const n = Math.max(2, Math.ceil(sweep / (Math.PI / 36)))
    return Array.from({ length: n + 1 }, (_, k) =>
      polar(e.centre, r, a0 + ((e.ccw ? 1 : -1) * sweep * k) / n),
    )
  }
  const poly = [...pts(inner), ...pts(outer).reverse()]
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += (poly[j]![0] - poly[i]![0]) * (poly[j]![1] + poly[i]![1])
  return a < 0 ? poly.reverse() : poly
}
