/**
 * Shape items to chains of exact elements in the shape frame (step 1 of resolving a shape):
 * primitives analytically, paths by walking their segments, fillets as tangent arcs between
 * neighbours. Pure numbers (mm, degrees); every refusal is an issue with the item's parameter path
 * (`items.<n>.<param>`), collected per item.
 * Doc: docs/architecture/shapes.md#resolving-a-shape, docs/architecture/shapes.md#implementation-k2,
 * docs/modes/design-v0.3.md#shape-definition
 */
import type { Issue } from '../../shared/errors/app-error'
import type { Vec2 } from '../geometry/model'
import { closedChainCrossing } from '../geometry/2d/crossings'
import { elementPointAt } from '../geometry/2d/measure'
import {
  arc,
  arcRadius,
  arcSweep,
  elementLength,
  line,
  MIN_ELEMENT_LENGTH,
  POSITION_EPSILON,
  reverseLoop,
  signedArea,
  type ArcElement,
  type Element,
  type Loop,
} from '../geometry/2d/model'
import type { ShapeItem, ShapeSegment } from './shape.dto'

/** Area below which a loop or a resolved region has none (mm², (1e-4 mm)² as the port's lobes). */
export const AREA_EPSILON = MIN_ELEMENT_LENGTH * MIN_ELEMENT_LENGTH
export const POLYGON_SIDES_MIN = 3
export const POLYGON_SIDES_MAX = 64

/** An item's resolved chain: a closed loop (counter-clockwise) or an open path. */
export interface ItemChain {
  readonly loop: Loop
  readonly closed: boolean
}

type Path = readonly (string | number)[]
type Issues = Issue[]

const DEG = Math.PI / 180
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

function issue(issues: Issues, path: Path, rule: string, message: string, params?: object) {
  issues.push({
    path: [...path],
    rule,
    message,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  })
}

function positive(issues: Issues, v: number, path: Path): boolean {
  if (v > 0) return true
  issue(issues, path, 'positive', 'must be greater than 0', { actual: v })
  return false
}

/** Rotates element points about `c` by `deg` counter-clockwise. */
function rotate(elements: Element[], c: Vec2, deg: number): Element[] {
  if (deg === 0) return elements
  const cos = Math.cos(deg * DEG)
  const sin = Math.sin(deg * DEG)
  const r = (p: Vec2): Vec2 => {
    const dx = p[0] - c[0]
    const dy = p[1] - c[1]
    return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]
  }
  return elements.map((e) =>
    e.kind === 'line' ? line(r(e.a), r(e.b)) : arc(r(e.a), r(e.b), r(e.centre), e.ccw),
  )
}

/** A counter-clockwise rounded rectangle (lines of zero length left out). */
function roundedRect(c: Vec2, l: number, w: number, r: number): Element[] {
  const x0 = c[0] - l / 2
  const x1 = c[0] + l / 2
  const y0 = c[1] - w / 2
  const y1 = c[1] + w / 2
  if (r <= 0)
    return [
      line([x0, y0], [x1, y0]),
      line([x1, y0], [x1, y1]),
      line([x1, y1], [x0, y1]),
      line([x0, y1], [x0, y0]),
    ]
  const out: Element[] = []
  const side = (a: Vec2, b: Vec2) => {
    if (dist(a, b) > 0) out.push(line(a, b))
  }
  side([x0 + r, y0], [x1 - r, y0])
  out.push(arc([x1 - r, y0], [x1, y0 + r], [x1 - r, y0 + r], true))
  side([x1, y0 + r], [x1, y1 - r])
  out.push(arc([x1, y1 - r], [x1 - r, y1], [x1 - r, y1 - r], true))
  side([x1 - r, y1], [x0 + r, y1])
  out.push(arc([x0 + r, y1], [x0, y1 - r], [x0 + r, y1 - r], true))
  side([x0, y1 - r], [x0, y0 + r])
  out.push(arc([x0, y0 + r], [x0 + r, y0], [x0 + r, y0 + r], true))
  return out
}

