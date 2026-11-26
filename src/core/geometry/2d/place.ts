/**
 * Rigid placement of 2D chains (mirror, rotation, translation) and the surface-numbering order of
 * a placed region: each loop from its start point, pieces and holes by their start points.
 * Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/design-v0.3.md#surfaces,
 * docs/modes/design-v0.3.md#tabs-on-shapes
 *
 * Pure TS on the analytic elements (no port call).
 */
import type { Vec2 } from '../model'
import {
  arc,
  arcRadius,
  arcSweep,
  isFullCircle,
  line,
  MIN_ELEMENT_LENGTH,
  onSweep,
  reverseLoop,
  type Element,
  type Loop,
  type Region,
  type RegionPiece,
} from './model'

/**
 * Uniform scale, mirror (x → −x in the shape frame) then a counter-clockwise rotation, about the
 * origin. Similarity only: arcs stay exact arcs (docs/modes/design-llm-first.md#placement-scale).
 */
export interface Orientation {
  /** Degrees, counter-clockwise. */
  readonly rotation: number
  readonly mirror: boolean
  /** > 0; absent = 1. */
  readonly scale?: number
}

/** cos and sin of a rotation in degrees, exact at multiples of 90° (no 6e-17 residues). */
function cosSin(deg: number): readonly [number, number] {
  const turn = (((deg % 360) + 360) % 360) / 90
  if (Number.isInteger(turn)) return [[1, 0, -1, 0][turn]!, [0, 1, 0, -1][turn]!]
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

/** A map of points with the arc sense it keeps (false when it mirrors). */
interface PointMap {
  readonly at: (p: Vec2) => Vec2
  readonly keepsSense: boolean
}

function mapElement(e: Element, m: PointMap): Element {
  if (e.kind === 'line') return line(m.at(e.a), m.at(e.b))
  const a = m.at(e.a)
  // a full circle stays exactly closed
  const b = isFullCircle(e) ? a : m.at(e.b)
  return arc(a, b, m.at(e.centre), m.keepsSense ? e.ccw : !e.ccw)
}

const mapLoop = (l: Loop, m: PointMap): Loop => ({
  elements: l.elements.map((e) => mapElement(e, m)),
})

function orientationMap(o: Orientation): PointMap {
  const [c, s] = cosSin(o.rotation)
  const f = o.mirror ? -1 : 1
  const k = o.scale ?? 1
  if (c === 1 && s === 0 && f === 1 && k === 1) return { at: (p) => p, keepsSense: true }
  if (k !== 1)
    return {
      at: (p) => {
        const x = f * k * p[0]
        const y = k * p[1]
        return [c * x - s * y + 0, s * x + c * y + 0]
      },
      keepsSense: !o.mirror,
    }
  return {
    at: (p) => {
      const x = f * p[0]
      // `+ 0` turns −0 into 0 (stable JSON hashes and equality)
      return [c * x - s * p[1] + 0, s * x + c * p[1] + 0]
    },
    keepsSense: !o.mirror,
  }
}

/** An open path oriented (its direction of travel kept). */
export const orientPath = (p: Loop, o: Orientation): Loop => mapLoop(p, orientationMap(o))

/**
 * A region oriented; a mirror reverses every loop afterwards so outer loops stay
 * counter-clockwise and holes clockwise.
 */
export function orientRegion(r: Region, o: Orientation): Region {
  const m = orientationMap(o)
  const loop = (l: Loop) => (o.mirror ? reverseLoop(mapLoop(l, m)) : mapLoop(l, m))
  return { pieces: r.pieces.map((p) => ({ outer: loop(p.outer), holes: p.holes.map(loop) })) }
}

const translateMap = (d: Vec2): PointMap =>
  d[0] === 0 && d[1] === 0
    ? { at: (p) => p, keepsSense: true }
    : { at: (p) => [p[0] + d[0], p[1] + d[1]], keepsSense: true }

export const translatePath = (p: Loop, d: Vec2): Loop => mapLoop(p, translateMap(d))

export function translateRegion(r: Region, d: Vec2): Region {
  const m = translateMap(d)
  return {
    pieces: r.pieces.map((p) => ({
      outer: mapLoop(p.outer, m),
      holes: p.holes.map((h) => mapLoop(h, m)),
    })),
  }
}

// ── start points and numbering ──────────────────────────────────────────────────────────────

/** Points whose `v` differs by less than this (mm) are equally low; `u` decides. */
const LEVEL_EPSILON = 1e-7

/** True if `p` comes before `q`: lower `v`, then lower `u`. */
export function before(p: Vec2, q: Vec2): boolean {
  if (Math.abs(p[1] - q[1]) > LEVEL_EPSILON) return p[1] < q[1]
  return p[0] < q[0]
}

/** The lowest point of an arc's interior (its bottom extreme) when it lies on the sweep. */
function arcBottom(e: Extract<Element, { kind: 'arc' }>): Vec2 | undefined {
  const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  if (!onSweep(start, arcSweep(e), -Math.PI / 2)) return undefined
  return [e.centre[0], e.centre[1] - arcRadius(e)]
}

/**
 * The loop's start point (design-v0.3.md#tabs-on-shapes): the point with the lowest `v`, then
 * the lowest `u`. Returns the element it lies on and the point (an element's start, or the bottom
 * of an arc).
 */
export function loopStart(l: Loop): { element: number; point: Vec2; atStart: boolean } {
  let best = { element: 0, point: l.elements[0]!.a, atStart: true }
  l.elements.forEach((e, i) => {
    if (before(e.a, best.point)) best = { element: i, point: e.a, atStart: true }
    if (e.kind === 'arc') {
      const p = arcBottom(e)
      if (p !== undefined && before(p, best.point)) best = { element: i, point: p, atStart: false }
    }
  })
  return best
}

/**
 * The loop re-chained to begin at its start point: elements rotated so element 0 starts there;
 * an arc whose bottom is the start point is split there (not when a piece would be shorter than
 * `MIN_ELEMENT_LENGTH`, then its nearer end is the start). A full circle starts at its bottom.
 */
export function fromStartPoint(l: Loop): Loop {
  const els = l.elements
  if (els.length === 0) return l
  const s = loopStart(l)
  const e = els[s.element]!
  if (s.atStart || e.kind !== 'arc')
    return { elements: [...els.slice(s.element), ...els.slice(0, s.element)] }
  if (isFullCircle(e)) return { elements: [arc(s.point, s.point, e.centre, e.ccw)] }
  const r = arcRadius(e)
  const startAng = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const sweep = arcSweep(e)
  // signed sweep from the arc start to the bottom
  const toBottom =
    sweep >= 0
      ? (((-Math.PI / 2 - startAng) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      : -((((startAng + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
  const first = Math.abs(toBottom) * r
  const second = Math.abs(sweep - toBottom) * r
  const rest = [...els.slice(s.element + 1), ...els.slice(0, s.element)]
  if (second < MIN_ELEMENT_LENGTH) return { elements: [...rest, e] }
  if (first < MIN_ELEMENT_LENGTH) return { elements: [e, ...rest] }
  return {
    elements: [arc(s.point, e.b, e.centre, e.ccw), ...rest, arc(e.a, s.point, e.centre, e.ccw)],
  }
}

/**
 * The region in surface-numbering order (design-v0.3.md#surfaces): every loop from its start
 * point, holes of a piece and the pieces ordered by their start points. Element `i` across all
 * loops (outer first, then holes, piece by piece) is `wall[i]` (line) or `corner[i]` (arc).
 */
export function numberRegion(r: Region): Region {
  const piece = (p: RegionPiece): RegionPiece => ({
    outer: fromStartPoint(p.outer),
    holes: p.holes.map(fromStartPoint).sort((a, b) => order(a, b)),
  })
  return { pieces: r.pieces.map(piece).sort((a, b) => order(a.outer, b.outer)) }
}

function order(a: Loop, b: Loop): number {
  const p = a.elements[0]!.a
  const q = b.elements[0]!.a
  return before(p, q) ? -1 : before(q, p) ? 1 : 0
}
