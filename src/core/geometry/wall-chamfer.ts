/**
 * One-sided chamfer along a groove (DF147 SL4, follow-up): the paths a V-bit's axis follows along
 * the groove's wall on the side that stays. The groove is a through Line's slot, a Line's groove
 * with a depth, or a profile `on`'s groove (`ChamferWall`). The wall is the groove's centre path
 * offset by its half width toward `side`; a cone whose axis runs at `d` from the centre path, its
 * tip `z` deep, bevels that wall only (the groove is air on the other side).
 *
 * A through Line's one element (`capped` absent): open ends (on or past the face's edge) run on
 * along the tangent to the face's edge, as the slot's own lead does; an inner end is shortened by
 * the cone's reach at the face, so the cone never passes the slot's round end.
 *
 * A chain (`capped`, `closed` or several elements): the centre path is offset with its corners
 * (a corner whose outside is the kept side is rounded about the corner, as the groove's wall is;
 * an inside corner is trimmed where the two offsets meet: the bevel is mitred there). Each end is
 * the groove's round cap: the axis stops short of it by as little as keeps the cone's disc out of
 * the stock beyond the end (up to the cone's reach: round ends are not chamfered; an end square on
 * the stock edge runs to the edge). Every axis point is checked to lie its distance `d` from the
 * whole centre path: a path that comes back within the groove of itself, or a curve tighter than
 * the offset, is refused (`WallRefusal`). With that, the cone never cuts below the bevel of the
 * kept wall (the depth it cuts at a point grows no faster than its distance to the wall), and it
 * reaches the groove's other wall only past `d` + the half width (the `otherWall` fit).
 * Pure, headless; shared by the removal solid, the flat-patch check and the toolpath.
 * Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
 */
import { elementClosest } from './2d/measure'
import { MIN_ELEMENT_LENGTH, type Element } from './2d/model'
import type { Vec2 } from './model'

/** The side of a path, from its start to its end, that stays (`edgeSide`). */
export type EdgeSide = 'left' | 'right'

/** A one-sided chamfer's wall: the groove's centre path (face frame), half width, kept side. */
export interface ChamferWall {
  /**
   * The groove's centre path, from its start to its end (one element for a Line); a closed loop
   * counter-clockwise (left is inside).
   */
  readonly elements: readonly Element[]
  /** A closed loop (a profile `on` along a closed shape): no ends. */
  readonly closed?: true
  /** Half the groove's width at the face (mm). */
  readonly halfWidth: number
  readonly side: EdgeSide
  /**
   * The groove's ends are its round caps inside the stock (a Line with a depth, a profile `on`);
   * absent: a through Line, whose slot leads out past the stock edge at its open ends.
   */
  readonly capped?: true
  /**
   * The groove's shallowest wall height below the face (mm): a blind groove's depth, a through
   * profile's above its tabs; the bevel must end above it. Absent: the groove is through.
   */
  readonly floor?: number
}

/** Why a wall cannot be chamfered safely (the toolpath's and the design's refusal text). */
export interface WallRefusal {
  readonly refused: 'tooTight' | 'selfNear'
  readonly message: string
}

export const isWallRefusal = (x: unknown): x is WallRefusal =>
  typeof x === 'object' && x !== null && 'refused' in x

const EPS = 1e-6
/** An axis point may lie this much nearer the centre path than `d` (mm). */
const NEAR_TOLERANCE = 1e-3

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
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const isFull = (e: Element): boolean => e.kind === 'arc' && e.a[0] === e.b[0] && e.a[1] === e.b[1]

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
  const a = polar(e.centre, r2, angleOf(e.centre, e.a))
  return {
    kind: 'arc',
    a,
    // a full circle stays one (its end exactly its start)
    b: isFull(e) ? a : polar(e.centre, r2, angleOf(e.centre, e.b)),
    centre: e.centre,
    ccw: e.ccw,
  }
}

