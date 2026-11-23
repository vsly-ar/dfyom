/**
 * Measures on the analytic elements, exact for lines and arcs (no library involved): lengths,
 * points at a distance along a chain, closest points and point containment.
 * Doc: docs/architecture/shapes.md#2d-port
 */
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../model'
import {
  arcRadius,
  arcSweep,
  elementLength,
  onSweep,
  POSITION_EPSILON,
  type Element,
  type Loop,
  type Region,
} from './model'
import { region2dError } from './wire'

/** Total length of a chain (loop or path). */
export function chainLength(c: Loop): number {
  let s = 0
  for (const e of c.elements) s += elementLength(e)
  return s
}

/** A point on a chain with its unit tangent (direction of travel) and element index. */
export interface ChainPoint {
  readonly point: Vec2
  readonly tangent: Vec2
  readonly element: number
}

/** The point at parameter `t` ∈ [0, 1] of an element, with its unit tangent. */
export function elementPointAt(e: Element, t: number): { point: Vec2; tangent: Vec2 } {
  if (e.kind === 'line') {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const len = Math.hypot(dx, dy)
    return {
      point: [e.a[0] + dx * t, e.a[1] + dy * t],
      tangent: len > 0 ? [dx / len, dy / len] : [1, 0],
    }
  }
  const r = arcRadius(e)
  const sweep = arcSweep(e)
  const ang = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0]) + sweep * t
  const s = sweep >= 0 ? 1 : -1
  return {
    point: [e.centre[0] + r * Math.cos(ang), e.centre[1] + r * Math.sin(ang)],
    tangent: [-Math.sin(ang) * s, Math.cos(ang) * s],
  }
}

/**
 * The point at distance `s` along a chain from its start. A loop wraps (`s` modulo its length);
 * a path refuses `s` outside [0, length] (rule `outOfRange`).
 */
export function chainPointAt(c: Loop, s: number, closed: boolean): AppResult<ChainPoint> {
  const where = 'region2d.pointAt'
  if (c.elements.length === 0)
    return Err(region2dError('empty', 'the chain has no elements', where))
  if (!Number.isFinite(s))
    return Err(region2dError('notFinite', 'the distance is not finite', where))
  const total = chainLength(c)
  let rest = s
  if (closed) rest = total > 0 ? ((s % total) + total) % total : 0
  else if (s < -POSITION_EPSILON || s > total + POSITION_EPSILON)
    return Err(
      region2dError('outOfRange', 'the distance lies outside the path', where, {
        s,
        length: total,
      }),
    )
  rest = Math.min(Math.max(rest, 0), total)
  for (let i = 0; i < c.elements.length; i++) {
    const e = c.elements[i]!
    const len = elementLength(e)
    if (rest <= len || i === c.elements.length - 1) {
      const p = elementPointAt(e, len > 0 ? Math.min(rest / len, 1) : 0)
      return Ok({ ...p, element: i })
    }
    rest -= len
  }
  return Err(region2dError('empty', 'the chain has no elements', where))
}

/**
 * `chainPointAt` for many distances along one chain (the tab hold test samples a loop every
 * 0.25 mm): the element lengths and their running sums are taken once and each point is found by
 * a binary search, O(log n) instead of O(n) per point (hardening P5). Same rules and errors; a
 * point may differ from `chainPointAt`'s in the last bits (sums instead of a running difference).
 */
export function chainSampler(c: Loop, closed: boolean): (s: number) => AppResult<ChainPoint> {
  const where = 'region2d.pointAt'
  const n = c.elements.length
  const lengths = c.elements.map(elementLength)
  // starts[i]: the distance at which element i starts, summed in order as chainLength sums
  const starts = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    starts[i] = total
    total += lengths[i]!
  }
  return (s) => {
    if (n === 0) return Err(region2dError('empty', 'the chain has no elements', where))
    if (!Number.isFinite(s))
      return Err(region2dError('notFinite', 'the distance is not finite', where))
    let rest = s
    if (closed) rest = total > 0 ? ((s % total) + total) % total : 0
    else if (s < -POSITION_EPSILON || s > total + POSITION_EPSILON)
      return Err(
        region2dError('outOfRange', 'the distance lies outside the path', where, {
          s,
          length: total,
        }),
      )
    rest = Math.min(Math.max(rest, 0), total)
    // the first element that ends at or beyond `rest` (else the last one), as chainPointAt walks
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rest - starts[mid]! <= lengths[mid]!) hi = mid
      else lo = mid + 1
    }
    const len = lengths[lo]!
    const t = len > 0 ? Math.min(Math.max((rest - starts[lo]!) / len, 0), 1) : 0
    return Ok({ ...elementPointAt(c.elements[lo]!, t), element: lo })
  }
}