/** An arc split in two halves when it sweeps more than 180° (the port's bulges stay ≤ 1). */
function pushArc(out: Element[], e: ArcElement): void {
  const sweep = arcSweep(e)
  if (Math.abs(sweep) <= Math.PI + 1e-12) {
    out.push(e)
    return
  }
  const mid = elementPointAt(e, 0.5).point
  out.push(arc(e.a, mid, e.centre, e.ccw), arc(mid, e.b, e.centre, e.ccw))
}

// ── fillets ─────────────────────────────────────────────────────────────────────────────────

/** An element's carrier offset to one side: a line (point + direction) or a circle. */
type Carrier =
  | { readonly kind: 'line'; readonly p: Vec2; readonly d: Vec2 }
  | { readonly kind: 'circle'; readonly c: Vec2; readonly r: number }

/** The carrier of `e` offset by `r` to the left (`side` 1) or right (−1); undefined if none. */
function offsetCarrier(e: Element, side: 1 | -1, r: number): Carrier | undefined {
  if (e.kind === 'line') {
    const d = sub(e.b, e.a)
    const len = Math.hypot(d[0], d[1])
    const n: Vec2 = [(-d[1] / len) * side * r, (d[0] / len) * side * r]
    return { kind: 'line', p: [e.a[0] + n[0], e.a[1] + n[1]], d }
  }
  // the left side of a counter-clockwise arc is towards its centre
  const R = arcRadius(e) - side * r * (e.ccw ? 1 : -1)
  return R > POSITION_EPSILON ? { kind: 'circle', c: e.centre, r: R } : undefined
}

function carrierPoints(a: Carrier, b: Carrier): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const den = cross(a.d, b.d)
    if (Math.abs(den) < 1e-15) return []
    const s = cross(sub(b.p, a.p), b.d) / den
    return [[a.p[0] + a.d[0] * s, a.p[1] + a.d[1] * s]]
  }
  if (a.kind === 'circle' && b.kind === 'circle') {
    const d = dist(a.c, b.c)
    if (d < 1e-12 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return []
    const x = (a.r * a.r - b.r * b.r + d * d) / (2 * d)
    const h = Math.sqrt(Math.max(0, a.r * a.r - x * x))
    const ex: Vec2 = [(b.c[0] - a.c[0]) / d, (b.c[1] - a.c[1]) / d]
    const m: Vec2 = [a.c[0] + ex[0] * x, a.c[1] + ex[1] * x]
    return [
      [m[0] - ex[1] * h, m[1] + ex[0] * h],
      [m[0] + ex[1] * h, m[1] - ex[0] * h],
    ]
  }
  const l = (a.kind === 'line' ? a : b) as Extract<Carrier, { kind: 'line' }>
  const c = (a.kind === 'circle' ? a : b) as Extract<Carrier, { kind: 'circle' }>
  const f = sub(l.p, c.c)
  const A = dot(l.d, l.d)
  const B = 2 * dot(f, l.d)
  const C = dot(f, f) - c.r * c.r
  const disc = B * B - 4 * A * C
  if (disc < 0) return []
  const s = Math.sqrt(disc)
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((u): Vec2 => [
    l.p[0] + l.d[0] * u,
    l.p[1] + l.d[1] * u,
  ])
}

/** The foot of `p` on an element's carrier and its parameter on the element (undefined: off). */
function footOn(e: Element, p: Vec2): { at: Vec2; t: number } | undefined {
  if (e.kind === 'line') {
    const d = sub(e.b, e.a)
    const len2 = dot(d, d)
    const t = dot(sub(p, e.a), d) / len2
    const tol = POSITION_EPSILON / Math.sqrt(len2)
    if (t < -tol || t > 1 + tol) return undefined
    const tc = Math.min(1, Math.max(0, t))
    return { at: [e.a[0] + d[0] * tc, e.a[1] + d[1] * tc], t: tc }
  }
  const v = sub(p, e.centre)
  const len = Math.hypot(v[0], v[1])
  if (len < 1e-12) return undefined
  const R = arcRadius(e)
  const at: Vec2 = [e.centre[0] + (v[0] / len) * R, e.centre[1] + (v[1] / len) * R]
  if (dist(at, e.a) <= POSITION_EPSILON) return { at: e.a, t: 0 }
  if (dist(at, e.b) <= POSITION_EPSILON) return { at: e.b, t: 1 }
  const sweep = arcSweep(e)
  const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const ang = Math.atan2(v[1], v[0])
  const TAU = 2 * Math.PI
  const delta =
    sweep >= 0 ? (((ang - start) % TAU) + TAU) % TAU : (((start - ang) % TAU) + TAU) % TAU
  return delta <= Math.abs(sweep) ? { at, t: delta / Math.abs(sweep) } : undefined
}

