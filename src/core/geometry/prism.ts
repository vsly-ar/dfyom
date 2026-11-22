/**
 * Labelled prisms of general regions (v0.3 G1) and tiled boxes: regions of lines and arcs
 * flattened at the chord tolerance, walls per chord labelled by element, caps triangulated with
 * holes by Manifold's `triangulate`; boxes whose faces are split into tiles of their own face id.
 * Doc: docs/architecture/shapes.md#geometry-for-shape-operations, #implementation-g1
 *
 * Meshes are plain typed arrays in the operation's face frame (float64); `operations.ts` places
 * every vertex into the part frame before the float32 mesh I/O.
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import { arcSegments } from './contour'
import type { LabelledMesh } from './loft'
import { CHORD_TOLERANCE, EPSILON, FACE_TILE, type Vec2, type Vec3 } from './model'
import { arcRadius, arcSweep, regionLoops, type Element, type Loop, type Region } from './2d/model'

/**
 * Which way the flattening errs (the region is on the left of every loop: outer loops
 * counter-clockwise, holes clockwise):
 * - `shrink`: every chord inside the region – counter-clockwise arcs inscribed, clockwise arcs
 *   circumscribed (removals and retained regions: meshes keep slightly more material);
 * - `grow`: every chord outside it – the opposite (the kept side subtracted from a slot).
 */
export type FlattenSense = 'shrink' | 'grow'

/** One flattened loop: its points and, per chord `points[i] → points[i + 1]`, the element index. */
export interface Ring {
  readonly points: readonly Vec2[]
  readonly element: readonly number[]
}

/** Manifold's `triangulate` (`SolidPort.triangulate`). */
export type Triangulate = (rings: readonly (readonly Vec2[])[]) => AppResult<Uint32Array>

/** The points of one element from its start (its end is the next element's start). */
function elementPoints(e: Element, sense: FlattenSense, tolerance: number): Vec2[] {
  if (e.kind === 'line') return [e.a]
  const sweep = arcSweep(e)
  const r = arcRadius(e)
  const inscribed = e.ccw === (sense === 'shrink')
  const n = arcSegments(r, Math.abs(sweep), tolerance, inscribed ? 'inscribed' : 'circumscribed')
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const alpha = sweep / n
  const out: Vec2[] = [e.a]
  if (inscribed) {
    for (let k = 1; k < n; k++)
      out.push([
        e.centre[0] + r * Math.cos(a0 + k * alpha),
        e.centre[1] + r * Math.sin(a0 + k * alpha),
      ])
  } else {
    // edges tangent to the arc: vertices at r / cos(α/2) between the tangent points
    const rOut = r / Math.cos(alpha / 2)
    for (let k = 0; k < n; k++) {
      const t = a0 + (k + 0.5) * alpha
      out.push([e.centre[0] + rOut * Math.cos(t), e.centre[1] + rOut * Math.sin(t)])
    }
  }
  return out
}

/**
 * A loop flattened within `tolerance` of its elements, erring as `sense` says; chords carry the
 * element index `first + i`. Points closer than ε to the previous one are dropped.
 */
export function flattenLoop(
  loop: Loop,
  sense: FlattenSense,
  first = 0,
  tolerance = CHORD_TOLERANCE,
): Ring {
  const points: Vec2[] = []
  const element: number[] = []
  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPSILON
  loop.elements.forEach((e, i) => {
    for (const p of elementPoints(e, sense, tolerance)) {
      if (points.length > 0 && near(points.at(-1)!, p)) continue
      points.push(p)
      element.push(first + i)
    }
  })
  while (points.length > 1 && near(points.at(-1)!, points[0]!)) {
    points.pop()
    element.pop()
  }
  return { points, element }
}

/**
 * Every loop of a region flattened (per piece the outer loop, then its holes), element indices
 * running across all loops: `wall[i]` / `corner[i]` of design-v0.3.md#surfaces.
 */
export function flattenRegion(
  region: Region,
  sense: FlattenSense,
  tolerance = CHORD_TOLERANCE,
): Ring[] {
  let first = 0
  return regionLoops(region).map((loop) => {
    const ring = flattenLoop(loop, sense, first, tolerance)
    first += loop.elements.length
    return ring
  })
}

/** Chords of flattened rings (the evaluation cost measure, docs/architecture/shapes.md#performance). */
export const chordCount = (rings: readonly Ring[]): number =>
  rings.reduce((n, r) => n + r.points.length, 0)

export interface PrismLabels {
  /** Face of the wall quad on the chord `a → b` of element `element`. */
  wall(element: number, a: Vec2, b: Vec2): number
  /** Cap at `top`. */
  readonly top: number
  /** Cap at `bottom`. */
  readonly bottom: number
}

function prismError(message: string, data: Readonly<Record<string, unknown>>): AppResult<never> {
  return fail('geometry.evaluation', message, {
    issues: [{ path: [], rule: 'prismInvalid', message, params: data }],
    where: 'prismMesh',
    data,
  })
}