/** Sweep of an arc along its direction (rad, > 0). */
function sweepOf(e: Extract<Element, { kind: 'arc' }>): number {
  if (isFull(e)) return 2 * Math.PI
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

/** Whether `p` lies on element `e` (within its extent; `p` near its line or circle). */
function within(e: Element, p: Vec2): boolean {
  if (e.kind === 'line') {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const l2 = dx * dx + dy * dy
    const u = ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / l2
    return u >= -EPS && u <= 1 + EPS
  }
  if (isFull(e)) return true
  const sweep = sweepOf(e)
  let s = e.ccw
    ? angleOf(e.centre, p) - angleOf(e.centre, e.a)
    : angleOf(e.centre, e.a) - angleOf(e.centre, p)
  while (s < -EPS) s += 2 * Math.PI
  while (s > 2 * Math.PI - EPS) s -= 2 * Math.PI
  return s <= sweep + EPS
}

/** Intersections of the lines / circles carrying `a` and `b`. */
function crossings(a: Element, b: Element): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const d1: Vec2 = [a.b[0] - a.a[0], a.b[1] - a.a[1]]
    const d2: Vec2 = [b.b[0] - b.a[0], b.b[1] - b.a[1]]
    const den = d1[0] * d2[1] - d1[1] * d2[0]
    if (Math.abs(den) < 1e-12) return []
    const u = ((b.a[0] - a.a[0]) * d2[1] - (b.a[1] - a.a[1]) * d2[0]) / den
    return [[a.a[0] + d1[0] * u, a.a[1] + d1[1] * u]]
  }
  if (a.kind === 'arc' && b.kind === 'line') return crossings(b, a)
  if (a.kind === 'line' && b.kind === 'arc') {
    const r = dist(b.a, b.centre)
    const d: Vec2 = [a.b[0] - a.a[0], a.b[1] - a.a[1]]
    const f: Vec2 = [a.a[0] - b.centre[0], a.a[1] - b.centre[1]]
    const A = d[0] * d[0] + d[1] * d[1]
    const B = 2 * (f[0] * d[0] + f[1] * d[1])
    const C = f[0] * f[0] + f[1] * f[1] - r * r
    const disc = B * B - 4 * A * C
    if (disc < 0) return []
    const q = Math.sqrt(disc)
    return [(-B - q) / (2 * A), (-B + q) / (2 * A)].map((u) => [
      a.a[0] + d[0] * u,
      a.a[1] + d[1] * u,
    ])
  }
  if (a.kind !== 'arc' || b.kind !== 'arc') return []
  const r0 = dist(a.a, a.centre)
  const r1 = dist(b.a, b.centre)
  const D = dist(a.centre, b.centre)
  if (D < 1e-12 || D > r0 + r1 || D < Math.abs(r0 - r1)) return []
  const x = (D * D + r0 * r0 - r1 * r1) / (2 * D)
  const h = Math.sqrt(Math.max(0, r0 * r0 - x * x))
  const u: Vec2 = [(b.centre[0] - a.centre[0]) / D, (b.centre[1] - a.centre[1]) / D]
  const m: Vec2 = [a.centre[0] + u[0] * x, a.centre[1] + u[1] * x]
  return [
    [m[0] - u[1] * h, m[1] + u[0] * h],
    [m[0] + u[1] * h, m[1] - u[0] * h],
  ]
}

/** `e` with its start (`atStart`) or end moved to `p` (on its line or circle). */
function moved(e: Element, p: Vec2, atStart: boolean): Element {
  return atStart ? { ...e, a: p } : { ...e, b: p }
}

const tooTight = (): WallRefusal => ({
  refused: 'tooTight',
  message: 'a curve or corner of the path is tighter than the groove and the bevel',
})

/**
 * The centre path offset by `s` (> 0 left) with its corners: rounded about the corner where the
 * offset side is the corner's outside, trimmed where the two offsets meet inside. A closed loop's
 * last joint joins its first element.
 */
function offsetChain(
  elements: readonly Element[],
  closed: boolean,
  s: number,
): Element[] | WallRefusal {
  const offs: Element[] = []
  for (const e of elements) {
    const o = offset(e, s)
    if (o === undefined) return tooTight()
    offs.push(o)
  }
  const n = offs.length
  // joints[i]: what joins offs[i] to offs[i + 1] (a corner arc), after trimming both
  const joins: (Element | undefined)[] = new Array<Element | undefined>(n).fill(undefined)
  const joints = closed ? n : n - 1
  for (let i = 0; i < joints; i++) {
    const j = (i + 1) % n
    if (n === 1 && closed) break
    const corner = elements[i]!.b
    const t0 = tangent(elements[i]!, 1)
    const t1 = tangent(elements[j]!, 0)
    const cross = t0[0] * t1[1] - t0[1] * t1[0]
    const dot = t0[0] * t1[0] + t0[1] * t1[1]
    if (Math.abs(cross) < 1e-9 && dot > 0) continue // tangent: the offsets meet
    if (Math.abs(cross) < 1e-9) return tooTight() // a reversal
    if (cross * s < 0) {
      // the kept side is the corner's outside: round it about the corner (the groove's wall)
      joins[i] = { kind: 'arc', a: offs[i]!.b, b: offs[j]!.a, centre: corner, ccw: cross > 0 }
      continue
    }
    // inside: trim both where they meet, nearest the corner
    const hits = crossings(offs[i]!, offs[j]!).filter(
      (p) => within(offs[i]!, p) && within(offs[j]!, p),
    )
    if (hits.length === 0) return tooTight()
    const p = hits.reduce((a, b) => (dist(a, corner) <= dist(b, corner) ? a : b))
    offs[i] = moved(offs[i]!, p, false)
    offs[j] = moved(offs[j]!, p, true)
  }
  const out: Element[] = []
  for (let i = 0; i < n; i++) {
    const o = offs[i]!
    // a trim that reversed or emptied an element: the corners overlap
    if (!isFull(o) && dist(o.a, o.b) < MIN_ELEMENT_LENGTH) {
      if (n > 1) return tooTight()
    }
    if (!isFull(o) && o.kind === 'line') {
      const t = tangent(elements[i]!, 0)
      if ((o.b[0] - o.a[0]) * t[0] + (o.b[1] - o.a[1]) * t[1] <= 0) return tooTight()
    }
    out.push(o)
    const c = joins[i]
    if (c !== undefined && dist(c.a, c.b) >= MIN_ELEMENT_LENGTH) out.push(c)
  }
  return out
}