/** The element from its start to `p` (a point on it), or from `p` to its end. */
const head = (e: Element, p: Vec2): Element =>
  e.kind === 'line' ? line(e.a, p) : arc(e.a, p, e.centre, e.ccw)
const tail = (e: Element, p: Vec2): Element =>
  e.kind === 'line' ? line(p, e.b) : arc(p, e.b, e.centre, e.ccw)

type FilletResult =
  | {
      readonly ok: true
      readonly a: Element | undefined
      readonly fillet: ArcElement
      readonly b: Element | undefined
    }
  | { readonly ok: false; readonly rule: 'filletTooLarge' | 'filletNoCorner' }

/**
 * Rounds the corner where `a` ends and `b` starts with a tangent arc of radius `r`: the centre is
 * where both carriers offset by `r` towards the turn meet (nearest the corner); the trimmed
 * elements (undefined when used up) and the arc.
 */
function filletCorner(a: Element, b: Element, r: number): FilletResult {
  const ta = elementPointAt(a, 1).tangent
  const tb = elementPointAt(b, 0).tangent
  const turn = cross(ta, tb)
  if (Math.abs(Math.atan2(turn, dot(ta, tb))) <= 1e-9) return { ok: false, rule: 'filletNoCorner' }
  const side: 1 | -1 = turn > 0 ? 1 : -1
  const ca = offsetCarrier(a, side, r)
  const cb = offsetCarrier(b, side, r)
  if (ca === undefined || cb === undefined) return { ok: false, rule: 'filletTooLarge' }
  const v = a.b
  const centres = carrierPoints(ca, cb).sort((p, q) => dist(p, v) - dist(q, v))
  const centre = centres[0]
  if (centre === undefined) return { ok: false, rule: 'filletTooLarge' }
  const fa = footOn(a, centre)
  const fb = footOn(b, centre)
  if (fa === undefined || fb === undefined) return { ok: false, rule: 'filletTooLarge' }
  // a remainder shorter than the smallest element stays: the port merges it (wire.ts)
  const ha = head(a, fa.at)
  const rest = tail(b, fb.at)
  return {
    ok: true,
    a: elementLength(ha) > 1e-12 ? ha : undefined,
    fillet: arc(fa.at, fb.at, centre, side > 0),
    b: elementLength(rest) > 1e-12 ? rest : undefined,
  }
}

/**
 * Applies fillets at junctions of `elements` (`junction` k = where element k − 1 ends and k
 * starts; k = 0 joins the last element for a closed chain). Issues go to `path(i)` of fillet i.
 */
function applyFillets(
  elements: Element[],
  closed: boolean,
  fillets: readonly { junction: number; radius: number; index: number }[],
  path: (i: number) => Path,
  issues: Issues,
): Element[] {
  const n = elements.length
  const cur: (Element | undefined)[] = [...elements]
  const arcs = new Map<number, ArcElement>()
  for (const f of [...fillets].sort((x, y) => x.junction - y.junction)) {
    const ia = (f.junction - 1 + n) % n
    const ib = f.junction
    const a = cur[ia]
    const b = cur[ib]
    if (a === undefined || b === undefined || (!closed && f.junction === 0)) {
      issue(issues, path(f.index), 'filletTooLarge', 'is too large for the neighbouring segments', {
        radius: f.radius,
      })
      continue
    }
    const r = filletCorner(a, b, f.radius)
    if (!r.ok) {
      issue(
        issues,
        path(f.index),
        r.rule,
        r.rule === 'filletNoCorner'
          ? 'the vertex has no corner to round (the segments are tangent)'
          : 'is too large for the neighbouring segments',
        { radius: f.radius },
      )
      continue
    }
    cur[ia] = r.a
    cur[ib] = r.b
    arcs.set(ib, r.fillet)
  }
  const out: Element[] = []
  for (let k = 0; k < n; k++) {
    const fa = arcs.get(k)
    if (fa !== undefined) out.push(fa)
    const e = cur[k]
    if (e !== undefined) out.push(e)
  }
  return out
}

