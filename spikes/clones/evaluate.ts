/**
 * Spike S6: a cut-down `evaluatePart` (src/core/geometry/evaluate.ts minus the geometry checks)
 * with three ways to build clone instances and a configurable subtraction-layer size, timed by
 * phase. Throwaway code; report: docs/research/s6-clone-budgets.md.
 *
 * - `perOp`: every instance is an operation of its own, built and solidified (today's path).
 * - `translateMesh`: the source's meshes are built once (cache key = the source operation);
 *   each instance copies them moved by its offset (float64, in JS) and makes its own solid with
 *   its own original id, so surface labels work unchanged.
 * - `transform`: the source's solid is composed once; each instance is `SolidPort.transform` of
 *   it (lazy in Manifold). All instances share the source's original id, so labels need a pass
 *   that finds the instance of a triangle by position (`instanceOf`).
 */
import { Err, Ok, type AppResult } from '../../src/shared/result'
import { boxOf, type Box } from '../../src/core/geometry/checks'
import { subtractionLayers } from '../../src/core/geometry/evaluate'
import { translation, type OperationGeometry, type Vec2 } from '../../src/core/geometry/model'
import { operationKey, OperationCache } from '../../src/core/geometry/operation-cache'
import {
  operationSolids,
  stockSolids,
  type OperationSolids,
  type PlacedMesh,
} from '../../src/core/geometry/operations'
import type { Solid, SolidPort } from '../../src/core/geometry/solid-port'
import { translated, type Workload } from './workload'

export type Mode = 'perOp' | 'translateMesh' | 'transform'

export interface Options {
  readonly mode: Mode
  /** Most tools per subtraction layer (production: `UNION_CHUNK` = 25). */
  readonly chunk: number
  /** Built meshes reused across evaluations (production: the worker's `OperationCache`). */
  readonly cache?: OperationCache
  /** Use `SolidPort.kept` for solids (the kernel must have `keepSolids` set). */
  readonly keep?: boolean
}

export interface Timings {
  build: number
  compose: number
  subtract: number
  /** Share of `subtract` spent in the batch unions of the layers. */
  union: number
  /** The slowest subtraction layer (one abortable step). */
  maxLayer: number
  layers: number
  toMesh: number
  label: number
  total: number
  triangles: number
  /** Triangles of a clone source whose instance was not found (must be 0). */
  unlabelled: number
  /** Part volume (mm³), outside the timings: equal across modes. */
  volume: number
}

interface Unit {
  /** One original id per unit; triangles map back to `ops`. */
  readonly originalId: number
  readonly solid: Solid
  readonly box: Box
}

const shiftBox = (b: Box, d: Vec2): Box => ({
  min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2]],
  max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2]],
})

function shiftedMeshes(meshes: readonly PlacedMesh[], d: Vec2): PlacedMesh[] {
  return meshes.map(({ mesh }) => {
    const p = mesh.positions
    const positions = new Float64Array(p.length)
    for (let i = 0; i < p.length; i += 3) {
      positions[i] = p[i]! + d[0]
      positions[i + 1] = p[i + 1]! + d[1]
      positions[i + 2] = p[i + 2]!
    }
    return { mesh: { ...mesh, positions } }
  })
}

function shifted(op: OperationSolids, d: Vec2, id: string): OperationSolids {
  return {
    ...op,
    id,
    removal: shiftedMeshes(op.removal, d),
    cut: shiftedMeshes(op.cut, d),
    retained: shiftedMeshes(op.retained, d),
    nominal: op.nominal.map((r) => ({ ...r, mesh: shiftedMeshes([r.mesh], d)[0]! })),
  }
}

/** (∪ removal − ∪ cut) − ∪ retained, as evaluate.ts `composeOperation`. */
function compose(op: OperationSolids, id: number, solids: SolidPort): AppResult<Solid> {
  const unionOf = (meshes: readonly PlacedMesh[]): AppResult<Solid | undefined> => {
    if (meshes.length === 0) return Ok(undefined)
    const out: Solid[] = []
    for (const m of meshes) {
      const s = solids.fromMesh(m.mesh, id)
      if (s.isErr()) return Err(s.unwrapErr())
      out.push(s.unwrap())
    }
    return out.length === 1 ? Ok(out[0]!) : solids.union(out)
  }
  const minus = (a: Solid, meshes: readonly PlacedMesh[]): AppResult<Solid> =>
    unionOf(meshes).andThen((b) => (b === undefined ? Ok(a) : solids.subtract(a, b)))
  return unionOf(op.removal).andThen((r) => minus(r!, op.cut).andThen((x) => minus(x, op.retained)))
}

/** Uniform grid over instance boxes: which instance of a source holds a point (x, y). */
class InstanceGrid {
  private readonly cells = new Map<number, number[]>()
  constructor(
    private readonly boxes: readonly Box[],
    private readonly cell: number,
  ) {
    boxes.forEach((b, i) => {
      for (let x = Math.floor(b.min[0] / cell); x <= Math.floor(b.max[0] / cell); x++)
        for (let y = Math.floor(b.min[1] / cell); y <= Math.floor(b.max[1] / cell); y++) {
          const k = x * 100_003 + y
          const list = this.cells.get(k)
          if (list === undefined) this.cells.set(k, [i])
          else list.push(i)
        }
    })
  }
  find(x: number, y: number): number {
    const k = Math.floor(x / this.cell) * 100_003 + Math.floor(y / this.cell)
    for (const i of this.cells.get(k) ?? []) {
      const b = this.boxes[i]!
      if (
        x >= b.min[0] - 1e-4 &&
        x <= b.max[0] + 1e-4 &&
        y >= b.min[1] - 1e-4 &&
        y <= b.max[1] + 1e-4
      )
        return i
    }
    return -1
  }
}