/** Distance from `p` to the nearest point of `elements`. */
function chainDistance(elements: readonly Element[], p: Vec2): number {
  let best = Infinity
  for (const e of elements) best = Math.min(best, dist(p, elementClosest(e, p)))
  return best
}

/** Points along `e`, about every 0.25 mm (at least its ends and middle). */
function samples(e: Element): Vec2[] {
  if (e.kind === 'line') {
    const n = Math.max(2, Math.ceil(dist(e.a, e.b) / 0.25))
    return Array.from({ length: n + 1 }, (_, k): Vec2 => [
      e.a[0] + ((e.b[0] - e.a[0]) * k) / n,
      e.a[1] + ((e.b[1] - e.a[1]) * k) / n,
    ])
  }
  const r = dist(e.a, e.centre)
  const sweep = sweepOf(e)
  const n = Math.max(2, Math.ceil((sweep * r) / 0.25))
  const a0 = angleOf(e.centre, e.a)
  return Array.from({ length: n + 1 }, (_, k) =>
    polar(e.centre, r, a0 + ((e.ccw ? 1 : -1) * sweep * k) / n),
  )
}

/**
 * How far to shorten the axis at a capped end so that the cone's disc (radius `reach` at the
 * face) keeps out of the stock beyond the groove's end (past the line through the end `end`
 * square to its outward tangent `out`): 0 when the end is square on the stock edge, `reach` deep
 * inside the stock. `at(t)` is the axis end shortened by `t`. Sampled (the disc's rim every 1/64
 * turn, the stock's corners).
 */