// ── paths ───────────────────────────────────────────────────────────────────────────────────

/** Centre of an arc from `p` to `q` with `radius`, clockwise `cw`, over 180° when `large`. */
function arcCentre(p: Vec2, q: Vec2, radius: number, cw: boolean, large: boolean): Vec2 {
  const c = dist(p, q)
  const m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
  const h = Math.sqrt(Math.max(0, radius * radius - (c / 2) * (c / 2)))
  const nl: Vec2 = [-(q[1] - p[1]) / c, (q[0] - p[0]) / c]
  // a counter-clockwise arc up to 180° has its centre on the left of the chord
  const s = cw === large ? 1 : -1
  return [m[0] + nl[0] * h * s, m[1] + nl[1] * h * s]
}

/** One segment from `p`; pushes elements or an issue, returns whether it was built. */
function segmentElements(
  seg: ShapeSegment<number>,
  p: Vec2,
  prev: Element | undefined,
  out: Element[],
  path: Path,
  issues: Issues,
): boolean {
  const to: Vec2 = [seg.to[0], seg.to[1]]
  const chord = dist(p, to)
  if (chord < MIN_ELEMENT_LENGTH) {
    issue(issues, [...path, 'to'], 'segmentTooShort', 'the segment is shorter than 0.0001 mm', {
      min: MIN_ELEMENT_LENGTH,
      actual: chord,
    })
    return false
  }
  if (seg.kind === 'line') {
    out.push(line(p, to))
    return true
  }
  if (seg.kind === 'arc') {
    if (!positive(issues, seg.radius, [...path, 'radius'])) return false
    // a radius within rounding of half the chord is the half circle
    if (seg.radius < (chord / 2) * (1 - 1e-9)) {
      issue(issues, [...path, 'radius'], 'arcRadius', 'must be at least half the chord', {
        min: chord / 2,
        actual: seg.radius,
      })
      return false
    }
    pushArc(out, arc(p, to, arcCentre(p, to, seg.radius, seg.cw, seg.large === true), !seg.cw))
    return true
  }
  // tangentArc: tangent to the previous element's end
  if (prev === undefined) {
    issue(issues, path, 'tangentArcStart', 'needs a segment before it to be tangent to')
    return false
  }
  const t = elementPointAt(prev, 1).tangent
  const d = sub(to, p)
  const nl: Vec2 = [-t[1], t[0]]
  const dn = dot(d, nl)
  if (Math.abs(dn) <= 1e-12 * dot(d, d)) {
    if (dot(d, t) > 0) {
      out.push(line(p, to)) // straight ahead: the tangent arc is the line
      return true
    }
    issue(issues, [...path, 'to'], 'tangentArcReverse', 'lies straight behind the previous segment')
    return false
  }
  const rs = dot(d, d) / (2 * dn)
  pushArc(out, arc(p, to, [p[0] + nl[0] * rs, p[1] + nl[1] * rs], rs > 0))
  return true
}

