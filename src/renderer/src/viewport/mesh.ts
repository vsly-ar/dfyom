// Evaluated part mesh → render buffers, and raycast face → surface id. Pure (no three.js), so it
// is unit-tested in Node. Doc: docs/architecture/geometry.md#worker-and-renderer,
// docs/conventions/ui.md#selection-and-picking
import type { PartEvaluation } from '../../../core/geometry/evaluate'
import type { SurfaceId } from '../../../core/geometry/model'

/** What the viewport draws of an evaluation: `PartEvaluation` satisfies it as is. */
export type ViewportMesh = Pick<
  PartEvaluation,
  'positions' | 'indices' | 'triangleSurface' | 'surfaces'
>

export type Vec3 = readonly [number, number, number]

/** Axis-aligned box in the part frame (mm). */
export interface Box {
  readonly min: Vec3
  readonly max: Vec3
}

/** A surface under the pointer, with the operation (or `stock`) that owns it. */
export interface SurfaceTarget {
  readonly surface: SurfaceId
  readonly operation: string
}

/**
 * The operation owning a surface: surface ids are `<operation id>.<role>` (geometry.md#surface-ids),
 * stock surfaces are `stock.<role>`.
 */
export function surfaceOwner(surface: SurfaceId): string {
  const dot = surface.indexOf('.')
  return dot < 0 ? surface : surface.slice(0, dot)
}

export function triangleCount(mesh: ViewportMesh): number {
  return Math.floor(mesh.indices.length / 3)
}

/**
 * The surface of a raycast hit. The render geometry is non-indexed with triangles in mesh order
 * (`expandMesh`), so three.js' `faceIndex` is the mesh's triangle index. `undefined` for an index
 * outside the mesh (a stale hit after the mesh was replaced).
 */
export function surfaceAtFace(
  mesh: ViewportMesh,
  faceIndex: number | undefined | null,
): SurfaceTarget | undefined {
  if (faceIndex == null || faceIndex < 0 || faceIndex >= triangleCount(mesh)) return undefined
  const surface = mesh.surfaces[mesh.triangleSurface[faceIndex] ?? -1]
  return surface === undefined ? undefined : { surface, operation: surfaceOwner(surface) }
}

/** Faces meeting at a smaller angle than this are smoothed (fillets, cylinders); larger angles stay sharp. */
export const CREASE_ANGLE_DEG = 30

export interface RenderBuffers {
  /** 9 floats per triangle (non-indexed), part frame, mm. */
  readonly positions: Float32Array
  /** 9 floats per triangle: per-corner normals. */
  readonly normals: Float32Array
  readonly triangles: number
}

/**
 * Non-indexed buffers with **normals per surface**: a corner's normal averages (area-weighted) the
 * triangles around its vertex that belong to the same surface and lie within `creaseDeg` of the
 * corner's own triangle. Planes stay flat, fillets and drill walls come out smooth, and a sharp
 * edge inside one surface (a pocket wall with `cornerRadius` 0) stays sharp.
 */
export function expandMesh(
  mesh: ViewportMesh,
  creaseDeg: number = CREASE_ANGLE_DEG,
): RenderBuffers {
  const { positions: p, indices, triangleSurface } = mesh
  const n = triangleCount(mesh)
  // Face normals, area-weighted (length = 2 × area) and unit.
  const raw = new Float64Array(n * 3)
  const unit = new Float64Array(n * 3)
  for (let t = 0; t < n; t++) {
    const a = indices[3 * t]! * 3
    const b = indices[3 * t + 1]! * 3
    const c = indices[3 * t + 2]! * 3
    const ux = p[b]! - p[a]!
    const uy = p[b + 1]! - p[a + 1]!
    const uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!
    const vy = p[c + 1]! - p[a + 1]!
    const vz = p[c + 2]! - p[a + 2]!
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    raw[3 * t] = nx
    raw[3 * t + 1] = ny
    raw[3 * t + 2] = nz
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      unit[3 * t] = nx / len
      unit[3 * t + 1] = ny / len
      unit[3 * t + 2] = nz / len
    }
  }
  // Triangles around each vertex (CSR).
  const vertexCount = Math.floor(p.length / 3)
  const start = new Uint32Array(vertexCount + 1)
  for (let i = 0; i < n * 3; i++) start[indices[i]! + 1]!++
  for (let v = 0; v < vertexCount; v++) start[v + 1]! += start[v]!
  const fill = start.slice(0, vertexCount)
  const around = new Uint32Array(n * 3)
  for (let i = 0; i < n * 3; i++) around[fill[indices[i]!]!++] = Math.floor(i / 3)

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180)
  const positions = new Float32Array(n * 9)
  const normals = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * t + k]!
      const o = 9 * t + 3 * k
      positions[o] = p[3 * v]!
      positions[o + 1] = p[3 * v + 1]!
      positions[o + 2] = p[3 * v + 2]!
      let sx = 0
      let sy = 0
      let sz = 0
      for (let j = start[v]!; j < start[v + 1]!; j++) {
        const u = around[j]!
        if (triangleSurface[u] !== triangleSurface[t]) continue
        const dot =
          unit[3 * u]! * unit[3 * t]! +
          unit[3 * u + 1]! * unit[3 * t + 1]! +
          unit[3 * u + 2]! * unit[3 * t + 2]!
        if (u !== t && dot < cosCrease) continue
        sx += raw[3 * u]!
        sy += raw[3 * u + 1]!
        sz += raw[3 * u + 2]!
      }
      const len = Math.hypot(sx, sy, sz)
      if (len > 0) {
        normals[o] = sx / len
        normals[o + 1] = sy / len
        normals[o + 2] = sz / len
      } else {
        normals[o + 2] = 1
      }
    }
  }
  return { positions, normals, triangles: n }
}

