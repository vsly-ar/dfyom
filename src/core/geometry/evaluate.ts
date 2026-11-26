/**
 * 2.5D part evaluation: build every operation's labelled solids, compose
 * `stock − ∪ (removal − retained)` as subtraction layers (one batch union of tools with disjoint
 * bounds per layer), map output triangles to surface ids and run the evaluation checks (errors
 * here; geometry warnings and pieces in `checks.ts`).
 * Doc: docs/architecture/geometry.md#building-the-solids, #surface-ids-in-meshes,
 * #evaluation-checks; steps: docs/architecture/workers.md#abort-and-pause
 */
import { ctx, Err, fail, Ok, type AppResult } from '../../shared/result'
import { boxOf, boxesOverlap, geometryChecks, type Box, type ComposedOperation } from './checks'
import { constructionSurfaces } from './construction'
import type { ConstructionSurface, DfmWarning, PartGeometryInput, SurfaceId } from './model'
import {
  AIR,
  operationSolids,
  stockSolids,
  type OperationSolids,
  type PlacedMesh,
} from './operations'
import type { Solid, SolidMesh, SolidPort } from './solid-port'
import { noSteps, type Steps } from '../workers/steps'
import type { Region2dPort } from './2d/port'
import { operationKey, type OperationCache } from './operation-cache'

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
  /** Geometry warnings in check order: `dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceCutAway`. */
  readonly warnings: readonly DfmWarning[]
  /**
   * Referenced surfaces with no triangles, in reference order, with their consumers and patches
   * (docs/modes/construction-surfaces.md#resolution); empty when none.
   */
  readonly construction: readonly ConstructionSurface[]
  readonly stats: { readonly ms: number; readonly triangles: number }
}

const WHERE = 'evaluatePart'

/**
 * Most operations in one subtraction layer: on the stress case (30 pockets + 120 drills) one
 * batch union of everything took ≈ 145 ms, chunks of 25 ≈ 24 ms each (`npm run perf`), keeping
 * every step under 50 ms (docs/architecture/workers.md#abort-and-pause).
 */
export const UNION_CHUNK = 25

/**
 * Most clone operations in one clone layer: instances of one source never overlap, so a layer
 * of 100 is still a compose, and one step stays near 100 ms at 100 counterbored holes (spike S6,
 * docs/research/s6-clone-budgets.md#levers; docs/architecture/geometry.md#clone-layers).
 */
export const CLONE_LAYER = 100

/**
 * Subtraction layers (docs/architecture/geometry.md#building-the-solids): each tool joins the
 * first layer that has room (`chunk`) and none of whose tools' bounds it overlaps, else opens a
 * new one. Tools of one layer are pairwise disjoint, so their batch union is a cheap compose and
 * `stock − layer₁ − layer₂ − …` never unions overlapping tools – a union of overlapping tools
 * builds geometry the stock subtraction then cuts again (the exit part's facing under its
 * pocket and profile: one union of the three cost more than the three subtractions).
 * Only the grouping depends on the bounds; any grouping gives the same solid.
 */
export function subtractionLayers<T extends { readonly box: Box }>(
  tools: readonly T[],
  chunk = UNION_CHUNK,
): T[][] {
  const layers: T[][] = []
  for (const t of tools) {
    const layer = layers.find(
      (l) => l.length < chunk && l.every((u) => !boxesOverlap(t.box, u.box)),
    )
    if (layer === undefined) layers.push([t])
    else layer.push(t)
  }
  return layers
}

/**
 * The tools of the clone groups (`PartGeometryInput.cloneGroups`), group by group (a source
 * operation, then its instances), and the other tools in operation order. Ids not in `tools`
 * are skipped; an id in two groups counts once.
 */
export function cloneOrder<T extends { readonly op: { readonly id: string } }>(
  tools: readonly T[],
  groups: readonly (readonly string[])[] = [],
): { clones: T[]; rest: T[] } {
  const byId = new Map(tools.map((t) => [t.op.id, t]))
  const clones: T[] = []
  const taken = new Set<T>()
  for (const id of groups.flat()) {
    const t = byId.get(id)
    if (t === undefined || taken.has(t)) continue
    taken.add(t)
    clones.push(t)
  }
  return { clones, rest: tools.filter((t) => !taken.has(t)) }
}

/**
 * `region2d` builds general shapes (v0.3: named, rotated, `on`, blind, tab positions); without it
 * such an operation fails with `internal.unexpected` (a host bug, `needsRegion2d`). `cache`
 * reuses operations built by earlier evaluations whose input is unchanged (`operation-cache.ts`).
 * `steps.step()` runs after each operation's solids, after each subtraction layer and `toMesh`,
 * and inside the checks; an abort returns `op.aborted` (the arena frees everything). With
 * `cloneGroups`, their tools are subtracted first in clone layers (`CLONE_LAYER`) and, with a
 * cache, the part after them is kept (docs/architecture/geometry.md#clone-layers).
 */