function pathChain(
  item: Extract<ShapeItem<number>, { kind: 'path' }>,
  base: Path,
  issues: Issues,
): Element[] | undefined {
  const before = issues.length
  const out: Element[] = []
  /** Element index where segment k starts (k = segments.length: the closing line, if any). */
  const segStart: number[] = []
  let p: Vec2 = [item.start[0], item.start[1]]
  for (const [k, seg] of item.segments.entries()) {
    segStart.push(out.length)
    if (!segmentElements(seg, p, out[out.length - 1], out, [...base, 'segments', k], issues))
      return undefined
    p = [seg.to[0], seg.to[1]]
  }
  const start: Vec2 = [item.start[0], item.start[1]]
  let vertices = item.closed ? item.segments.length : item.segments.length - 1
  if (item.closed) {
    const gap = dist(p, start)
    if (gap > POSITION_EPSILON) {
      if (gap < MIN_ELEMENT_LENGTH) {
        issue(
          issues,
          [...base, 'closed'],
          'segmentTooShort',
          'the closing line is shorter than 0.0001 mm',
          {
            min: MIN_ELEMENT_LENGTH,
            actual: gap,
          },
        )
        return undefined
      }
      segStart.push(out.length)
      out.push(line(p, start))
      vertices++
    } else {
      // closed by its last segment: end exactly at the start
      const last = out[out.length - 1]!
      out[out.length - 1] =
        last.kind === 'line' ? line(last.a, start) : arc(last.a, start, last.centre, last.ccw)
    }
  }
  const fillets = item.fillets ?? []
  const seen = new Set<number>()
  const valid: { junction: number; radius: number; index: number }[] = []
  for (const [i, f] of fillets.entries()) {
    const path = [...base, 'fillets', i]
    const first = item.closed ? 0 : 1
    const last = item.closed ? vertices - 1 : vertices
    if (f.vertex < first || f.vertex > last || seen.has(f.vertex)) {
      issue(
        issues,
        [...path, 'vertex'],
        'filletVertex',
        seen.has(f.vertex)
          ? 'the vertex already has a fillet'
          : 'is not an inner vertex of the path',
        { min: first, max: last, actual: f.vertex },
      )
      continue
    }
    seen.add(f.vertex)
    if (positive(issues, f.radius, [...path, 'radius']))
      valid.push({ junction: segStart[f.vertex]!, radius: f.radius, index: i })
  }
  if (issues.length > before) return undefined
  if (valid.length === 0) return out
  const filleted = applyFillets(
    out,
    item.closed,
    valid,
    (i) => [...base, 'fillets', i, 'radius'],
    issues,
  )
  return issues.length > before ? undefined : filleted
}

// ── items ───────────────────────────────────────────────────────────────────────────────────

/** Regular polygon corners, counter-clockwise; at rotation 0 a flat side lies at the bottom. */
function polygonCorners(c: Vec2, sides: number, R: number, deg: number): Vec2[] {
  const out: Vec2[] = []
  for (let k = 0; k < sides; k++) {
    const ang = -Math.PI / 2 + Math.PI / sides + (2 * Math.PI * k) / sides + deg * DEG
    out.push([c[0] + R * Math.cos(ang), c[1] + R * Math.sin(ang)])
  }
  return out
}

/**
 * The chain of item `n` (closed loops counter-clockwise), or undefined with issues at
 * `items.<n>.…`.
 */