/** Closest point of an element to `p`. */
export function elementClosest(e: Element, p: Vec2): Vec2 {
  if (e.kind === 'line') {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const len2 = dx * dx + dy * dy
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / len2))
    return [e.a[0] + dx * t, e.a[1] + dy * t]
  }
  const r = arcRadius(e)
  const ang = Math.atan2(p[1] - e.centre[1], p[0] - e.centre[0])
  const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  if (onSweep(start, arcSweep(e), ang))
    return [e.centre[0] + r * Math.cos(ang), e.centre[1] + r * Math.sin(ang)]
  const da = Math.hypot(p[0] - e.a[0], p[1] - e.a[1])
  const db = Math.hypot(p[0] - e.b[0], p[1] - e.b[1])
  return da <= db ? e.a : e.b
}

/** The closest boundary point of some chains to `p`. */
export interface Closest {
  readonly distance: number
  readonly point: Vec2
  /** Index of the chain in the list given, and of the element in it. */
  readonly chain: number
  readonly element: number
}

/** Closest point on any of `chains`; undefined when they have no elements. */
export function closestOnChains(chains: readonly Loop[], p: Vec2): Closest | undefined {
  let best: Closest | undefined
  chains.forEach((c, ci) =>
    c.elements.forEach((e, ei) => {
      const q = elementClosest(e, p)
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (best === undefined || d < best.distance)
        best = { distance: d, point: q, chain: ci, element: ei }
    }),
  )
  return best
}

/**
 * Winding number of a closed loop around `p` (counter-clockwise positive), exact for arcs: the
 * signed angle each element sweeps as seen from `p`. Undefined for points on the loop.
 */
export function windingNumber(l: Loop, p: Vec2): number {
  let total = 0
  for (const e of l.elements) total += sweptAngle(e, p)
  return Math.round(total / (2 * Math.PI))
}

function angleBetween(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = a[0] - p[0]
  const ay = a[1] - p[1]
  const bx = b[0] - p[0]
  const by = b[1] - p[1]
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

/** The angle the element sweeps as seen from `p`. */
function sweptAngle(e: Element, p: Vec2): number {
  if (e.kind === 'line') return angleBetween(p, e.a, e.b)
  // pieces of at most a quarter turn. Outside the circle each sweeps its chord's angle; inside,
  // the direction to a point running along the circle turns one way only, so each sweeps its
  // chord's angle taken the arc's way round, in (0, 2π) or (−2π, 0): a point on a chord (the
  // chord's angle ±π by the sign of a zero) sees half a turn the arc's way
  const sweep = arcSweep(e)
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const r = arcRadius(e)
  const inCircle = Math.hypot(p[0] - e.centre[0], p[1] - e.centre[1]) < r
  let s = 0
  let prev = e.a
  for (let k = 1; k <= pieces; k++) {
    const q = k === pieces ? e.b : elementPointAt(e, k / pieces).point
    const c = angleBetween(p, prev, q)
    s += !inCircle ? c : sweep > 0 ? (c > 0 ? c : c + 2 * Math.PI) : c < 0 ? c : c - 2 * Math.PI
    prev = q
  }
  return s
}

/** Whether `p` lies within `eps` of the loop. */
export function onLoop(l: Loop, p: Vec2, eps = POSITION_EPSILON): boolean {
  const c = closestOnChains([l], p)
  return c !== undefined && c.distance <= eps
}

/** Whether `p` lies in the region; points on its boundary (within `POSITION_EPSILON`) count. */
export function regionContains(r: Region, p: Vec2): boolean {
  for (const piece of r.pieces) {
    if (onLoop(piece.outer, p)) return true
    if (windingNumber(piece.outer, p) === 0) continue
    let inHole = false
    for (const h of piece.holes) {
      if (onLoop(h, p)) return true
      if (windingNumber(h, p) !== 0) inHole = true
    }
    if (!inHole) return true
  }
  return false
}
