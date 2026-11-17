/**
 * Offset-loft and offset band: the labelled mesh primitives every 2.5D solid is built from.
 * Doc: docs/architecture/geometry.md#offset-loft
 *
 * Meshes are plain typed arrays in a local frame (built near the origin: JS mesh I/O is float32)
 * and are labelled at construction: `faces[t]` is the index of triangle t in the owning
 * operation's surface table.
 */
import { fail, Ok, type AppResult, type Option } from '../../shared/result'
import {
  contourElements,
  contourFrame,
  contourParam,
  flattenPath,
  perimeter,
  flattenRing,
  offsetContour,
  parameterize,
  type ContourFrame,
  type ContourLabel,
  type FlattenMode,
} from './contour'
import { EPSILON, type Contour, type Level, type Vec2 } from './model'

export interface LabelledMesh {
  /** x, y, z per vertex (mm, local frame). */
  readonly positions: Float64Array
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly triangles: Uint32Array
  /** Surface-table index per triangle. */
  readonly faces: Uint32Array
}

export interface LoftLabels {
  /** Label of the band between level `k` and `k + 1` along contour element `label`. */
  band(k: number, label: ContourLabel): number
  /** Cap at the first (highest) level. */
  readonly top: number
  /** Cap at the last (lowest) level. */
  readonly bottom: number
}

export interface BandLabels {
  readonly top: number
  readonly bottom: number
  /** Both offset sides (outside the slot). */
  readonly side: number
  /** End faces at `from` and `to`, in contour direction. */
  readonly end: readonly [number, number]
}

export interface BandSpec {
  /** Arc length along the un-offset contour from the start of wall[0] (may wrap). */
  readonly from: number
  readonly to: number
  /** Offsets bounding the band; `inner` > `outer` (offset > 0 = inward). */
  readonly inner: number
  readonly outer: number
  readonly bottom: number
  readonly top: number
}

function invalid(message: string, data: Readonly<Record<string, unknown>>): AppResult<never> {
  return fail('geometry.evaluation', message, {
    issues: [{ path: [], rule: 'loftInvalid', message, params: data }],
    where: 'offsetLoft',
    data,
  })
}

/** Collects vertices and triangles; skips triangles with a repeated vertex. */
class MeshBuilder {
  private readonly pos: number[] = []
  private readonly tris: number[] = []
  private readonly faces: number[] = []

  vertex(p: Vec2, z: number): number {
    this.pos.push(p[0], p[1], z)
    return this.pos.length / 3 - 1
  }

  /**
   * Vertices for a polyline at height z; consecutive points within ε share one vertex
   * (collapsed arcs, zero-length segments). `closed` also merges the last into the first.
   */
  ring(points: readonly Vec2[], z: number, closed: boolean): number[] {
    const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPSILON
    // group consecutive coincident points; each group's first point is its representative
    const group: number[] = []
    const reps: Vec2[] = []
    for (const p of points) {
      if (reps.length > 0 && near(p, reps.at(-1)!)) group.push(reps.length - 1)
      else {
        group.push(reps.length)
        reps.push(p)
      }
    }
    const lastGroup = reps.length - 1
    const wrap = closed && lastGroup > 0 && near(reps[lastGroup]!, reps[0]!)
    const ids = reps.map((p, g) => (wrap && g === lastGroup ? -1 : this.vertex(p, z)))
    return group.map((g) => (wrap && g === lastGroup ? ids[0]! : ids[g]!))
  }

  tri(a: number, b: number, c: number, face: number): void {
    if (a === b || b === c || a === c) return
    this.tris.push(a, b, c)
    this.faces.push(face)
  }

  quad(a: number, b: number, c: number, d: number, face: number): void {
    this.tri(a, b, c, face)
    this.tri(a, c, d, face)
  }