export function itemChain(
  item: ShapeItem<number>,
  n: number,
  issues: Issues,
): ItemChain | undefined {
  const base: Path = ['items', n]
  const before = issues.length
  let elements: Element[] | undefined
  let closed = true
  switch (item.kind) {
    case 'rectangle': {
      const l = positive(issues, item.length, [...base, 'length'])
      const w = positive(issues, item.width, [...base, 'width'])
      if (!l || !w) return undefined
      const max = Math.min(item.length, item.width) / 2
      if (!(item.cornerRadius >= 0 && item.cornerRadius <= max)) {
        issue(
          issues,
          [...base, 'cornerRadius'],
          'cornerRadiusRange',
          'must be between 0 and half the narrowest size',
          {
            min: 0,
            max,
            actual: item.cornerRadius,
          },
        )
        return undefined
      }
      const c: Vec2 = [item.center[0], item.center[1]]
      elements = rotate(
        roundedRect(c, item.length, item.width, item.cornerRadius),
        c,
        item.rotation ?? 0,
      )
      break
    }
    case 'circle': {
      if (!positive(issues, item.diameter, [...base, 'diameter'])) return undefined
      const r = item.diameter / 2
      const a: Vec2 = [item.center[0], item.center[1] - r]
      elements = [arc(a, a, [item.center[0], item.center[1]], true)]
      break
    }
    case 'obround': {
      const l = positive(issues, item.length, [...base, 'length'])
      const w = positive(issues, item.width, [...base, 'width'])
      if (!l || !w) return undefined
      if (item.length < item.width) {
        issue(issues, [...base, 'length'], 'obroundLength', 'must be at least the width', {
          min: item.width,
          actual: item.length,
        })
        return undefined
      }
      const c: Vec2 = [item.center[0], item.center[1]]
      const r = item.width / 2
      const h = item.length / 2 - r
      const [x, y] = c
      const out: Element[] = []
      if (h > 0) out.push(line([x - h, y - r], [x + h, y - r]))
      out.push(arc([x + h, y - r], [x + h, y + r], [x + h, y], true))
      if (h > 0) out.push(line([x + h, y + r], [x - h, y + r]))
      out.push(arc([x - h, y + r], [x - h, y - r], [x - h, y], true))
      elements = rotate(out, c, item.rotation ?? 0)
      break
    }
    case 'polygon': {
      const sides = item.sides
      if (!Number.isInteger(sides) || sides < POLYGON_SIDES_MIN || sides > POLYGON_SIDES_MAX) {
        issue(issues, [...base, 'sides'], 'range', 'must be a whole number from 3 to 64', {
          min: POLYGON_SIDES_MIN,
          max: POLYGON_SIDES_MAX,
          actual: sides,
        })
        return undefined
      }
      if (!positive(issues, item.diameter, [...base, 'diameter'])) return undefined
      const r = item.cornerRadius ?? 0
      if (r < 0) {
        issue(issues, [...base, 'cornerRadius'], 'nonNegative', 'must be 0 or more', { actual: r })
        return undefined
      }
      const R =
        item.across === 'flats'
          ? item.diameter / (2 * Math.cos(Math.PI / sides))
          : item.diameter / 2
      const pts = polygonCorners([item.center[0], item.center[1]], sides, R, item.rotation ?? 0)
      const out = pts.map((p, k) => line(p, pts[(k + 1) % sides]!))
      elements =
        r > 0
          ? applyFillets(
              out,
              true,
              out.map((_, k) => ({ junction: k, radius: r, index: 0 })),
              () => [...base, 'cornerRadius'],
              issues,
            )
          : out
      // one issue per corner would repeat itself: keep the first
      const extra = issues.length - before
      if (extra > 1) issues.splice(before + 1, extra - 1)
      break
    }
    case 'path': {
      closed = item.closed
      levelIssues(item, base, issues)
      elements = pathChain(item, base, issues)
      break
    }
    case 'offset':
      // a region of its source, resolved by shape.ts (design-llm-first.md § Offset item)
      issue(issues, base, 'offsetNoChain', 'an offset item is not one loop of its own')
      return undefined
  }
  if (elements === undefined || issues.length > before) return undefined
  if (!closed) return { loop: { elements }, closed }
  const crossing = closedChainCrossing(elements)
  if (crossing !== undefined) {
    issue(issues, base, 'shapeSelfIntersects', 'the closed path crosses itself', {
      at: crossing.at,
    })
    return undefined
  }
  const loop: Loop = { elements }
  const area = signedArea(loop)
  if (Math.abs(area) <= AREA_EPSILON) {
    issue(issues, base, 'shapeEmpty', 'the item encloses no area', { area: Math.abs(area) })
    return undefined
  }
  return { loop: area < 0 ? reverseLoop(loop) : loop, closed }
}

// ── largest corner radius ───────────────────────────────────────────────────────────────────

/** Bisection stops when the bracket is this narrow (mm), well below any written radius. */
const MAX_RADIUS_TOLERANCE = 1e-6
/** The smallest radius tried: below it the arc is near the resolver's crossing tolerance (mm). */
const MIN_RADIUS_TRIED = 1e-3

/**
 * The largest corner radius an item takes, so a fix can round a corner as far as it fits instead
 * of being refused (`filletTooLarge`): a path's fillet at inner vertex `vertex` with its other
 * fillets in place, a rectangle's or polygon's `cornerRadius` (all corners). Undefined when the
 * item does not resolve with that corner sharp, the vertex is not an inner vertex, or the
 * neighbours are tangent there (`filletNoCorner`). Found by bisection on the resolver itself, so
 * fitted arcs, neighbouring fillets and self-crossings count as they do when the radius is set.
 * Doc: docs/modes/design-v0.3.md#dfm-checks-for-shapes
 */