export function evaluatePart(
  input: PartGeometryInput,
  solids: SolidPort,
  steps: Steps = noSteps,
  region2d?: Region2dPort,
  cache?: OperationCache,
): AppResult<PartEvaluation> {
  const started = performance.now()
  const stock = stockSolids(input.stock)
  if (stock.isErr()) return Err(stock.unwrapErr())
  const stockSolidsValue = stock.unwrap()
  // with a cache: each operation's input as its key, for its built meshes and its solid
  const keys = new Map<OperationSolids, string>()
  if (cache !== undefined) keys.set(stockSolidsValue, operationKey('stock', input.stock))
  const ops: OperationSolids[] = []
  const context = {
    triangulate: (rings: Parameters<SolidPort['triangulate']>[0]) => solids.triangulate(rings),
    ...(region2d === undefined ? {} : { region2d }),
  }
  for (const op of input.operations) {
    // DF108: a pattern's roughing pocket removes a part of what the pattern's pocket removes
    // DF122 R4: a roughing profile likewise
    if ((op.kind === 'pocket' || op.kind === 'profile') && op.roughing === true) continue
    const fresh = () => operationSolids(op, input.stock, context)
    const key = cache === undefined ? undefined : operationKey(op, input.stock)
    const r = key === undefined ? fresh() : cache!.solids(key, fresh)
    if (r.isErr()) return Err(r.unwrapErr().withContext(WHERE))
    ops.push(r.unwrap())
    if (key !== undefined) keys.set(r.unwrap(), key)
  }

  // manifold-3d evaluates booleans lazily: `status()` forces each stage, so the work lands
  // between the steps it belongs to (docs/architecture/workers.md#abort-and-pause)
  const force = (solid: Solid): AppResult<Solid> => solids.status(solid).map(() => solid)
  // one original id per operation (and the stock): (original id, face id) → surface; the solid
  // of an unchanged operation (same key) is the one the kernel kept from an earlier evaluation
  const tables = new Map<number, OperationSolids>()
  const build = (op: OperationSolids): AppResult<{ id: number; solid: Solid }> => {
    const make = () =>
      solids.reserveOriginalId().andThen((originalId) =>
        composeOperation(op, originalId, solids)
          .andThen(force)
          .map((solid) => ({ solid, originalId })),
      )
    const key = keys.get(op)
    return (key === undefined ? make() : solids.kept(key, make)).map(({ solid, originalId }) => {
      tables.set(originalId, op)
      return { id: originalId, solid }
    })
  }

  const composed = new Map<OperationSolids, ComposedOperation>()
  const placed = ops.map((op) => ({ op, box: boxOf(op.removal) }))
  // clone groups first (their own layers, the kept part after them), then the rest
  const { clones, rest } = cloneOrder(placed, input.cloneGroups)
  const cloneLayers = subtractionLayers(clones, CLONE_LAYER)
  const layers = subtractionLayers(rest)
  const total = ops.length + cloneLayers.length + layers.length + 1
  let done = 0
  const step = (label: string, n = 1) => steps.step({ done: (done += n), total, label })
  const subtractLayers = (
    from: Solid,
    ls: readonly (readonly { op: OperationSolids }[])[],
    first: number,
  ): AppResult<Solid> => {
    let part = from
    for (const [k, layer] of ls.entries()) {
      const tools = layer.map((t) => composed.get(t.op)!.solid)
      const next = (tools.length === 1 ? Ok(tools[0]!) : solids.union(tools))
        .andThen((tool) => solids.subtract(part, tool))
        .andThen(force)
      if (next.isErr()) return Err(next.unwrapErr())
      part = next.unwrap()
      const all = cloneLayers.length + layers.length
      const st = step(`subtract ${first + k + 1}/${all}`)
      if (st.isErr()) return Err(st.unwrapErr())
    }
    return Ok(part)
  }
  let stockOriginalId: number | undefined
  const built = build(stockSolidsValue).andThen((stockSolid) => {
    stockOriginalId = stockSolid.id
    for (const { op, box } of placed) {
      const s = build(op).mapErr(ctx(WHERE, { operation: op.id }))
      if (s.isErr()) return Err(s.unwrapErr())
      const { id, solid } = s.unwrap()
      composed.set(op, { op, originalId: id, solid, box })
      const st = step(op.id)
      if (st.isErr()) return Err(st.unwrapErr())
    }
    // stock − clone layers: kept across evaluations, keyed by the original ids of the stock and
    // the clone operations (a kept or rebuilt operation solid has its own id, so equal ids mean
    // equal inputs); an edit elsewhere then subtracts only the other layers
    const prefix = (): AppResult<{ solid: Solid; originalId: number }> =>
      subtractLayers(stockSolid.solid, cloneLayers, 0).map((solid) => ({
        solid,
        originalId: stockSolid.id,
      }))
    let cloned: AppResult<Solid>
    if (cloneLayers.length === 0) cloned = Ok(stockSolid.solid)
    else if (cache === undefined) cloned = prefix().map((p) => p.solid)
    else {
      const ids = clones.map((t) => composed.get(t.op)!.originalId).join(',')
      let made = false
      cloned = solids
        .kept(`clone layers ${stockSolid.id}|${ids}`, () => {
          made = true
          return prefix()
        })
        .andThen((p) =>
          made ? Ok(p.solid) : step('clone layers', cloneLayers.length).map(() => p.solid),
        )
    }
    // − layer₁ − layer₂ − …, one step per layer
    return cloned.andThen((part) => subtractLayers(part, layers, cloneLayers.length))
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
    .andThen((mesh) => step('mesh').map(() => mesh))
    .andThen((mesh) => labelMesh(mesh, [stockSolidsValue, ...ops], tables))
    .andThen((labelled) =>
      solids.volume(part).andThen((volume) =>
        geometryChecks(
          { part, operations: ops.map((op) => composed.get(op)!), tables },
          solids,
          steps,
        ).andThen((checks) =>
          constructionSurfaces(
            {
              stock: input.stock,
              stockSolids: stockSolidsValue,
              stockOriginalId: stockOriginalId!,
              operations: ops.map((op) => composed.get(op)!),
              surfaces: labelled.surfaces,
              references: input.references ?? [],
              dependants: input.dependants ?? {},
            },
            solids,
            steps,
          ).map((cs): PartEvaluation => ({
            ...labelled,
            volume,
            pieces: checks.pieces,
            warnings: [...checks.warnings, ...cs.warnings],
            construction: cs.construction,
            stats: {
              ms: performance.now() - started,
              triangles: labelled.indices.length / 3,
            },
          })),
        ),
      ),
    )
}

/** (∪ removal − ∪ cut) − ∪ retained, each mesh placed into the part frame (face frame + offset). */
function composeOperation(op: OperationSolids, id: number, solids: SolidPort): AppResult<Solid> {
  const place = (meshes: readonly PlacedMesh[]): AppResult<Solid[]> => {
    const out: Solid[] = []
    for (const m of meshes) {
      // vertices are in the part frame already (placed in float64, operations.ts)
      const s = solids.fromMesh(m.mesh, id)
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
  // several face ids may share one role (the tiles of a face): one surface per id
  const keys = [...new Set(keyOf)].sort((a, b) => a - b)
  const surfaces: SurfaceId[] = []
  const byId = new Map<SurfaceId, number>()
  const surfaceIndex = new Map<number, number>()
  for (const k of keys) {
    const op = order[Math.floor(k / 65536)]!
    const id = `${op.id}.${op.surfaces[k % 65536]!}`
    let i = byId.get(id)
    if (i === undefined) {
      i = surfaces.length
      surfaces.push(id)
      byId.set(id, i)
    }
    surfaceIndex.set(k, i)
  }

  // split vertices at surface boundaries: one output vertex per (vertex, surface)
  const triangleSurface = new Uint32Array(triangles)
  const indices = new Uint32Array(triangles * 3)
  const vertexCount = mesh.positions.length / 3
  // most vertices lie on one surface: its output index in typed arrays, the others in a map
  const firstSurface = new Int32Array(vertexCount).fill(-1)
  const firstOut = new Uint32Array(vertexCount)
  const more = new Map<number, number>()
  const pos = new Float32Array(9 * triangles)
  let count = 0
  const emit = (v: number): number => {
    pos[3 * count] = mesh.positions[3 * v]!
    pos[3 * count + 1] = mesh.positions[3 * v + 1]!
    pos[3 * count + 2] = mesh.positions[3 * v + 2]!
    return count++
  }
  for (let t = 0; t < triangles; t++) {
    const s = surfaceIndex.get(keyOf[t]!)!
    triangleSurface[t] = s
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]!
      let out: number
      if (firstSurface[v] === s) out = firstOut[v]!
      else if (firstSurface[v] === -1) {
        firstSurface[v] = s
        out = firstOut[v] = emit(v)
      } else {
        const key = s * vertexCount + v
        const known = more.get(key)
        out = known ?? emit(v)
        if (known === undefined) more.set(key, out)
      }
      indices[3 * t + k] = out
    }
  }
  return Ok({ positions: pos.slice(0, 3 * count), indices, triangleSurface, surfaces })
}
