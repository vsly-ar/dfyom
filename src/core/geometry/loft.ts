/**
 * Offset-loft and offset band: the labelled mesh primitives every 2.5D solid is built from.
 * Doc: docs/architecture/geometry.md#offset-loft
 *
 * Meshes are plain typed arrays in a local frame (built near the origin: JS mesh I/O is float32)
 * and are labelled at construction: `faces[t]` is the index of triangle t in the owning
 * operation's surface table.
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import {
  flattenPath,
  flattenRing,
  offsetContour,
  parameterize,
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
 * Offset band (tabs): the open sub-path of the contour between arc lengths `from` and `to`,
 * spanning offsets `outer`..`inner` (across the slot plus overshoot), from `bottom` to `top`.
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
  if (offsetContour(contour, spec.inner).isNone())
    return invalid('band offset passes the contour center', data)
  const p = parameterize(contour, [spec.inner, spec.outer])
  const inner = flattenPath(p, spec.inner, spec.from, spec.to).unwrap()
  const outer = flattenPath(p, spec.outer, spec.from, spec.to).unwrap()
  const b = new MeshBuilder()
  const ib = b.ring(inner, spec.bottom, false)
  const it = b.ring(inner, spec.top, false)
  const ob = b.ring(outer, spec.bottom, false)
  const ot = b.ring(outer, spec.top, false)
  const m = inner.length
  for (let j = 0; j + 1 < m; j++) {
    const j1 = j + 1
    b.quad(it[j]!, ot[j]!, ot[j1]!, it[j1]!, labels.top)
    b.quad(ib[j]!, ib[j1]!, ob[j1]!, ob[j]!, labels.bottom)
    b.quad(ob[j]!, ob[j1]!, ot[j1]!, ot[j]!, labels.side)
    b.quad(ib[j1]!, ib[j]!, it[j]!, it[j1]!, labels.side)
  }
  b.quad(ib[0]!, ob[0]!, ot[0]!, it[0]!, labels.end[0])
  const e = m - 1
  b.quad(ib[e]!, it[e]!, ot[e]!, ob[e]!, labels.end[1])
  return Ok(b.build())
}
