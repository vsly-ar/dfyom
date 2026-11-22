/**
 * Spike S3: a cut-down `evaluatePart` for shape pockets – stock − ∪ labelled prisms placed by
 * their face frames (src/core/geometry/evaluate.ts minus the checks), with a timing breakdown,
 * surface labels and a sliver census. Report: spikes/prisms/results.md. Throwaway code.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d/manifold.js'
import { faceFrame, type Direction } from '../../src/core/geometry/face'
import { loadManifold } from '../../src/core/geometry/manifold'
import {
  EPSILON_VOLUME,
  OVERSHOOT,
  translation,
  type StockGeometry,
} from '../../src/core/geometry/model'
import { stockSolids, type PlacedMesh } from '../../src/core/geometry/operations'
import type { Solid, SolidKernel, SolidMesh, SolidPort } from '../../src/core/geometry/solid-port'
import { Ok } from '../../src/shared/result'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import {
  placedPrism,
  prismLabels,
  type PlacementMode,
  type PrismTimings,
  type Triangulate,
} from './prism'
import { flatten, type Region } from './region'
import { tiledStock } from './stock'

/** A pocket of a region on a stock face: floor at `depth` below the face, through the overshoot. */
export interface ShapePocket {
  readonly id: string
  readonly direction: Direction
  readonly region: Region
  readonly depth: number
}

export interface Spike {
  readonly kernel: SolidKernel
  readonly triangulate: Triangulate
}

/** Two manifold instances: the app's kernel (booleans) and a raw one for `triangulate`. */
export async function loadSpike(): Promise<Spike> {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const wasm: ManifoldToplevel = await (Module as () => Promise<ManifoldToplevel>)()
  wasm.setup()
  return {
    kernel,
    triangulate: (polygons, epsilon) => wasm.triangulate(polygons as never, epsilon ?? -1),
  }
}

export interface Timings extends PrismTimings {
  flatten: number
  /** fromMesh + transform per prism. */
  toSolid: number
  /** Batch union of the prisms, subtraction from the stock (forced by `status`). */
  boolean: number
  /** `toMesh` plus the per-triangle label lookup. */
  mesh: number
  /** `decompose` + volumes (the pieces check). */
  pieces: number
  total: number
}

export interface Evaluation {
  readonly ms: Timings
  readonly chords: number
  readonly triangles: number
  readonly volume: number
  /** Pieces above ε_V, and below it (slivers). */
  readonly pieces: number
  readonly tinyPieces: number
  /** Surface ids with triangles, e.g. `stock.top`, `p1.floor`, `p1.corner[3]`. */
  readonly surfaces: ReadonlySet<string>
  /** Triangles labelled `air` (top caps) – must be 0. */
  readonly airTriangles: number
  readonly mesh: SolidMesh
  /** Surface id per triangle. */
  readonly triangleSurface: readonly string[]
}

const zero = (): Timings => ({
  flatten: 0,
  triangulate: 0,
  build: 0,
  toSolid: 0,
  boolean: 0,
  mesh: 0,
  pieces: 0,
  total: 0,
})

export function evaluateShapes(
  spike: Spike,
  stock: StockGeometry,
  pockets: readonly ShapePocket[],
  mode: PlacementMode,
  /** Stock face tile size (mm); absent = one face per stock side, as v0.2. */
  tile?: number,
): Evaluation {
  return spike.kernel.withSolids((solids) => Ok(run(solids))).unwrap()
  function run(solids: SolidPort) {
    const ms = zero()
    const start = performance.now()
    let chords = 0
    const ops: { id: string; surfaces: readonly string[]; mesh: PlacedMesh }[] = []
    for (const p of pockets) {
      const t = performance.now()
      const rings = flatten(p.region)
      ms.flatten += performance.now() - t
      chords += rings.reduce((n, r) => n + r.points.length, 0)
      const labels = prismLabels(p.region.loops.flatMap((l) => l.map((e) => e.kind)))
      const frame = faceFrame(p.direction, stock)
      ops.push({
        id: p.id,
        surfaces: labels.surfaces,
        mesh: placedPrism(rings, OVERSHOOT, -p.depth, labels, spike.triangulate, frame, mode, ms),
      })
    }
    const stockOp =
      tile === undefined
        ? stockSolids(stock).unwrap()
        : (() => {
            const t = tiledStock(stock, tile)
            return {
              surfaces: t.surfaces,
              removal: [{ mesh: t.mesh, place: translation([0, 0, 0]) }],
            }
          })()
    const t1 = performance.now()
    const owners = new Map<number, { id: string; surfaces: readonly string[] }>()
    const toSolid = (m: PlacedMesh, owner: { id: string; surfaces: readonly string[] }): Solid => {
      const id = solids.reserveOriginalId().unwrap()
      owners.set(id, owner)
      const s = solids.fromMesh(m.mesh, id).unwrap()
      return mode === 'part' && owner.id !== 'stock' ? s : solids.transform(s, m.place).unwrap()
    }
    const stockSolid = toSolid(stockOp.removal[0]!, { id: 'stock', surfaces: stockOp.surfaces })
    const tools = ops.map((o) => toSolid(o.mesh, o))
    const t2 = performance.now()
    ms.toSolid = t2 - t1
    const all = tools.length === 1 ? tools[0]! : solids.union(tools).unwrap()
    const part = solids.subtract(stockSolid, all).unwrap()
    const status = solids.status(part).unwrap()
    if (status !== 'NoError') throw new Error(`part status ${status}`)
    const t3 = performance.now()
    ms.boolean = t3 - t2
    const mesh = solids.toMesh(part).unwrap()
    const triangleSurface: string[] = []
    const surfaces = new Set<string>()
    let airTriangles = 0
    for (let t = 0; t < mesh.triangleFace.length; t++) {
      const o = owners.get(mesh.triangleOriginal[t]!)!
      const face = mesh.triangleFace[t]!
      if (face === 0) airTriangles++
      const s = `${o.id}.${o.surfaces[face]}`
      triangleSurface.push(s)
      surfaces.add(s)
    }
    const t4 = performance.now()
    ms.mesh = t4 - t3
    const volumes = solids
      .decompose(part)
      .unwrap()
      .map((p) => solids.volume(p).unwrap())
    ms.pieces = performance.now() - t4
    ms.total = performance.now() - start
    return {
      ms,
      chords,
      triangles: mesh.triangleFace.length,
      volume: solids.volume(part).unwrap(),
      pieces: volumes.filter((v) => v > EPSILON_VOLUME).length,
      tinyPieces: volumes.filter((v) => v <= EPSILON_VOLUME).length,
      surfaces,
      airTriangles,
      mesh,
      triangleSurface,
    }
  }
}