function capTrim(
  at: (t: number) => Vec2 | undefined,
  end: Vec2,
  out: Vec2,
  reach: number,
  L: number,
  W: number,
): number {
  const beyond = (p: Vec2): boolean => (p[0] - end[0]) * out[0] + (p[1] - end[1]) * out[1] > 1e-9
  const clear = (t: number): boolean => {
    const c = at(t)
    if (c === undefined) return false
    for (let k = 0; k < 64; k++) {
      const p = polar(c, reach, (k * Math.PI) / 32)
      if (beyond(p) && insideRect(p, L, W)) return false
    }
    // the stock's corners, and the chord on the line through the end
    const corners: Vec2[] = [
      [0, 0],
      [L, 0],
      [L, W],
      [0, W],
    ]
    for (const q of corners) if (beyond(q) && dist(q, c) < reach - EPS) return false
    const off = (end[0] - c[0]) * out[0] + (end[1] - c[1]) * out[1]
    if (off >= reach) return true
    const half = Math.sqrt(Math.max(0, reach * reach - off * off))
    const foot: Vec2 = [c[0] + out[0] * (off + 1e-7), c[1] + out[1] * (off + 1e-7)]
    for (let k = -7; k <= 7; k++) {
      const p: Vec2 = [foot[0] - out[1] * ((half * k) / 8), foot[1] + out[0] * ((half * k) / 8)]
      if (insideRect(p, L, W)) return false
    }
    return true
  }
  if (clear(0)) return 0
  if (!clear(reach)) return reach
  let lo = 0
  let hi = reach
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (clear(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * The axis path at `d` from the centre path toward the kept side (face frame, start to end), on a
 * face `length` × `width`, the cone `reach` wide at the face: see the module comment. Undefined
 * when nothing is left; a `WallRefusal` when the path cannot be followed safely.
 */
export function wallPath(
  wall: ChamferWall,
  d: number,
  reach: number,
  face: { readonly length: number; readonly width: number },
): Element[] | undefined | WallRefusal {
  const { length: L, width: W } = face
  if (wall.capped !== true && wall.closed !== true && wall.elements.length === 1)
    return slotPath(wall.elements[0]!, wall.side === 'left' ? d : -d, reach, L, W)
  if (!(d > EPS)) return tooTight()
  const s = wall.side === 'left' ? d : -d
  const chain = offsetChain(wall.elements, wall.closed === true, s)
  if (isWallRefusal(chain)) return chain
  let out = chain
  if (wall.closed !== true) {
    const first = wall.elements[0]!
    const last = wall.elements.at(-1)!
    const t0 = tangent(first, 0)
    const t1 = tangent(last, 1)
    const head = out[0]!
    const tail = out.at(-1)!
    const trim0 = capTrim((t) => trimmed(head, t, 0)?.a, first.a, [-t0[0], -t0[1]], reach, L, W)
    const trim1 = capTrim((t) => trimmed(tail, 0, t)?.b, last.b, t1, reach, L, W)
    if (out.length === 1) {
      const one = trimmed(head, trim0, trim1)
      if (one === undefined) return undefined
      out = [one]
    } else {
      const h = trimmed(head, trim0, 0)
      const t = trimmed(tail, 0, trim1)
      if (h === undefined || t === undefined) return undefined
      out = [h, ...out.slice(1, -1), t]
    }
  }
  // every axis point lies `d` from the whole centre path: none comes near another part of it
  for (const e of out)
    for (const p of samples(e))
      if (chainDistance(wall.elements, p) < d - NEAR_TOLERANCE)
        return {
          refused: 'selfNear',
          message: 'the path comes back too close to itself for a one-sided chamfer',
        }
  return out
}

/** A through Line's slot wall (one element): see the module comment. */
function slotPath(
  e: Element,
  s: number,
  reach: number,
  L: number,
  W: number,
): Element[] | undefined {
  const open0 = !insideRect(e.a, L, W)
  const open1 = !insideRect(e.b, L, W)
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

/** Points along `e` (arcs every 1/64 turn at most 32 pieces), its start first. */
function outlinePoints(e: Element, pieces: number): Vec2[] {
  if (e.kind === 'line') return [e.a, e.b]
  const r = dist(e.a, e.centre)
  const a0 = angleOf(e.centre, e.a)
  const sweep = sweepOf(e)
  const n = Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * pieces))
  return Array.from({ length: n + 1 }, (_, k) =>
    polar(e.centre, r, a0 + ((e.ccw ? 1 : -1) * sweep * k) / n),
  )
}

/** The wall chamfer's bounds on its face: the centre path grown by half the groove and the width. */
export function wallBounds(
  wall: ChamferWall,
  width: number,
): { readonly min: Vec2; readonly max: Vec2 } {
  const pts: Vec2[] = []
  for (const e of wall.elements)
    if (e.kind === 'line') pts.push(e.a, e.b)
    else {
      // 33 points over the sweep (as SL4 measured a Line's one arc)
      const r = dist(e.a, e.centre)
      const a0 = angleOf(e.centre, e.a)
      const sweep = sweepOf(e)
      pts.push(e.a, e.b)
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

/** A polygon's points counter-clockwise. */
function ccwPoly(poly: Vec2[]): Vec2[] {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += (poly[j]![0] - poly[i]![0]) * (poly[j]![1] + poly[i]![1])
  return a < 0 ? poly.reverse() : poly
}

/**
 * The bevel's band on the face (the wall out to `width` on the kept side, arcs as chords): what
 * the flat-patch check counts as cut. One counter-clockwise polygon along a path; along a closed
 * loop an outer polygon and its hole (clockwise). Undefined when an offset fails.
 */
export function wallBand(
  wall: ChamferWall,
  width: number,
): { readonly outer: Vec2[]; readonly hole?: Vec2[] } | undefined {
  const s = wall.side === 'left' ? 1 : -1
  const chainAt = (d: number): Element[] | undefined => {
    if (wall.elements.length === 1 && wall.closed !== true) {
      const o = offset(wall.elements[0]!, s * d)
      return o === undefined ? undefined : [o]
    }
    const c = offsetChain(wall.elements, wall.closed === true, s * d)
    return isWallRefusal(c) ? undefined : c
  }
  const inner = chainAt(wall.halfWidth)
  const outer = chainAt(wall.halfWidth + width)
  if (inner === undefined || outer === undefined) return undefined
  const pts = (es: readonly Element[]): Vec2[] => {
    const all: Vec2[] = []
    for (const e of es) {
      const p = e.kind === 'line' ? [e.a, e.b] : outlinePoints(e, 72)
      for (const q of p) if (all.length === 0 || dist(all.at(-1)!, q) > 1e-9) all.push(q)
    }
    return all
  }
  if (wall.closed !== true) return { outer: ccwPoly([...pts(inner), ...pts(outer).reverse()]) }
  // inside (left of the counter-clockwise loop) the inner offset is the larger loop
  const a = ccwPoly(pts(inner))
  const b = ccwPoly(pts(outer))
  const [big, small] = s > 0 ? [a, b] : [b, a]
  return { outer: big, hole: small.reverse() }
}
