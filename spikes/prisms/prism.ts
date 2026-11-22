/**
 * Spike S3: labelled prism of a flattened region – walls per chord labelled by element, caps
 * triangulated with holes by Manifold's `triangulate`. Built in the face frame; placed either as
 * v0.2 does (mesh around a local offset, floor level in the float64 placement) or with every
 * vertex placed into the part frame in float64 before the float32 mesh I/O.
 * Report: spikes/prisms/results.md. Throwaway code, not part of the app.
 */
import type { LabelledMesh } from '../../src/core/geometry/loft'
import {
  placeAt,
  applyPlacement,
  translation,
  type Placement,
  type Vec2,
  type Vec3,
} from '../../src/core/geometry/model'
import type { PlacedMesh } from '../../src/core/geometry/operations'
import type { Ring } from './region'

/** Manifold's `triangulate` (polygons CCW, holes CW) → index triples into the concatenated points. */
export type Triangulate = (polygons: Vec2[][], epsilon?: number) => readonly (readonly number[])[]

/** Surface table: index 0 `air` (top cap), 1 `floor`, then `wall[i]` / `corner[i]` per element. */
export interface PrismLabels {
  readonly surfaces: readonly string[]
  /** Face index of element `i`. */
  readonly element: readonly number[]
}

export const AIR = 0
export const FLOOR = 1

export function prismLabels(kinds: readonly ('line' | 'arc')[]): PrismLabels {
  return {
    surfaces: ['air', 'floor', ...kinds.map((k, i) => `${k === 'line' ? 'wall' : 'corner'}[${i}]`)],
    element: kinds.map((_, i) => i + 2),
  }
}

export interface PrismTimings {
  triangulate: number
  build: number
}

/**
 * Closed prism `zBottom..zTop` (face frame, z along `n`) of `rings`, with vertices shifted by
 * `-at`. The floor (bottom cap) is labelled `floor`, the top cap `air`, wall quads by element.
 */
export function prismMesh(
  rings: readonly Ring[],
  zTop: number,
  zBottom: number,
  labels: PrismLabels,
  triangulate: Triangulate,
  at: Vec3 = [0, 0, 0],
  timings?: PrismTimings,
): LabelledMesh {
  const t0 = performance.now()
  const total = rings.reduce((n, r) => n + r.points.length, 0)
  const positions = new Float64Array(total * 6)
  // vertex i: bottom ring point i; vertex total + i: top ring point i
  let v = 0
  for (const { points } of rings)
    for (const p of points) {
      positions.set([p[0] - at[0], p[1] - at[1], zBottom - at[2]], 3 * v)
      positions.set([p[0] - at[0], p[1] - at[1], zTop - at[2]], 3 * (v + total))
      v++
    }
  const t1 = performance.now()
  const caps = triangulate(rings.map((r) => r.points as Vec2[]))
  const t2 = performance.now()
  const walls = total * 2
  const tris = new Uint32Array((walls + caps.length * 2) * 3)
  const faces = new Uint32Array(walls + caps.length * 2)
  let t = 0
  const tri = (a: number, b: number, c: number, face: number) => {
    tris[3 * t] = a
    tris[3 * t + 1] = b
    tris[3 * t + 2] = c
    faces[t++] = face
  }
  let base = 0
  for (const { points, element } of rings) {
    const n = points.length
    for (let i = 0; i < n; i++) {
      const bp = base + i
      const bq = base + ((i + 1) % n)
      const face = labels.element[element[i]!]!
      // outward normal on the right of p → q (outer CCW, holes CW)
      tri(bp, bq, bq + total, face)
      tri(bp, bq + total, bp + total, face)
    }
    base += n
  }
  for (const c of caps) {
    tri(c[0]! + total, c[1]! + total, c[2]! + total, AIR) // top: CCW from above
    tri(c[0]!, c[2]!, c[1]!, FLOOR) // floor: normal −z
  }
  const t3 = performance.now()
  if (timings) {
    timings.triangulate += t2 - t1
    timings.build += t1 - t0 + (t3 - t2)
  }
  return { positions, triangles: tris.subarray(0, 3 * t), faces: faces.subarray(0, t) }
}

/** How a face-frame mesh reaches the part frame. */
export type PlacementMode =
  /** v0.2: vertices around the bounding-box centre, floor level in the float64 placement. */
  | 'local'
  /** Every vertex placed into the part frame in float64, then float32 (identity placement). */
  | 'part'

/**
 * A pocket prism of `rings` from `zTop` (overshoot above the face) down to the floor `zFloor`,
 * placed by `frame` according to `mode`.
 */
export function placedPrism(
  rings: readonly Ring[],
  zTop: number,
  zFloor: number,
  labels: PrismLabels,
  triangulate: Triangulate,
  frame: Placement,
  mode: PlacementMode,
  timings?: PrismTimings,
): PlacedMesh {
  if (mode === 'local') {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const { points } of rings)
      for (const [x, y] of points) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    const at: Vec3 = [(x0 + x1) / 2, (y0 + y1) / 2, zFloor]
    const mesh = prismMesh(rings, zTop, zFloor, labels, triangulate, at, timings)
    return { mesh, place: placeAt(frame, at) }
  }
  const mesh = prismMesh(rings, zTop, zFloor, labels, triangulate, [0, 0, 0], timings)
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    const q = applyPlacement(frame, [p[i]!, p[i + 1]!, p[i + 2]!])
    p[i] = q[0]
    p[i + 1] = q[1]
    p[i + 2] = q[2]
  }
  return { mesh, place: translation([0, 0, 0]) }
}