  /** Fan over the distinct vertices of a convex ring; `up` = normal +z. */
  cap(ring: readonly number[], face: number, up: boolean): void {
    const u = ring.filter((v, i) => i === 0 || v !== ring[i - 1])
    if (u.length > 1 && u.at(-1) === u[0]) u.pop()
    for (let i = 1; i + 1 < u.length; i++)
      if (up) this.tri(u[0]!, u[i]!, u[i + 1]!, face)
      else this.tri(u[0]!, u[i + 1]!, u[i]!, face)
  }

  build(): LabelledMesh {
    return {
      positions: Float64Array.from(this.pos),
      triangles: Uint32Array.from(this.tris),
      faces: Uint32Array.from(this.faces),
    }
  }
}

function minRadius(c: Contour): number {
  return c.kind === 'circle' ? c.radius : c.cornerRadius
}

/**
 * Closed solid through the contour offset per level (top level first): ruled bands between
 * corresponding rings, fan caps (v0.1 rings are convex). Every contour radius must be ≥ the
 * largest inward offset (the bull-nose tool limit); otherwise `geometry.evaluation`, rule
 * `loftInvalid` – there is no silent fallback.
 */
export function offsetLoft(
  contour: Contour,
  levels: readonly Level[],
  labels: LoftLabels,
  mode: FlattenMode = 'inscribed',
): AppResult<LabelledMesh> {
  if (levels.length < 2)
    return invalid('a loft needs at least two levels', { levels: levels.length })
  for (let k = 1; k < levels.length; k++)
    if (levels[k]!.z > levels[k - 1]!.z + EPSILON)
      return invalid('loft levels must go downward', { level: k })
  if (levels[0]!.z - levels.at(-1)!.z <= EPSILON) return invalid('loft has no height', {})
  const maxOffset = Math.max(...levels.map((l) => l.offset))
  if (maxOffset > minRadius(contour) + EPSILON)
    return invalid('offset exceeds a contour radius', { maxOffset, radius: minRadius(contour) })

  const p = parameterize(
    contour,
    levels.map((l) => l.offset),
    mode,
  )
  const b = new MeshBuilder()
  const rings: { idx: number[]; labels: ContourLabel[] }[] = []
  for (const level of levels) {
    const slots = flattenRing(p, level.offset)
    if (slots.isNone()) return invalid('offset passes the contour center', { offset: level.offset })
    const s = slots.unwrap()
    rings.push({
      idx: b.ring(
        s.map((x) => x.point),
        level.z,
        true,
      ),
      labels: s.map((x) => x.label),
    })
  }
  b.cap(rings[0]!.idx, labels.top, true)
  for (let k = 0; k + 1 < rings.length; k++) {
    const up = rings[k]!.idx
    const lo = rings[k + 1]!.idx
    const n = up.length
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n
      b.quad(lo[j]!, lo[j1]!, up[j1]!, up[j]!, labels.band(k, rings[0]!.labels[j]!))
    }
  }
  b.cap(rings.at(-1)!.idx, labels.bottom, false)
  return Ok(b.build())
}

/**
 * Offset band (tabs) between arc lengths `from` and `to`, from `bottom` to `top`: the points
 * whose nearest contour point lies in `from`..`to`, between offsets `outer` and `inner`.
 *
 * - Far side: the contour offset by `outer`.
 * - End faces: the straight segment on the contour's inward normal at each end point, from
 *   `outer` inward. Where the normal reaches the medial axis before `inner` (an arc centre, or a
 *   corner bisector next to a corner smaller than `inner`), the end face bends there and follows
 *   the medial axis to the inset corner: beyond it the points are nearest to another element.
 * - Near side: the contour offset by `inner` between the end faces.
 * Where both end faces meet on the medial axis (a tab within one corner), the band closes there.
 * The outline is a simple polygon, triangulated by ear clipping.
 */
