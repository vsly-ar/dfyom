/**
 * 2.5D part evaluation: build every operation's labelled solids, compose
 * `stock − ∪ (removal − retained)` in one batch union, map output triangles to surface ids and
 * run the evaluation checks (errors here; geometry warnings and pieces in `checks.ts`).
 * Doc: docs/architecture/geometry.md#building-the-solids, #surface-ids-in-meshes,
 * #evaluation-checks
 */
import { ctx, Err, fail, Ok, type AppResult } from '../../shared/result'
import { boxOf, geometryChecks, type ComposedOperation } from './checks'
import type { DfmWarning, PartGeometryInput, SurfaceId } from './model'
import {
  AIR,
  operationSolids,
  stockSolids,
  type OperationSolids,
  type PlacedMesh,
} from './operations'
import type { Solid, SolidMesh, SolidPort } from './solid-port'

/** Plain data, transferable to the renderer (typed-array buffers are transferred). */
export interface PartEvaluation {
  /** x, y, z per vertex (float32, part frame, mm); vertices split at surface boundaries. */
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** Index into `surfaces` per triangle. */
  readonly triangleSurface: Uint32Array
  /** Surface ids that have triangles, in operation order (stock first). */
  readonly surfaces: readonly SurfaceId[]
  /** Volume of the part including any loose pieces (mm³). */
  readonly volume: number
  /** Pieces of volume > ε_V: 1 when the part and every offcut hang together. */
  readonly pieces: number
  /** Geometry warnings in check order: `dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceMissing`. */
  readonly warnings: readonly DfmWarning[]
  readonly stats: { readonly ms: number; readonly triangles: number }
}

const WHERE = 'evaluatePart'

export function evaluatePart(
  input: PartGeometryInput,
  solids: SolidPort,
): AppResult<PartEvaluation> {
  const started = performance.now()
  const stock = stockSolids(input.stock)
  if (stock.isErr()) return Err(stock.unwrapErr())
  const stockSolidsValue = stock.unwrap()
  const ops: OperationSolids[] = []
  for (const op of input.operations) {
    const r = operationSolids(op, input.stock)
    if (r.isErr()) return Err(r.unwrapErr().withContext(WHERE))
    ops.push(r.unwrap())
  }

  // one original id per operation (and the stock): (original id, face id) → surface
  const tables = new Map<number, OperationSolids>()
  const build = (op: OperationSolids): AppResult<{ id: number; solid: Solid }> =>
    solids.reserveOriginalId().andThen((id) => {
      tables.set(id, op)
      return composeOperation(op, id, solids).map((solid) => ({ id, solid }))
    })

  const composed: ComposedOperation[] = []
  const built = build(stockSolidsValue).andThen((stockSolid) => {
    for (const op of ops) {
      const s = build(op).mapErr(ctx(WHERE, { operation: op.id }))
      if (s.isErr()) return Err(s.unwrapErr())
      const { id, solid } = s.unwrap()
      composed.push({ op, originalId: id, solid, box: boxOf(op.removal) })
    }
    return solids
      .union(composed.map((c) => c.solid))
      .andThen((all) => solids.subtract(stockSolid.solid, all))
  })
  if (built.isErr()) return Err(built.unwrapErr())
  const part = built.unwrap()

  const status = solids.status(part)
  if (status.isErr()) return Err(status.unwrapErr())
  const partStatus = status.unwrap()
  if (partStatus !== 'NoError') {
    const message = `part solid has status ${partStatus}`
    return fail('geometry.evaluation', message, {
      issues: [{ path: [], rule: 'status', message, params: { status: partStatus } }],
      where: WHERE,
    })
  }
  return solids
    .toMesh(part)
    .andThen((mesh) => labelMesh(mesh, [stockSolidsValue, ...ops], tables))
    .andThen((labelled) =>
      solids.volume(part).andThen((volume) =>
        geometryChecks(
          {
            part,
            operations: composed,
            tables,
            surfaces: labelled.surfaces,
            references: input.references ?? [],
          },
          solids,
        ).map((checks): PartEvaluation => ({
          ...labelled,
          volume,
          pieces: checks.pieces,
          warnings: checks.warnings,
          stats: {
            ms: performance.now() - started,
            triangles: labelled.indices.length / 3,
          },
        })),
      ),
    )
}