export function maxCornerRadius(item: ShapeItem<number>, vertex?: number): number | undefined {
  if (item.kind === 'rectangle') {
    const max = Math.min(item.length, item.width) / 2
    return max > 0 ? max : undefined
  }
  let withRadius: (r: number) => ShapeItem<number>
  if (item.kind === 'polygon') withRadius = (r) => ({ ...item, cornerRadius: r })
  else if (item.kind === 'path') {
    if (vertex === undefined) return undefined
    const others = (item.fillets ?? []).filter((f) => f.vertex !== vertex)
    withRadius = (r) => ({
      ...item,
      fillets: r > 0 ? [...others, { vertex, radius: r }] : others,
    })
  } else return undefined
  const sharp = itemChain(withRadius(0), 0, [])
  if (sharp === undefined) return undefined
  const fits = (r: number): boolean | 'noCorner' => {
    const issues: Issues = []
    if (itemChain(withRadius(r), 0, issues) !== undefined && issues.length === 0) return true
    return issues.some((i) => i.rule === 'filletNoCorner' || i.rule === 'filletVertex')
      ? 'noCorner'
      : false
  }
  // no radius beyond the chain's length over the tangent of a 1° half turn can fit
  const length = sharp.loop.elements.reduce((s, e) => s + elementLength(e), 0)
  let hi = length / Math.tan(0.5 * DEG)
  const first = fits(MIN_RADIUS_TRIED)
  if (first === 'noCorner') return undefined
  if (first === false) return 0
  if (fits(hi) === true) return hi
  let lo = MIN_RADIUS_TRIED
  for (let k = 0; k < 80 && hi - lo > MAX_RADIUS_TOLERANCE; k++) {
    const mid = (lo + hi) / 2
    if (fits(mid) === true) lo = mid
    else hi = mid
  }
  return lo
}

// ── engraving levels (engraved-patterns.md E2) ──────────────────────────────────────────────

/**
 * Rules of a path's `levels` (engraved-patterns.md § Levels on shapes): each 0..1 (`levelRange`),
 * one value or one per vertex: `segments.length + 1`, a closed path with a closing line one more
 * (`levelCount`).
 */
function levelIssues(
  item: Extract<ShapeItem<number>, { kind: 'path' }>,
  base: Path,
  issues: Issues,
) {
  const lv = item.levels
  if (lv === undefined) return
  const values = typeof lv === 'number' ? [lv] : lv
  values.forEach((v, k) => {
    if (!(v >= 0 && v <= 1))
      issue(
        issues,
        typeof lv === 'number' ? [...base, 'levels'] : [...base, 'levels', k],
        'levelRange',
        'a level is between 0 and 1',
        { min: 0, max: 1, actual: v },
      )
  })
  if (typeof lv === 'number') return
  const n = item.segments.length + 1
  if (lv.length !== n && !(item.closed && lv.length === n + 1))
    issue(issues, [...base, 'levels'], 'levelCount', 'one level, or one per vertex', {
      expected: n,
      actual: lv.length,
    })
}

/**
 * An open path's level profile by arc-length fraction (0 = start, 1 = end): its vertices' levels
 * at their positions along the path resolved without fillets (fillets barely move the fractions).
 * Undefined without levels or when the path does not resolve.
 */
export function pathLevelProfile(
  item: Extract<ShapeItem<number>, { kind: 'path' }>,
): { u: number[]; level: number[] } | undefined {
  const lv = item.levels
  if (lv === undefined) return undefined
  if (typeof lv === 'number') return { u: [0, 1], level: [lv, lv] }
  const { fillets: _, ...sharp } = item
  const chain = itemChain(sharp, 0, [])
  if (chain === undefined) return undefined
  const vertices: Vec2[] = [item.start, ...item.segments.map((s) => s.to)].map((p): Vec2 => [
    p[0],
    p[1],
  ])
  const s: number[] = [0]
  let acc = 0
  let next = 1
  for (const e of chain.loop.elements) {
    acc += elementLength(e)
    if (next < vertices.length && dist(e.b, vertices[next]!) <= POSITION_EPSILON * 10) {
      s.push(acc)
      next++
    }
  }
  const total = acc
  if (!(total > 0)) return undefined
  // a closing line's end is vertex 0 again
  while (s.length < lv.length) s.push(total)
  const u = s.slice(0, lv.length).map((x) => x / total)
  return { u, level: [...lv] }
}
