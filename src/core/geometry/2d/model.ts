/**
 * The 2D model of shapes: elements (lines and circular arcs) in float64 mm, loops, paths and
 * regions, plus the analytic helpers every host uses (signed area, bounds, reverse).
 * Doc: docs/architecture/shapes.md#2d-model
 *
 * CavalierContours' bulge form is the port's wire format only (wire.ts); nothing outside
 * `src/core/geometry/2d/` sees it.
 */
import type { Vec2 } from '../model'

/** CavalierContours' position epsilon (mm): points closer than this are the same point. */
export const POSITION_EPSILON = 1e-5
/** CavalierContours' offset distance epsilon (mm). */
export const OFFSET_EPSILON = 1e-4
/**
 * Elements shorter than this (mm) are merged into their neighbours before the library sees them;
 * user input refuses them earlier (`segmentTooShort`, docs/architecture/shapes.md#2d-port).
 */
export const MIN_ELEMENT_LENGTH = 1e-4

export interface LineElement {
  readonly kind: 'line'
  readonly a: Vec2
  readonly b: Vec2
}

/**
 * A circular arc from `a` to `b` around `centre`, counter-clockwise when `ccw`. `a` exactly equal
 * to `b` is a full circle.
 */
export interface ArcElement {
  readonly kind: 'arc'
  readonly a: Vec2
  readonly b: Vec2
  readonly centre: Vec2
  readonly ccw: boolean
}

export type Element = LineElement | ArcElement

/** A closed chain of elements: each element ends where the next starts, the last at the first. */
export interface Loop {
  readonly elements: readonly Element[]
}

/** An open chain of elements. */
export type Path = Loop

/** One connected area of a region: an outer loop (counter-clockwise) and its holes (clockwise). */
export interface RegionPiece {
  readonly outer: Loop
  readonly holes: readonly Loop[]
}

/**
 * Pieces whose loops never cross (they may touch); each hole lies inside its piece's outer loop.
 * An island inside a hole is a piece of its own. A positive offset shrinks a region.
 */
export interface Region {
  readonly pieces: readonly RegionPiece[]
}

export const EMPTY_REGION: Region = { pieces: [] }

export const line = (a: Vec2, b: Vec2): LineElement => ({ kind: 'line', a, b })
export const arc = (a: Vec2, b: Vec2, centre: Vec2, ccw: boolean): ArcElement => ({
  kind: 'arc',
  a,
  b,
  centre,
  ccw,
})

/** Every loop of a region: per piece the outer loop, then its holes. */
export function regionLoops(r: Region): Loop[] {
  return r.pieces.flatMap((p) => [p.outer, ...p.holes])
}

const TAU = 2 * Math.PI

/** Signed sweep of an arc in radians (positive counter-clockwise), `±2π` for a full circle. */
export function arcSweep(e: ArcElement): number {
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
  if (isFullCircle(e)) return e.ccw ? TAU : -TAU
  const s = (((a1 - a0) % TAU) + TAU) % TAU
  return e.ccw || s === 0 ? s : s - TAU
}

/** An arc whose end is exactly its start. */
export const isFullCircle = (e: ArcElement): boolean => e.a[0] === e.b[0] && e.a[1] === e.b[1]

export const arcRadius = (e: ArcElement): number =>
  Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1])

export function elementLength(e: Element): number {
  if (e.kind === 'line') return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
  return Math.abs(arcSweep(e)) * arcRadius(e)
}

/** Signed area of a closed loop (counter-clockwise positive), exact for arcs. */
export function signedArea(l: Loop): number {
  let s = 0
  for (const e of l.elements) {
    s += (e.a[0] * e.b[1] - e.b[0] * e.a[1]) / 2
    if (e.kind === 'arc') {
      const r = arcRadius(e)
      const sweep = arcSweep(e)
      s += ((r * r) / 2) * (sweep - Math.sin(sweep))
    }
  }
  return s
}

/** Area of a region (outer loops minus holes). */
export function regionArea(r: Region): number {
  let s = 0
  for (const p of r.pieces) {
    s += Math.abs(signedArea(p.outer))
    for (const h of p.holes) s -= Math.abs(signedArea(h))
  }
  return s
}

/** The loop traversed backwards (the opposite orientation, same points). */
export function reverseLoop(l: Loop): Loop {
  const elements: Element[] = []
  for (let i = l.elements.length - 1; i >= 0; i--) {
    const e = l.elements[i]!
    elements.push(e.kind === 'line' ? line(e.b, e.a) : arc(e.b, e.a, e.centre, !e.ccw))
  }
  return { elements }
}

export interface Bounds2 {
  readonly min: Vec2
  readonly max: Vec2
}

/** Exact bounding box of the elements (arc extremes included); undefined for no elements. */
export function chainBounds(elements: readonly Element[]): Bounds2 | undefined {
  if (elements.length === 0) return undefined
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (p: Vec2) => {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  for (const e of elements) {
    add(e.a)
    add(e.b)
    if (e.kind === 'arc') {
      const r = arcRadius(e)
      const sweep = arcSweep(e)
      const start = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2
        if (onSweep(start, sweep, ang))
          add([e.centre[0] + r * Math.cos(ang), e.centre[1] + r * Math.sin(ang)])
      }
    }
  }
  return { min: [x0, y0], max: [x1, y1] }
}

/** Whether angle `ang` lies on the arc that starts at `start` and sweeps `sweep` (signed). */
export function onSweep(start: number, sweep: number, ang: number): boolean {
  if (Math.abs(sweep) >= TAU) return true
  if (sweep >= 0) return (((ang - start) % TAU) + TAU) % TAU <= sweep
  return (((start - ang) % TAU) + TAU) % TAU <= -sweep
}

/** Whether two boxes overlap or touch (grown by `eps`). */
export function boundsOverlap(a: Bounds2, b: Bounds2, eps = POSITION_EPSILON): boolean {
  return (
    a.min[0] <= b.max[0] + eps &&
    b.min[0] <= a.max[0] + eps &&
    a.min[1] <= b.max[1] + eps &&
    b.min[1] <= a.max[1] + eps
  )
}