/** (∪ removal − ∪ cut) − ∪ retained, each mesh translated into the part frame. */
function composeOperation(op: OperationSolids, id: number, solids: SolidPort): AppResult<Solid> {
  const place = (meshes: readonly PlacedMesh[]): AppResult<Solid[]> => {
    const out: Solid[] = []
    for (const m of meshes) {
      const s = solids.fromMesh(m.mesh, id).andThen((s) => solids.translate(s, m.at))
      if (s.isErr()) return Err(s.unwrapErr())
      out.push(s.unwrap())
    }
    return Ok(out)
  }
  const unionOf = (meshes: readonly PlacedMesh[]): AppResult<Solid | undefined> =>
    meshes.length === 0
      ? Ok(undefined)
      : place(meshes).andThen((ss) => (ss.length === 1 ? Ok(ss[0]!) : solids.union(ss)))
  const minus = (a: Solid, meshes: readonly PlacedMesh[]): AppResult<Solid> =>
    unionOf(meshes).andThen((b) => (b === undefined ? Ok(a) : solids.subtract(a, b)))

  return unionOf(op.removal).andThen((removal) =>
    removal === undefined
      ? fail('internal.unexpected', `operation ${op.id} has no removal`, { where: WHERE })
      : minus(removal, op.cut).andThen((r) => minus(r, op.retained)),
  )
}

/**
 * Per-triangle surface ids via (original id, face id); `air` or an unknown key is a bug
 * (`geometry.evaluation`, rule `airSurface`). Vertices are split per surface.
 */
function labelMesh(
  mesh: SolidMesh,
  order: readonly OperationSolids[],
  tables: ReadonlyMap<number, OperationSolids>,
): AppResult<Pick<PartEvaluation, 'positions' | 'indices' | 'triangleSurface' | 'surfaces'>> {
  const triangles = mesh.triangleFace.length
  const rank = new Map(order.map((op, i) => [op, i]))
  // global key of a surface: operation rank × 2^16 + face
  const keyOf = new Uint32Array(triangles)
  const bad = new Map<string, number>()
  for (let t = 0; t < triangles; t++) {
    const op = tables.get(mesh.triangleOriginal[t]!)
    const face = mesh.triangleFace[t]!
    if (op === undefined || face === AIR || face >= op.surfaces.length) {
      const k = op === undefined ? `original ${mesh.triangleOriginal[t]}` : `${op.id}.air`
      bad.set(k, (bad.get(k) ?? 0) + 1)
      continue
    }
    keyOf[t] = rank.get(op)! * 65536 + face
  }
  if (bad.size > 0) {
    const params = Object.fromEntries(bad)
    const message = `triangles on air or unknown surfaces: ${JSON.stringify(params)}`
    return fail('geometry.evaluation', message, {
      issues: [{ path: [], rule: 'airSurface', message, params }],
      where: WHERE,
    })
  }
  const keys = [...new Set(keyOf)].sort((a, b) => a - b)
  const surfaceIndex = new Map(keys.map((k, i) => [k, i]))
  const surfaces = keys.map((k) => {
    const op = order[Math.floor(k / 65536)]!
    return `${op.id}.${op.surfaces[k % 65536]!}`
  })

  // split vertices at surface boundaries: one output vertex per (vertex, surface)
  const triangleSurface = new Uint32Array(triangles)
  const indices = new Uint32Array(triangles * 3)
  const remap = new Map<number, number>()
  const pos: number[] = []
  const vertexCount = mesh.positions.length / 3
  for (let t = 0; t < triangles; t++) {
    const s = surfaceIndex.get(keyOf[t]!)!
    triangleSurface[t] = s
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]!
      const key = s * vertexCount + v
      let out = remap.get(key)
      if (out === undefined) {
        out = pos.length / 3
        pos.push(mesh.positions[3 * v]!, mesh.positions[3 * v + 1]!, mesh.positions[3 * v + 2]!)
        remap.set(key, out)
      }
      indices[3 * t + k] = out
    }
  }
  return Ok({ positions: Float32Array.from(pos), indices, triangleSurface, surfaces })
}