/**
 * Closed prism `bottom..top` (z along the face normal) of flattened rings in the face frame:
 * a wall quad per chord (outward on the right of each ring's direction), both caps from one
 * `triangulate` call. Rings of fewer than 3 points are left out.
 */
export function prismMesh(
  rings: readonly Ring[],
  top: number,
  bottom: number,
  labels: PrismLabels,
  triangulate: Triangulate,
): AppResult<LabelledMesh> {
  const used = rings.filter((r) => r.points.length >= 3)
  if (used.length === 0) return prismError('prism has no loop', { rings: rings.length })
  if (top - bottom <= EPSILON) return prismError('prism has no height', { top, bottom })
  const total = chordCount(used)
  const caps = triangulate(used.map((r) => r.points))
  if (caps.isErr()) return caps
  const cap = caps.unwrap()
  const capCount = cap.length / 3
  const positions = new Float64Array(total * 6)
  // vertex i: bottom ring point i; vertex total + i: top ring point i
  let v = 0
  for (const { points } of used)
    for (const p of points) {
      positions[3 * v] = p[0]
      positions[3 * v + 1] = p[1]
      positions[3 * v + 2] = bottom
      positions[3 * (v + total)] = p[0]
      positions[3 * (v + total) + 1] = p[1]
      positions[3 * (v + total) + 2] = top
      v++
    }
  const count = 2 * total + 2 * capCount
  const triangles = new Uint32Array(3 * count)
  const faces = new Uint32Array(count)
  let t = 0
  const tri = (a: number, b: number, c: number, face: number) => {
    triangles[3 * t] = a
    triangles[3 * t + 1] = b
    triangles[3 * t + 2] = c
    faces[t++] = face
  }
  let base = 0
  for (const { points, element } of used) {
    const n = points.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const face = labels.wall(element[i]!, points[i]!, points[j]!)
      const bp = base + i
      const bq = base + j
      tri(bp, bq, bq + total, face)
      tri(bp, bq + total, bp + total, face)
    }
    base += n
  }
  for (let k = 0; k < capCount; k++) {
    const [a, b, c] = [cap[3 * k]!, cap[3 * k + 1]!, cap[3 * k + 2]!]
    tri(a + total, b + total, c + total, labels.top)
    tri(a, c, b, labels.bottom)
  }
  return Ok({ positions, triangles, faces })
}

/** The six faces of a box: `top` (+z), `bottom` (−z), `side[0..3]` (−y, +x, +y, −x). */
export type BoxFace = 'top' | 'bottom' | 'side[0]' | 'side[1]' | 'side[2]' | 'side[3]'

/**
 * A closed box `min..max` whose faces are split into tiles of at most `tile` mm along each edge
 * (one grid for the whole box, so neighbouring faces share their edge vertices). `face` is
 * called once per tile and returns its face label: give every tile of a referenceable face its
 * own index (Manifold re-triangulates each face id crossed by a cut as one polygon, in time
 * quadratic in the chords crossing it; tiles bound that polygon, S3).
 */
export function tiledBox(
  min: Vec3,
  max: Vec3,
  face: (f: BoxFace) => number,
  tile = FACE_TILE,
): LabelledMesh {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const n = size.map((s) => Math.max(1, Math.ceil(s / tile - 1e-9)))
  const coord = (axis: number, i: number) =>
    i === n[axis] ? max[axis]! : min[axis]! + (size[axis]! * i) / n[axis]!
  const index = new Map<number, number>()
  const pos: number[] = []
  const stride = [1, n[0]! + 1, (n[0]! + 1) * (n[1]! + 1)]
  const vertex = (ijk: readonly number[]): number => {
    const key = ijk[0]! * stride[0]! + ijk[1]! * stride[1]! + ijk[2]! * stride[2]!
    let v = index.get(key)
    if (v === undefined) {
      v = pos.length / 3
      pos.push(coord(0, ijk[0]!), coord(1, ijk[1]!), coord(2, ijk[2]!))
      index.set(key, v)
    }
    return v
  }
  const tris: number[] = []
  const faces: number[] = []
  // (face, fixed axis, at max?, a, b) with a × b = the outward normal
  const sides: [BoxFace, number, boolean, number, number][] = [
    ['top', 2, true, 0, 1],
    ['bottom', 2, false, 1, 0],
    ['side[0]', 1, false, 0, 2],
    ['side[1]', 0, true, 1, 2],
    ['side[2]', 1, true, 2, 0],
    ['side[3]', 0, false, 2, 1],
  ]
  for (const [name, fixed, atMax, a, b] of sides)
    for (let i = 0; i < n[a]!; i++)
      for (let j = 0; j < n[b]!; j++) {
        const label = face(name)
        const at = (di: number, dj: number) => {
          const ijk = [0, 0, 0]
          ijk[fixed] = atMax ? n[fixed]! : 0
          ijk[a] = i + di
          ijk[b] = j + dj
          return vertex(ijk)
        }
        const [p, q, r, s] = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)]
        tris.push(p, q, r, p, r, s)
        faces.push(label, label)
      }
  return {
    positions: Float64Array.from(pos),
    triangles: Uint32Array.from(tris),
    faces: Uint32Array.from(faces),
  }
}