export function offsetBand(
  contour: Contour,
  spec: BandSpec,
  labels: BandLabels,
): AppResult<LabelledMesh> {
  const data = { from: spec.from, to: spec.to, inner: spec.inner, outer: spec.outer }
  if (spec.to - spec.from <= EPSILON) return invalid('band has no length', data)
  if (spec.inner - spec.outer <= EPSILON) return invalid('band has no width', data)
  if (spec.top - spec.bottom <= EPSILON) return invalid('band has no height', data)
  const farSide = flattenPath(parameterize(contour, [spec.outer]), spec.outer, spec.from, spec.to)
  const inset = offsetContour(contour, spec.inner)
  const e0 = endFace(contour, spec.from, spec.inner)
  const e1 = endFace(contour, spec.to, spec.inner)
  if (farSide.isNone() || inset.isNone() || e0.isNone() || e1.isNone())
    return invalid('band offset passes the contour center', data)
  const [end0, end1, insetContour] = [e0.unwrap(), e1.unwrap(), inset.unwrap()]

  // far side, with its ends exactly on the end faces
  const far = [...farSide.unwrap()]
  far[0] = along(end0, spec.outer)
  far[far.length - 1] = along(end1, spec.outer)

  // near side: the inset contour between the end faces' attachment points
  const a0 = contourParam(insetContour, end0.attach)
  let a1 = contourParam(insetContour, end1.attach)
  const insetLength = perimeter(insetContour)
  a1 = a0 + ((((a1 - a0) % insetLength) + insetLength) % insetLength)
  // the inset is never longer than the band; anything longer means the ends met or crossed
  if (a1 - a0 > spec.to - spec.from + EPSILON) a1 = a0
  const near =
    a1 - a0 > EPSILON ? flattenPath(parameterize(insetContour, [0]), 0, a0, a1).unwrapOr([]) : []

  // outline (counter-clockwise from above), each point with the label of the edge leaving it
  const outline: Vertex[] = far.map((p, i) => ({
    p,
    edge: i === far.length - 1 ? labels.end[1] : labels.side,
  }))
  outline.push({ p: end1.bend, edge: end1.bent ? labels.end[1] : labels.side })
  if (end1.bent) outline.push({ p: end1.attach, edge: labels.side })
  for (let i = near.length - 2; i >= 1; i--) outline.push({ p: near[i]!, edge: labels.side })
  if (end0.bent) outline.push({ p: end0.attach, edge: labels.end[0] })
  outline.push({ p: end0.bend, edge: labels.end[0] })

  const poly = simplify(outline)
  const caps = earClip(poly.map((v) => v.p))
  if (caps === undefined) return invalid('tab outline is not a simple polygon', data)

  const b = new MeshBuilder()
  const bot = poly.map((v) => b.vertex(v.p, spec.bottom))
  const top = poly.map((v) => b.vertex(v.p, spec.top))
  for (const [i, j, k] of caps) {
    b.tri(top[i]!, top[j]!, top[k]!, labels.top)
    b.tri(bot[i]!, bot[k]!, bot[j]!, labels.bottom)
  }
  poly.forEach((v, i) => {
    const j = (i + 1) % poly.length
    b.quad(bot[i]!, bot[j]!, top[j]!, top[i]!, v.edge)
  })
  return Ok(b.build())
}

interface EndFace extends ContourFrame {
  /** Where the end face leaves the normal: at `inner`, or on the medial axis. */
  readonly bend: Vec2
  /** True if it then follows the medial axis to `attach` (the inset corner). */
  readonly bent: boolean
  /** Where the end face meets the inset contour. */
  readonly attach: Vec2
}

const along = (f: ContourFrame, t: number): Vec2 => [
  f.point[0] + f.normal[0] * t,
  f.point[1] + f.normal[1] * t,
]

/**
 * The end face at arc length `s`: how far the normal runs before it meets the medial axis
 * (rectangles only – a circle's medial axis is its centre, never nearer than `inner`).
 */
