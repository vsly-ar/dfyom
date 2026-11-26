/**
 * Construction surfaces and `dfm.surfaceCutAway` (DF118): a referenced surface with no triangles
 * in the evaluated part is a construction surface; its consumers are the later operations whose
 * net solid cuts into the slab just inside the material under its patch, each taking what the
 * earlier ones left. A consumer that is not
 * one of the surface's dependants raises `dfm.surfaceCutAway` on each reference.
 * Doc: docs/modes/construction-surfaces.md#check-dfmsurfacecutaway,
 * docs/architecture/geometry.md#evaluation-checks
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import { directionOf, faceFrame, type Direction } from './face'
import type { LabelledMesh } from './loft'
import {
  EPSILON,
  EPSILON_VOLUME,
  unapplyPlacement,
  type ConstructionSurface,
  type DfmWarning,
  type StockGeometry,
  type SurfaceId,
  type SurfaceReference,
  type Vec2,
  type Vec3,
} from './model'
import { boxesOverlap, type Box, type ComposedOperation } from './checks'
import type { OperationSolids } from './operations'
import type { Solid, SolidPort } from './solid-port'
import { noSteps, type Steps } from '../workers/steps'

/** Thickness δ of the slab under a construction surface's patch (mm). */
export const CONSTRUCTION_SLAB = 0.001

/**
 * A consumer counts when it removes more than this of the slab (mm³): an overlap area over
 * ε_V / 1 mm (0.001 mm²). A cut that only touches the patch from above removes ≈ 0.
 */
export const CONSTRUCTION_OVERLAP = EPSILON_VOLUME * CONSTRUCTION_SLAB

export interface ConstructionInput {
  readonly stock: StockGeometry
  /** The stock's solids (owner of `stock.*`) and its original id. */
  readonly stockSolids: OperationSolids
  readonly stockOriginalId: number
  /** Every operation in input order (not the stock). */
  readonly operations: readonly ComposedOperation[]
  /** Surface ids that have triangles. */
  readonly surfaces: readonly SurfaceId[]
  readonly references: readonly SurfaceReference[]
  readonly dependants: Readonly<Record<SurfaceId, readonly string[]>>
}

export interface ConstructionResult {
  readonly construction: readonly ConstructionSurface[]
  readonly warnings: readonly DfmWarning[]
}

/** `steps.step()` after each slab intersection. Runs only for referenced surfaces with no triangles. */
export function constructionSurfaces(
  input: ConstructionInput,
  solids: SolidPort,
  steps: Steps = noSteps,
): AppResult<ConstructionResult> {
  const present = new Set(input.surfaces)
  const missing = [...new Set(input.references.map((r) => r.surface))].filter(
    (s) => !present.has(s),
  )
  const construction: ConstructionSurface[] = []
  const warnings: DfmWarning[] = []
  for (const surface of missing) {
    const owner = ownerOf(surface, input)
    if (owner === undefined) continue
    const patch = patchOf(owner.op, surface.slice(owner.op.id.length + 1))
    if (patch === undefined) continue
    const slab = slabSolid(patch, owner.originalId, solids)
    if (slab.isErr()) return Err(slab.unwrapErr())
    // in operation order, each consumer takes what is left of the slab: a removal's overshoot
    // above its own face crosses only material an earlier cut already took, so it never counts
    const candidates = input.operations
      .slice(owner.index + 1)
      .filter((c) => boxesOverlap(patch.box, c.box))
    const consumedBy: string[] = []
    let left = slab.unwrap()
    for (const [k, c] of candidates.entries()) {
      const last = k === candidates.length - 1
      // the face has no triangles, so later cuts took the whole slab: what the others left is
      // the last candidate's when it reaches past the slab (one that only touches the face
      // from above still runs the boolean). Saves the boolean of a lone consumer.
      const v =
        last && reachesPast(c.box, patch)
          ? solids.volume(left)
          : solids.intersect(left, c.solid).andThen((x) => solids.volume(x))
      if (v.isErr()) return Err(v.unwrapErr())
      const step = steps.step()
      if (step.isErr()) return Err(step.unwrapErr())
      if (v.unwrap() <= CONSTRUCTION_OVERLAP) continue
      consumedBy.push(c.op.id)
      if (last) break
      const rest = solids.subtract(left, c.solid)
      if (rest.isErr()) return Err(rest.unwrapErr())
      left = rest.unwrap()
    }
    const refs = input.references.filter((r) => r.surface === surface)
    construction.push({
      surface,
      consumedBy,
      referencedBy: refs.map((r) => ({ operationId: r.operation, param: r.parameter })),
      patch: facePatch(patch, input.stock),
    })
    const dependants = new Set(input.dependants[surface] ?? [])
    const by = consumedBy.filter((id) => !dependants.has(id))
    if (by.length === 0) continue
    for (const r of refs)
      warnings.push({
        code: 'dfm.surfaceCutAway',
        severity: 'warning',
        message:
          `${r.operation}.${r.parameter} starts from or refers to ${surface}, which ${by.join(', ')} ` +
          `cuts away; its level still holds, so the cut is measured from a surface the part no ` +
          `longer has. Check the depth or start from another surface`,
        operation: r.operation,
        parameter: r.parameter,
        params: { surface, by },
      })
  }
  return Ok({ construction, warnings })
}