/** Bounds of the mesh vertices; `undefined` for an empty mesh. */
export function meshBounds(mesh: ViewportMesh): Box | undefined {
  const p = mesh.positions
  if (p.length < 3) return undefined
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = p[i + k]!
      if (x < min[k]!) min[k] = x
      if (x > max[k]!) max[k] = x
    }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

/** The smallest box containing both (either may be missing). */
export function unionBox(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a) return b
  if (!b) return a
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

/** Distinct owning operations in mesh order (for the text summary). */
export function meshOperations(mesh: ViewportMesh): string[] {
  return [...new Set(mesh.surfaces.map(surfaceOwner))]
}

/** Where a surface's normal glyph stands: a point on the surface and its outward unit normal. */
export interface SurfaceGlyph {
  readonly surface: SurfaceId
  readonly at: Vec3
  readonly normal: Vec3
}

/**
 * Normal glyphs of the given (planar) surfaces for pick mode (ui.md#design-and-plan-controls-v02):
 * each at the area-weighted centroid of its triangles when that lies on the surface, else at the
 * centroid of the surface's triangle nearest to it (a stock top around a pocket is a ring, its
 * centroid would sit over the hole); the normal is the area-weighted mean of the triangles'.
 * Surfaces missing from the mesh get none. Mesh order.
 */
export function surfaceGlyphs(
  mesh: ViewportMesh,
  surfaces: ReadonlySet<SurfaceId>,
): SurfaceGlyph[] {
  const { positions: p, indices } = mesh
  const wanted = new Map<number, number[]>()
  mesh.surfaces.forEach((s, i) => {
    if (surfaces.has(s)) wanted.set(i, [])
  })
  const n = triangleCount(mesh)
  for (let t = 0; t < n; t++) wanted.get(mesh.triangleSurface[t]!)?.push(t)
  const corner = (t: number, k: number): Vec3 => {
    const v = indices[3 * t + k]! * 3
    return [p[v]!, p[v + 1]!, p[v + 2]!]
  }
  const out: SurfaceGlyph[] = []
  for (const [index, tris] of wanted) {
    if (tris.length === 0) continue
    let area = 0
    const c = [0, 0, 0]
    const nn = [0, 0, 0]
    const centres: Vec3[] = []
    for (const t of tris) {
      const [a, b, d] = [corner(t, 0), corner(t, 1), corner(t, 2)]
      const cr = cross(sub(b, a), sub(d, a))
      const w = Math.hypot(...cr) / 2
      const centre: Vec3 = [
        (a[0] + b[0] + d[0]) / 3,
        (a[1] + b[1] + d[1]) / 3,
        (a[2] + b[2] + d[2]) / 3,
      ]
      centres.push(centre)
      area += w
      for (let k = 0; k < 3; k++) {
        c[k]! += centre[k]! * w
        nn[k]! += cr[k]!
      }
    }
    const len = Math.hypot(nn[0]!, nn[1]!, nn[2]!)
    if (area <= 0 || len === 0) continue
    const centroid: Vec3 = [c[0]! / area, c[1]! / area, c[2]! / area]
    const inside = tris.some((t) => inTriangle(centroid, corner(t, 0), corner(t, 1), corner(t, 2)))
    const at = inside
      ? centroid
      : centres.reduce((best, x) => (dist2(x, centroid) < dist2(best, centroid) ? x : best))
    out.push({
      surface: mesh.surfaces[index]!,
      at,
      normal: [nn[0]! / len, nn[1]! / len, nn[2]! / len],
    })
  }
  return out
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const dist2 = (a: Vec3, b: Vec3): number => dot(sub(a, b), sub(a, b))

/** True if `q` (in the triangle's plane) lies in the triangle `a b c` (edges included). */
function inTriangle(q: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const nrm = cross(sub(b, a), sub(c, a))
  const eps = -1e-9 * dot(nrm, nrm)
  return (
    dot(cross(sub(b, a), sub(q, a)), nrm) >= eps &&
    dot(cross(sub(c, b), sub(q, b)), nrm) >= eps &&
    dot(cross(sub(a, c), sub(q, c)), nrm) >= eps
  )
}
