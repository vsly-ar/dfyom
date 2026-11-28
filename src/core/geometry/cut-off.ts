/**
 * The two sides of a cut-off (DF147 SL3): a through Line whose both ends lie on or past the edges
 * of its face splits the face into the material left and right of the line (from its start to its
 * end). Each side as a polygon in the face frame (arcs as chords), for the workholding's held-piece
 * test. Pure, headless.
 * Doc: docs/modes/engraved-patterns.md#cutting-the-part-out-along-a-line
 */
import type { Element } from './2d/model'
import { elementPoint } from './line'
import type { LineGeometry, Vec2 } from './model'
import { shapeOutline } from './outline'

/** One side of a cut-off: `left` or `right` of the line from its start to its end. */
export type CutOffSide = 'left' | 'right'

export interface CutOffPiece {
  readonly side: CutOffSide
  /** Counter-clockwise polygon in the face frame. */
  readonly polygon: readonly Vec2[]
  /** mm². */
  readonly area: number
}

/** Smallest side that counts as a piece (mm²). */
const MIN_AREA = 1

const signedArea = (p: readonly Vec2[]): number => {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    a += (p[j]![0] - p[i]![0]) * (p[j]![1] + p[i]![1])
  return a / 2
}

/** Sutherland–Hodgman: `subject` clipped to the rectangle 0..L × 0..W. */
function clipToRect(subject: readonly Vec2[], L: number, W: number): Vec2[] {
  const edges: [(p: Vec2) => number, (a: Vec2, b: Vec2) => Vec2][] = [
    [(p) => p[0], (a, b) => at(a, b, (a[0] - 0) / (a[0] - b[0]))],
    [(p) => L - p[0], (a, b) => at(a, b, (L - a[0]) / (b[0] - a[0]))],
    [(p) => p[1], (a, b) => at(a, b, (a[1] - 0) / (a[1] - b[1]))],
    [(p) => W - p[1], (a, b) => at(a, b, (W - a[1]) / (b[1] - a[1]))],
  ]
  let out: Vec2[] = [...subject]
  for (const [inside, cross] of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!
      const prev = input[(i + input.length - 1) % input.length]!
      const ci = inside(cur) >= 0
      const pi = inside(prev) >= 0
      if (ci) {
        if (!pi) out.push(cross(prev, cur))
        out.push(cur)
      } else if (pi) out.push(cross(prev, cur))
    }
    if (out.length === 0) return out
  }
  return out
}

const at = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
]

/** The elements' points, arcs every ≤ 5°. */
function points(elements: readonly Element[]): Vec2[] {
  const out: Vec2[] = []
  for (const e of elements) {
    let n = 1
    if (e.kind === 'arc') {
      const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
      const a1 = Math.atan2(e.b[1] - e.centre[1], e.b[0] - e.centre[0])
      let sweep = e.ccw ? a1 - a0 : a0 - a1
      while (sweep <= 0) sweep += 2 * Math.PI
      n = Math.max(1, Math.ceil(sweep / (Math.PI / 36)))
    }
    for (let k = out.length === 0 ? 0 : 1; k <= n; k++) {
      const p = elementPoint(e, k / n)
      out.push([p[0], p[1]])
    }
  }
  return out
}

const unit = (a: Vec2, b: Vec2): Vec2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1])
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

/**
 * The two sides of a through Line on its face (`length` × `width`, face frame), or undefined when
 * it is no cut-off: not through, not one open path, an end inside the face, or a side smaller
 * than 1 mm².
 */
export function cutOffPieces(
  op: Pick<LineGeometry, 'paths' | 'through'>,
  face: { readonly length: number; readonly width: number },
): CutOffPiece[] | undefined {
  if (op.through !== true || op.paths.length !== 1) return undefined
  const o = shapeOutline(op.paths[0]!)
  if (o.kind !== 'path') return undefined
  const pts = points(o.path.elements)
  if (pts.length < 2) return undefined
  const { length: L, width: W } = face
  const e = 1e-6
  const inside = (p: Vec2) => p[0] > e && p[0] < L - e && p[1] > e && p[1] < W - e
  if (inside(pts[0]!) || inside(pts.at(-1)!)) return undefined
  // the line run on far past the face along its end tangents, then closed far off to one side
  const F = 4 * (L + W)
  const t0 = unit(pts[1]!, pts[0]!)
  const t1 = unit(pts.at(-2)!, pts.at(-1)!)
  const e0: Vec2 = [pts[0]![0] + t0[0] * F, pts[0]![1] + t0[1] * F]
  const e1: Vec2 = [pts.at(-1)![0] + t1[0] * F, pts.at(-1)![1] + t1[1] * F]
  const run = [e0, ...pts, e1]
  const side = (s: CutOffSide): CutOffPiece | undefined => {
    // left of the forward direction: the forward tangent turned counter-clockwise
    const k = s === 'left' ? 1 : -1
    const n1: Vec2 = [-t1[1] * k, t1[0] * k]
    const n0: Vec2 = [t0[1] * k, -t0[0] * k]
    const poly: Vec2[] = [
      ...run,
      [e1[0] + n1[0] * F, e1[1] + n1[1] * F],
      [e0[0] + n0[0] * F, e0[1] + n0[1] * F],
    ]
    let clipped = clipToRect(poly, L, W)
    const a = signedArea(clipped)
    if (Math.abs(a) < MIN_AREA) return undefined
    if (a < 0) clipped = clipped.reverse()
    return { side: s, polygon: clipped, area: Math.abs(a) }
  }
  const left = side('left')
  const right = side('right')
  return left === undefined || right === undefined ? undefined : [left, right]
}

/** Even-odd point in polygon. */
export function polygonContains(poly: readonly Vec2[], p: Vec2): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      c = !c
  }
  return c
}