interface Owner {
  readonly op: OperationSolids
  /** Index in `operations`; −1 for the stock. */
  readonly index: number
  readonly originalId: number
}

/** The operation (or the stock) whose surface table has the role after `<id>.`. */
function ownerOf(surface: SurfaceId, input: ConstructionInput): Owner | undefined {
  const has = (op: OperationSolids) =>
    surface.startsWith(`${op.id}.`) && op.surfaces.includes(surface.slice(op.id.length + 1))
  if (has(input.stockSolids))
    return { op: input.stockSolids, index: -1, originalId: input.stockOriginalId }
  // the longest matching id (an owned operation's id may extend another's)
  let best: Owner | undefined
  input.operations.forEach((c, index) => {
    if (has(c.op) && (best === undefined || c.op.id.length > best.op.id.length))
      best = { op: c.op, index, originalId: c.originalId }
  })
  return best
}

/** The planar patch of a surface: its triangles per source mesh, and where the material is. */
interface Patch {
  /** Per source mesh: positions (part frame) and triangles facing away from the material. */
  readonly parts: readonly { readonly positions: Float64Array; readonly triangles: number[] }[]
  /** Unit vector into the material (the slab's side). */
  readonly into: Vec3
  readonly box: Box
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const vertex = (p: Float64Array, i: number): Vec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!]

/**
 * Triangles of `role` in the owner's meshes. A removal is air, so its faces point into the
 * material; cut, retained and stock meshes are material, so the material is behind their faces.
 * Undefined when no mesh has the role (a surface with no area).
 */
function patchOf(op: OperationSolids, role: string): Patch | undefined {
  const ids = new Set<number>()
  op.surfaces.forEach((r, i) => {
    if (r === role) ids.add(i)
  })
  const sources: [LabelledMesh, boolean][] = [
    ...op.removal.map((m): [LabelledMesh, boolean] => [m.mesh, op.id !== 'stock']),
    ...op.cut.map((m): [LabelledMesh, boolean] => [m.mesh, false]),
    ...op.retained.map((m): [LabelledMesh, boolean] => [m.mesh, false]),
  ]
  let into: Vec3 | undefined
  const parts: { positions: Float64Array; triangles: number[] }[] = []
  for (const [mesh, air] of sources) {
    const triangles: number[] = []
    for (let t = 0; t < mesh.faces.length; t++) {
      if (!ids.has(mesh.faces[t]!)) continue
      const [a, b, c] = [0, 1, 2].map((k) => mesh.triangles[3 * t + k]!) as [number, number, number]
      const p = mesh.positions
      const n = cross(sub(vertex(p, b), vertex(p, a)), sub(vertex(p, c), vertex(p, a)))
      const len = Math.hypot(...n)
      if (len <= EPSILON * EPSILON) continue // degenerate
      if (into === undefined) {
        const s = air ? 1 : -1
        // planar faces of axis directions: snap to the axis
        const axis = n.map((x) => Math.round((s * x) / len)) as unknown as Vec3
        into = [axis[0] || 0, axis[1] || 0, axis[2] || 0]
      }
      // the slab's face on the patch points away from the material
      if (dot(n, into) > 0) triangles.push(a, c, b)
      else triangles.push(a, b, c)
    }
    if (triangles.length > 0) parts.push({ positions: mesh.positions, triangles })
  }
  if (into === undefined || parts.length === 0) return undefined
  return { parts, into, box: patchBox(parts, into) }
}