export function evaluateClones(
  w: Workload,
  solids: SolidPort,
  options: Options,
): AppResult<Timings> {
  const t0 = performance.now()
  const { stock, group } = w
  const cache = options.cache
  const built = (op: OperationGeometry): AppResult<OperationSolids> => {
    const fresh = () => operationSolids(op, stock, { triangulate: (r) => solids.triangulate(r) })
    return cache === undefined ? fresh() : cache.solids(operationKey(op, stock), fresh)
  }
  const make = (op: OperationSolids, key: string | undefined) => {
    const m = () =>
      solids.reserveOriginalId().andThen((originalId) =>
        compose(op, originalId, solids)
          .andThen((s) => solids.status(s).map(() => s))
          .map((solid) => ({ solid, originalId })),
      )
    return options.keep === true && key !== undefined ? solids.kept(key, m) : m()
  }

  // ---- build: meshes per unit
  const stockOp = stockSolids(stock).unwrap()
  type Pending = { op: OperationSolids; key: string; box: Box }
  const pending: Pending[] = []
  /** Per source operation (transform mode): its solid's original id → instance boxes. */
  const sources: { op: OperationSolids; key: string; offsets: readonly Vec2[] }[] = []
  for (const src of group.source) {
    if (options.mode === 'perOp') {
      for (const [i, d] of group.offsets.entries()) {
        const op = translated(src, d, i + 1)
        const b = built(op)
        if (b.isErr()) return Err(b.unwrapErr())
        pending.push({
          op: b.unwrap(),
          key: operationKey(op, stock),
          box: boxOf(b.unwrap().removal),
        })
      }
    } else {
      const b = built(src)
      if (b.isErr()) return Err(b.unwrapErr())
      const key = operationKey(src, stock)
      if (options.mode === 'transform')
        sources.push({ op: b.unwrap(), key, offsets: group.offsets })
      else {
        const box = boxOf(b.unwrap().removal)
        for (const [i, d] of group.offsets.entries())
          pending.push({
            op: i === 0 ? b.unwrap() : shifted(b.unwrap(), d, `clones1_${i + 1}_${src.id}`),
            key: `${key}|${d[0]},${d[1]}`,
            box: shiftBox(box, d),
          })
      }
    }
  }
  const t1 = performance.now()

  // ---- compose: one solid per unit (transform: per source, then lazy transforms)
  const stockSolid = make(stockOp, operationKey('stock', stock))
  if (stockSolid.isErr()) return Err(stockSolid.unwrapErr())
  const units: Unit[] = []
  for (const p of pending) {
    const s = make(p.op, p.key)
    if (s.isErr()) return Err(s.unwrapErr())
    units.push({ ...s.unwrap(), box: p.box })
  }
  const grids = new Map<number, InstanceGrid>()
  for (const src of sources) {
    const s = make(src.op, src.key)
    if (s.isErr()) return Err(s.unwrapErr())
    const box = boxOf(src.op.removal)
    const boxes = src.offsets.map((d) => shiftBox(box, d))
    const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1])
    grids.set(s.unwrap().originalId, new InstanceGrid(boxes, size))
    for (const [i, d] of src.offsets.entries()) {
      const solid =
        i === 0
          ? Ok(s.unwrap().solid)
          : solids.transform(s.unwrap().solid, translation([d[0], d[1], 0]))
      if (solid.isErr()) return Err(solid.unwrapErr())
      units.push({ originalId: s.unwrap().originalId, solid: solid.unwrap(), box: boxes[i]! })
    }
  }
  const t2 = performance.now()

  // ---- subtraction layers
  const layers = subtractionLayers(units, options.chunk)
  let part = stockSolid.unwrap().solid
  let maxLayer = 0
  let union = 0
  for (const layer of layers) {
    const tl = performance.now()
    const tools = layer.map((u) => u.solid)
    const next = (tools.length === 1 ? Ok(tools[0]!) : solids.union(tools))
      .andThen((tool) => solids.status(tool).map(() => tool))
      .andThen((tool) => {
        union += performance.now() - tl
        return solids.subtract(part, tool)
      })
      .andThen((s) => solids.status(s).map(() => s))
    if (next.isErr()) return Err(next.unwrapErr())
    part = next.unwrap()
    maxLayer = Math.max(maxLayer, performance.now() - tl)
  }
  const t3 = performance.now()
  const mesh = solids.toMesh(part)
  if (mesh.isErr()) return Err(mesh.unwrapErr())
  const m = mesh.unwrap()
  const t4 = performance.now()

  // ---- labels: instance per triangle where instances share an original id
  let unlabelled = 0
  const instance = new Int32Array(m.triangleFace.length)
  for (let t = 0; t < m.triangleFace.length; t++) {
    const grid = grids.get(m.triangleOriginal[t]!)
    if (grid === undefined) continue
    let x = 0
    let y = 0
    for (let k = 0; k < 3; k++) {
      const v = m.indices[3 * t + k]!
      x += m.positions[3 * v]! / 3
      y += m.positions[3 * v + 1]! / 3
    }
    instance[t] = grid.find(x, y)
    if (instance[t]! < 0) unlabelled++
  }
  const t5 = performance.now()
  const volume = solids.volume(part)
  if (volume.isErr()) return Err(volume.unwrapErr())
  return Ok({
    volume: volume.unwrap(),
    build: t1 - t0,
    compose: t2 - t1,
    subtract: t3 - t2,
    union,
    maxLayer,
    layers: layers.length,
    toMesh: t4 - t3,
    label: t5 - t4,
    total: t5 - t0,
    triangles: m.triangleFace.length,
    unlabelled,
  })
}