function endFace(contour: Contour, s: number, inner: number): Option<EndFace> {
  return contourFrame(contour, s).map((f) => {
    const straight = { ...f, bend: along(f, inner), bent: false, attach: along(f, inner) }
    if (contour.kind === 'circle') return straight
    const r = contour.cornerRadius
    const els = contourElements(contour)
    const n = els.length
    // [depth where the normal meets a corner's medial axis, that corner's element index]
    const limits: [number, number][] =
      els[f.element]!.kind === 'arc'
        ? [[r, f.element]]
        : [
            [r + f.along, (f.element + n - 1) % n],
            [r + (f.length - f.along), (f.element + 1) % n],
          ]
    const [depth, corner] = limits.reduce((m, l) => (l[0] < m[0] ? l : m))
    if (depth >= inner - EPSILON) return straight
    const arc = els[corner]!
    if (arc.kind !== 'arc') return straight
    const mid = arc.start + arc.sweep / 2
    const insetCorner: Vec2 = [
      Math.sign(Math.cos(mid)) * (contour.length / 2 - inner),
      Math.sign(Math.sin(mid)) * (contour.width / 2 - inner),
    ]
    return { ...f, bend: along(f, depth), bent: true, attach: insetCorner }
  })
}

interface Vertex {
  p: Vec2
  edge: number
}

/**
 * Drop repeated points (the later edge label survives) and spikes where the outline doubles
 * back on itself along a line (two end faces meeting on the medial axis).
 */
function simplify(outline: readonly Vertex[]): Vertex[] {
  const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPSILON
  let out = outline.map((v) => ({ ...v }))
  for (let changed = true; changed;) {
    changed = false
    const next: Vertex[] = []
    for (const v of out) {
      const last = next.at(-1)
      if (last !== undefined && same(last.p, v.p)) {
        last.edge = v.edge
        changed = true
      } else next.push(v)
    }
    while (next.length > 1 && same(next.at(-1)!.p, next[0]!.p)) {
      next.pop()
      changed = true
    }
    for (let i = 0; next.length > 3 && i < next.length; i++) {
      const a = next[(i + next.length - 1) % next.length]!.p
      const v = next[i]!.p
      const c = next[(i + 1) % next.length]!.p
      const u: Vec2 = [v[0] - a[0], v[1] - a[1]]
      const w: Vec2 = [c[0] - v[0], c[1] - v[1]]
      const collinear =
        Math.abs(u[0] * w[1] - u[1] * w[0]) <= 1e-9 * Math.hypot(...u) * Math.hypot(...w)
      if (collinear && u[0] * w[0] + u[1] * w[1] < 0) {
        // what remains of the two overlapping edges lies within the longer one: keep its label
        const prev = next[(i + next.length - 1) % next.length]!
        if (Math.hypot(...w) > Math.hypot(...u)) prev.edge = next[i]!.edge
        next.splice(i, 1)
        changed = true
        break
      }
    }
    out = next
  }
  return out
}

const cross = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/**
 * Ear clipping of a simple counter-clockwise polygon. Collinear vertices are clipped last as
 * zero-area ears so every vertex stays in the cap (no T-junctions with the side faces).
 * Undefined if no ear is found (not simple).
 */
function earClip(points: readonly Vec2[]): [number, number, number][] | undefined {
  const idx = points.map((_, i) => i)
  const tris: [number, number, number][] = []
  const inside = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    cross(a, b, p) > 1e-12 && cross(b, c, p) > 1e-12 && cross(c, a, p) > 1e-12
  while (idx.length > 3) {
    let clipped = false
    for (const strict of [true, false]) {
      for (let k = 0; k < idx.length && !clipped; k++) {
        const [i, j, l] = [
          idx[(k + idx.length - 1) % idx.length]!,
          idx[k]!,
          idx[(k + 1) % idx.length]!,
        ]
        const [a, b, c] = [points[i]!, points[j]!, points[l]!]
        const turn = cross(a, b, c)
        if (strict ? turn <= 1e-12 : turn < -1e-12) continue
        if (idx.some((m) => m !== i && m !== j && m !== l && inside(points[m]!, a, b, c))) continue
        tris.push([i, j, l])
        idx.splice(k, 1)
        clipped = true
      }
      if (clipped) break
    }
    if (!clipped) return undefined
  }
  if (idx.length === 3) tris.push([idx[0]!, idx[1]!, idx[2]!])
  return tris
}