/** The box reaches deeper into the material than the slab (by more than ε). */
function reachesPast(box: Box, patch: Patch): boolean {
  const k = patch.into.findIndex((x) => x !== 0)
  return patch.into[k]! > 0
    ? box.max[k]! > patch.box.max[k]! + EPSILON
    : box.min[k]! < patch.box.min[k]! - EPSILON
}

/** Bounds of the patch vertices and their copies δ into the material. */
function patchBox(parts: Patch['parts'], d: Vec3): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const { positions, triangles } of parts)
    for (const i of triangles)
      for (const s of [0, CONSTRUCTION_SLAB])
        for (let a = 0; a < 3; a++) {
          const q = positions[3 * i + a]! + s * d[a]!
          if (q < min[a]!) min[a] = q
          if (q > max[a]!) max[a] = q
        }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

/** Directed boundary edges (a → b as the patch triangles run): edges used once. */
function boundaryEdges(triangles: readonly number[]): [number, number][] {
  const count = new Map<string, number>()
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  const edges: [number, number][] = []
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]!
      const b = triangles[t + ((k + 1) % 3)]!
      edges.push([a, b])
      count.set(key(a, b), (count.get(key(a, b)) ?? 0) + 1)
    }
  return edges.filter(([a, b]) => count.get(key(a, b)) === 1)
}

/**
 * The patch extruded δ into the material as one closed mesh per source: the patch triangles, a
 * copy moved by δ (reversed) and a side quad per boundary edge. Several sources are united.
 */
function slabSolid(patch: Patch, originalId: number, solids: SolidPort): AppResult<Solid> {
  const out: Solid[] = []
  for (const { positions, triangles } of patch.parts) {
    const used = [...new Set(triangles)]
    const local = new Map(used.map((v, i) => [v, i]))
    const n = used.length
    const pos = new Float64Array(6 * n)
    used.forEach((v, i) => {
      for (let a = 0; a < 3; a++) {
        pos[3 * i + a] = positions[3 * v + a]!
        pos[3 * (n + i) + a] = positions[3 * v + a]! + CONSTRUCTION_SLAB * patch.into[a]!
      }
    })
    const tris: number[] = []
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => local.get(triangles[t + k]!)!) as [
        number,
        number,
        number,
      ]
      tris.push(a, b, c, n + a, n + c, n + b)
    }
    for (const [ga, gb] of boundaryEdges(triangles)) {
      const a = local.get(ga)!
      const b = local.get(gb)!
      tris.push(b, a, n + a, b, n + a, n + b)
    }
    const mesh: LabelledMesh = {
      positions: pos,
      triangles: Uint32Array.from(tris),
      faces: new Uint32Array(tris.length / 3),
    }
    const s = solids.fromMesh(mesh, originalId)
    if (s.isErr()) return Err(s.unwrapErr())
    out.push(s.unwrap())
  }
  return out.length === 1 ? Ok(out[0]!) : solids.union(out)
}

/** The patch's boundary loops in the face frame of its direction (the face points away from `into`). */
function facePatch(patch: Patch, stock: StockGeometry): ConstructionSurface['patch'] {
  const outward: Vec3 = [-patch.into[0] || 0, -patch.into[1] || 0, -patch.into[2] || 0]
  const direction: Direction = directionOf(outward)
  const frame = faceFrame(direction, stock)
  let z = 0
  const loops: Vec2[][] = []
  for (const { positions, triangles } of patch.parts) {
    const next = new Map<number, number>()
    for (const [a, b] of boundaryEdges(triangles)) next.set(a, b)
    const seen = new Set<number>()
    for (const start of next.keys()) {
      if (seen.has(start)) continue
      const loop: Vec2[] = []
      for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) {
        seen.add(v)
        const q = unapplyPlacement(frame, vertex(positions, v))
        z = q[2]
        loop.push([q[0], q[1]])
      }
      if (loop.length >= 3) loops.push(loop)
    }
  }
  return { direction, z, loops }
}
