/**
 * Design part → geometry input: quantities to canonical float64 mm/degrees, `on` to the
 * operation's `direction` and `onZ` (the z of `on` in its face frame, 0 at the stock face),
 * `on` and expression references to `references` and their surfaces' `dependants` (for
 * construction surfaces and `dfm.surfaceCutAway`). Pure; the geometry types are owned by src/core/geometry/model.ts.
 * Doc: docs/modes/design.md#implementation-task-25, docs/architecture/geometry.md#evaluation-rules
 */
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import { DEFAULT_LINE_CUTTER } from '../geometry/line'
import { resolveDesignTool } from './tool-choice'
import type { Quantity } from '../quantity/quantity'
import { definitionOf, requirePort } from './shape'
import { pathLevelProfile } from './shape-items'
import type { EngravingRecord, ShapeItem } from './shape.dto'
import { resolveEngraving } from './engraving/resolve'
import type {
  Contour,
  LineCutter,
  LinePathLevels,
  Vec2,
  OperationGeometry,
  LoopChamferTab,
  PartGeometryInput,
  Shape as ShapeGeometry,
  SurfaceReference,
} from '../geometry/model'
import { faceToFace, localStock, stockFaceDirection, type Direction } from '../geometry/face'
import { orientPath, orientRegion } from '../geometry/2d/place'
import { chainLength, chainPointAt } from '../geometry/2d/measure'
import { profileChain } from '../geometry/outline'
import { resolveProfileTabs } from '../geometry/tab-hold'
import type { Stock } from '../library/stock'
import type { Region2dPort } from '../geometry/2d/port'
import {
  chamferDiameter,
  chamferEdgeKind,
  circularEdgeDiameter,
  isBottomChamfer,
  isGeneralShape,
  lineDepths,
  type LinePath,
  type Operation,
  type Part,
  type Point,
  type Shape,
} from './operation'
import { throughDepths, withThroughDepths } from '../geometry/through-depth'
import { placeShape } from './placement'
import { operationReferences, surfaceDependants, SurfaceTable } from './surfaces'
import { shapeCentre } from './anchor'
import { instanceOf, stepOf } from './feature'

const vec2 = (p: Point) => [p[0].canonical, p[1].canonical] as const

/**
 * A shape's geometry: v0.1 rectangles and circles analytically (inputs byte-identical to v0.2);
 * general shapes (named, rotated) placed through the 2D layer (`placeShape`): the numbered region
 * or path relative to the centre of its placed bounding box (docs/architecture/shapes.md#implementation-k3).
 */
function shapeGeometry(
  s: Shape,
  shapes: Part['shapes'],
  port: Region2dPort | undefined,
): AppResult<ShapeGeometry> {
  if (isGeneralShape(s)) {
    const p = requirePort(port, 'toGeometryInput')
    if (p.isErr()) return p
    return placeShape(p.unwrap(), s, shapes).map((placed) => ({
      center: placed.centre,
      contour:
        placed.outline.kind === 'region'
          ? { kind: 'region', region: placed.outline.region }
          : { kind: 'path', path: placed.outline.path },
    }))
  }
  return Ok(analyticShape(s as Extract<Shape, { kind: 'rectangle' | 'circle' }>))
}

function analyticShape(s: Extract<Shape, { kind: 'rectangle' | 'circle' }>): ShapeGeometry {
  const contour: Contour =
    s.kind === 'circle'
      ? { kind: 'circle', radius: s.diameter.canonical / 2 }
      : {
          kind: 'rectangle',
          length: s.length.canonical,
          width: s.width.canonical,
          cornerRadius: s.cornerRadius.canonical,
        }
  // the geometric centre: `center` is the anchor point (design-v0.2.md#placement-anchors)
  return { center: shapeCentre(s), contour }
}

/**
 * The geometry input of a (valid) part. A dangling `on` or a missing drill depth cannot happen
 * after the commands' checks, so it is `internal.unexpected`. `port` places general shapes
 * (v0.3); a part with one and no port fails with `internal.unexpected`. The placed loops are part
 * of the input, so the evaluation hash follows every shape edit.
 */
export function toGeometryInput(
  part: Part,
  stock: Stock,
  port?: Region2dPort,
  /**
   * The document's snapshots: a Line's specific tool resolves here for its groove's shape
   * (engraved-patterns.md E1); absent or unresolved = the default V-bit.
   */
  snapshots?: ProjectDoc['snapshots'],
): AppResult<PartGeometryInput> {
  const table = SurfaceTable.build(part.operations, stock, part.shapes)
  const operations: OperationGeometry[] = []
  const references: SurfaceReference[] = []
  for (const [i, op] of part.operations.entries()) {
    const g = operationGeometry(op, i, table, part.shapes, port, part.operations, {
      built: operations,
      stock,
      ...(snapshots === undefined ? {} : { snapshots }),
    })
    if (g.isErr()) return Err(g.unwrapErr())
    operations.push(g.unwrap())
    const refs = operationReferences(op)
    if (refs.isErr()) return Err(refs.unwrapErr().withContext('toGeometryInput'))
    // one entry per (parameter, surface): `z` and `z.max` of one surface are one reference
    const seen = new Set<string>()
    for (const r of refs.unwrap()) {
      const key = `${r.param}\0${r.surface}`
      if (seen.has(key)) continue
      seen.add(key)
      references.push({ operation: op.id, parameter: r.param, surface: r.surface })
    }
  }
  const dependants = surfaceDependants(
    part.operations,
    table,
    references.map((r) => r.surface),
  )
  if (dependants.isErr()) return Err(dependants.unwrapErr().withContext('toGeometryInput'))
  const stockGeometry = {
    length: stock.length.canonical,
    width: stock.width.canonical,
    thickness: stock.thickness.canonical,
  }
  return Ok({
    stock: stockGeometry,
    // through profiles over material an earlier setup cleared (DF50), in the default setup order
    operations: withThroughDepths(operations, throughDepths(operations, stockGeometry, port)),
    references,
    ...(Object.keys(dependants.unwrap()).length === 0 ? {} : { dependants: dependants.unwrap() }),
    ...cloneGroups(part.operations),
  })
}

/**
 * Per repeated source operation (an owned role `<n>_<source id>` with n ≥ 2, Clones), the source
 * id and its instances' ids in design order; left out when there are none, so inputs without
 * Clones stay byte-identical. Evaluation subtracts them in clone layers
 * (docs/architecture/geometry.md#clone-layers).
 */
function cloneGroups(ops: readonly Operation[]): { cloneGroups?: string[][] } {
  const ids = new Set(ops.map((o) => o.id))
  const groups = new Map<string, string[]>()
  for (const op of ops) {
    if (op.owner.isNone()) continue
    const { featureId, role } = op.owner.unwrap()
    if (instanceOf(role) < 2) continue
    const source = stepOf(role)
    const key = `${featureId}\0${source}`
    let g = groups.get(key)
    if (g === undefined) groups.set(key, (g = ids.has(source) ? [source] : []))
    g.push(op.id)
  }
  return groups.size === 0 ? {} : { cloneGroups: [...groups.values()] }
}

function operationGeometry(
  op: Operation,
  index: number,
  table: SurfaceTable,
  shapes: Part['shapes'],
  port: Region2dPort | undefined,
  ops: readonly Operation[],
  ctx: {
    readonly built: readonly OperationGeometry[]
    readonly stock: Stock
    readonly snapshots?: ProjectDoc['snapshots']
  },
): AppResult<OperationGeometry> {
  const entry = table.get(op.on)
  if (entry.isNone() || entry.unwrap().owner >= index)
    return bug(op, `on surface ${op.on} does not exist before the operation`)
  const on = entry.unwrap()
  // `+z` is left out, so top-face inputs stay exactly as in v0.1
  const direction: { direction?: Direction } =
    on.direction === '+z' ? {} : { direction: on.direction }
  switch (op.kind) {
    case 'facing':
      return Ok({ kind: 'facing', id: op.id, ...direction, depth: op.depth.canonical })
    case 'pocket':
      return shapeGeometry(op.shape, shapes, port).map((shape) => ({
        kind: 'pocket',
        id: op.id,
        ...direction,
        onZ: on.faceZ.toNumber(),
        shape,
        // a through pocket (patterns P4): the material below `on`, read fresh
        ...(op.through === true
          ? { depth: on.faceZ.add(table.extent(on.direction)).toNumber(), through: true as const }
          : { depth: op.depth.canonical }),
        floorRadius: op.floorRadius.canonical,
        ...(op.roughing === true ? { roughing: true as const } : {}),
      }))
    case 'drilling': {
      const base = {
        kind: 'drilling',
        id: op.id,
        ...direction,
        onZ: on.faceZ.toNumber(),
        center: vec2(op.center),
        diameter: op.diameter.canonical,
      } as const
      if (op.bottom === 'through') return Ok({ ...base, bottom: { kind: 'through' } })
      if (op.depth.isNone()) return bug(op, 'drill depth missing')
      const depth = op.depth.unwrap().canonical
      if (op.bottom === 'flat') return Ok({ ...base, bottom: { kind: 'flat', depth } })
      if (op.pointAngle.isNone()) return bug(op, 'drill point angle missing')
      return Ok({
        ...base,
        bottom: { kind: 'drillPoint', depth, pointAngle: op.pointAngle.unwrap().canonical },
      })
    }
    case 'profile':
      // v0.3 fields only when set, so v0.2 inputs (and their hashes) stay byte-identical
      return shapeGeometry(op.shape, shapes, port).map((shape) => ({
        kind: 'profile',
        id: op.id,
        ...direction,
        shape,
        side: op.side,
        slotWidth: op.slotWidth.canonical,
        ...(op.depth.isSome() ? { depth: op.depth.unwrap().canonical } : {}),
        tabs: {
          count: op.tabs.count.canonical,
          width: op.tabs.width.canonical,
          thickness: op.tabs.thickness.canonical,
          ...(op.tabs.positions.isSome()
            ? { positions: op.tabs.positions.unwrap().map((q) => q.canonical) }
            : {}),
        },
      }))
    case 'chamfer': {
      const edgeOp = ops.slice(0, index).find((o) => o.id === op.edgeOf)
      // a general edge (edge-chamfers.md E1, E2): the bevel follows every loop of its shape; on a
      // split piece the source's edge within the piece's cell (`sourceEdge`)
      if (
        chamferEdgeKind(edgeOp) === 'loop' &&
        (edgeOp?.kind === 'pocket' || edgeOp?.kind === 'profile')
      ) {
        const source = op.sourceEdge.isSome() ? op.sourceEdge.unwrap() : undefined
        // E4b: a through profile's bottom edge, read in the opposite face's frame (mirrored)
        const flip = isBottomChamfer(op, edgeOp)
          ? flipOf(edgeOp.on, on.direction, ctx.stock)
          : undefined
        const tabs =
          flip === undefined ? [] : bottomTabs(ctx.built, edgeOp.id, edgeOp.on, flip, ctx.stock)
        return shapeGeometry(source?.shape ?? edgeOp.shape, shapes, port).map((s) => ({
          kind: 'chamfer',
          id: op.id,
          ...direction,
          onZ: materialTopZ(op.on, on, ops.slice(0, index), table),
          edgeOf: op.edgeOf,
          edge: {
            shape: flip === undefined ? s : flipShape(s, flip),
            side: edgeOp.kind === 'profile' && edgeOp.side === 'outside' ? 'outside' : 'inside',
            ...(edgeOp.kind === 'pocket'
              ? edgeOp.through === true
                ? {}
                : { depth: edgeOp.depth.canonical }
              : edgeOp.depth.isSome()
                ? { depth: edgeOp.depth.unwrap().canonical }
                : {}),
            ...(source === undefined
              ? {}
              : { within: { min: vec2(source.within.min), max: vec2(source.within.max) } }),
            // E4a: chosen loops; absent = every loop
            ...(op.loops.isSome() ? { loops: op.loops.unwrap() } : {}),
            ...(tabs.length > 0 ? { tabs } : {}),
            // patterns P3: the cells' bevels meeting is the pattern's finding (its own chamfer;
            // a separate chamfer on the cells keeps the region-wide check)
            ...(op.owner.isSome() &&
            PATTERN_CHAMFER_ROLES.has(op.owner.unwrap().role) &&
            isPatternShape(source?.shape ?? edgeOp.shape, shapes)
              ? { pattern: true }
              : {}),
          },
          width: op.width.canonical,
          angle: op.angle.canonical,
          ...(op.cornerLift ? { cornerLift: true as const } : {}),
        }))
      }
      const edge = chamferEdge(ops.slice(0, index), op.edgeOf)
      if (edge === undefined) return bug(op, `edge ${op.edgeOf} is not an earlier round operation`)
      return Ok({
        kind: 'chamfer',
        id: op.id,
        ...direction,
        onZ: on.faceZ.toNumber(),
        // the edge's own axis, so both solids are placed by one transform (coaxial)
        center: edge.center,
        edgeOf: op.edgeOf,
        edgeDiameter: edge.diameter,
        // the chamfer's diameter from its edge (D45: the width is stored)
        diameter: chamferDiameter(
          op,
          ops.find((o) => o.id === op.edgeOf),
        )!.toNumber(),
        angle: op.angle.canonical,
        ...(op.stepdown.isSome() ? { stepdown: op.stepdown.unwrap().canonical } : {}),
      })
    }
    case 'line': {
      // E3: an engraved pattern's owned shape is many lines (its motif placed in the face frame)
      const placed = collect(
        op.paths.map((p) => {
          const rec = shapes?.get(p.shapeId)?.engraving
          if (rec !== undefined)
            return engravingPaths(p, rec, shapes, port) as AppResult<
              { shape: ShapeGeometry; levels: LinePathLevels | null | undefined }[]
            >
          return shapeGeometry(p, shapes, port).map(
            (g): { shape: ShapeGeometry; levels: LinePathLevels | null | undefined }[] => [
              // E2's `scale` is the placement's (placement.ts `shapeOrientation`)
              { shape: g, levels: undefined },
            ],
          )
        }),
      )
      if (placed.isErr()) return Err(placed.unwrapErr())
      const entries = op.paths.flatMap((p, i) =>
        placed.unwrap()[i]!.map((x) => ({ path: p, ...x })),
      )
      const paths = Ok(entries.map((x) => x.shape))
      // E2: levels only with `{ min, max }`, so constant and start → end inputs stay as they were
      const levels =
        op.depth.kind === 'levels'
          ? entries.map((x) =>
              x.levels !== undefined ? x.levels : linePathLevels(x.path, x.shape, shapes),
            )
          : []
      return Ok({
        kind: 'line',
        id: op.id,
        ...direction,
        onZ: on.faceZ.toNumber(),
        paths: paths.unwrap(),
        depth: lineDepths(op.depth),
        ...(levels.some((l) => l !== null) ? { levels } : {}),
        ...(op.depth.kind === 'levels' && op.blend.isSome()
          ? { blend: op.blend.unwrap().canonical }
          : {}),
        ...(op.within.isSome()
          ? {
              within: {
                min: vec2(op.within.unwrap().min),
                max: vec2(op.within.unwrap().max),
              },
            }
          : {}),
        cutter: lineCutter(op, ctx.snapshots),
      })
    }
  }
}

/**
 * An engraved pattern's owned shape on a Line path (engraved-patterns.md E3): its lines placed in
 * the face frame (engraving/resolve.ts), moved by the path's centre (the owned Line's is [0, 0];
 * a Clones copy's is its offset), each with its levels.
 */
function engravingPaths(
  p: LinePath,
  rec: EngravingRecord,
  shapes: Part['shapes'],
  port: Region2dPort | undefined,
): AppResult<{ shape: ShapeGeometry; levels: LinePathLevels | null }[]> {
  const at: Vec2 = [p.center[0].canonical, p.center[1].canonical]
  return resolveEngraving(rec, shapes, port)
    .mapErr((e) => e.prefixIssues('shapes', p.shapeId))
    .map((r) =>
      r.lines.map((l) => ({
        shape: at[0] === 0 && at[1] === 0 ? l.shape : { ...l.shape, center: at },
        levels: l.levels,
      })),
    )
}

/**
 * A Line path's levels (E2, engraved-patterns.md § Levels on shapes): an open path's per-vertex
 * profile by arc-length fraction, or one level for a closed shape (its items' deepest); null when
 * the shape has no levels (level 1).
 */
function linePathLevels(
  p: LinePath,
  g: ShapeGeometry,
  shapes: Part['shapes'],
): LinePathLevels | null {
  const items = shapes?.get(p.shapeId)?.items ?? []
  const paths = items.filter((i) => i.kind === 'path' && i.levels !== undefined)
  if (paths.length === 0) return null
  if (g.contour.kind === 'path') {
    const item = definitionOf([paths[0]!])[0] as Extract<ShapeItem<number>, { kind: 'path' }>
    const prof = pathLevelProfile(item)
    return prof === undefined ? null : { kind: 'path', u: prof.u, level: prof.level }
  }
  const all = paths.flatMap((i) => {
    const lv = (i as Extract<ShapeItem<Quantity>, { kind: 'path' }>).levels!
    return typeof lv === 'number' ? [lv] : lv
  })
  return { kind: 'loops', level: Math.max(...all) }
}

/**
 * The tool a Line's groove takes (engraved-patterns.md § Line operation): its tool field's chamfer
 * mill (V-bit), ball or flat end mill; else (auto with nothing chosen, another type, a snapshot
 * that does not resolve) the default 60° V-bit.
 */
export function lineCutter(op: Operation, snapshots?: ProjectDoc['snapshots']): LineCutter {
  if (op.tool.isNone()) return DEFAULT_LINE_CUTTER
  const t = resolveDesignTool(op.tool.unwrap(), snapshots ?? {})
  if (t.isNone()) return DEFAULT_LINE_CUTTER
  const tool = t.unwrap()
  if (tool.type === 'chamferMill' && tool.angle !== undefined)
    return {
      kind: 'vBit',
      diameter: tool.diameter,
      angle: tool.angle,
      tipDiameter: tool.tipDiameter ?? 0,
    }
  if (tool.type === 'ballEndMill') return { kind: 'ball', diameter: tool.diameter }
  if (tool.type === 'flatEndMill') return { kind: 'flat', diameter: tool.diameter }
  return DEFAULT_LINE_CUTTER
}

/** A pattern's own chamfers: its top edges (P3) and its through cells' bottom edges (P5). */
const PATTERN_CHAMFER_ROLES: ReadonlySet<string> = new Set(['chamfer', 'bottomChamfer'])

/** A named shape that is a pattern's owned cells (patterns P3). */
const isPatternShape = (shape: Shape, shapes: Part['shapes']): boolean =>
  shape.kind === 'named' && shapes?.get(shape.shapeId)?.pattern !== undefined

/** The 2D map from a stock face's frame to the opposite face's (E4b). */
type Flip = ReturnType<typeof faceToFace>

function flipOf(edgeOn: string, to: Direction, stock: Stock): Flip | undefined {
  const from = stockFaceDirection(edgeOn)
  return from === undefined ? undefined : faceToFace(from, to, stockSize(stock))
}

const stockSize = (stock: Stock) => ({
  length: stock.length.canonical,
  width: stock.width.canonical,
  thickness: stock.thickness.canonical,
})

const flipPoint = (f: Flip, p: readonly [number, number]): [number, number] => [
  f.m[0][0] * p[0] + f.m[0][1] * p[1] + f.t[0] + 0,
  f.m[1][0] * p[0] + f.m[1][1] * p[1] + f.t[1] + 0,
]

/**
 * A shape read in the opposite face's frame (E4b): its centre moved, its loops mirrored about it
 * (reversed, so outer loops stay counter-clockwise). Opposite faces mirror one axis: a rectangle
 * or a circle keeps its contour.
 */
function flipShape(s: ShapeGeometry, f: Flip): ShapeGeometry {
  const center = flipPoint(f, s.center)
  // [u, v] ↦ [u, −v]: mirror then a half turn; [u, v] ↦ [−u, v]: the mirror alone
  const o = { mirror: true, rotation: f.m[1][1] < 0 ? 180 : 0 }
  const c = s.contour
  if (c.kind === 'region')
    return { center, contour: { kind: 'region', region: orientRegion(c.region, o) } }
  if (c.kind === 'path') return { center, contour: { kind: 'path', path: orientPath(c.path, o) } }
  return { center, contour: c }
}

/**
 * The tabs of the through profile `edgeId` (its geometry among `built`) a bottom chamfer stops
 * short of (E4b): each resolved tab centre as a point on the profile's loop, in the chamfer's
 * face frame, with the tab's width. Empty when the profile builds no tabs.
 */
function bottomTabs(
  built: readonly OperationGeometry[],
  edgeId: string,
  edgeOn: string,
  f: Flip,
  stock: Stock,
): LoopChamferTab[] {
  const g = built.find((o) => o.id === edgeId)
  const d = stockFaceDirection(edgeOn)
  if (g?.kind !== 'profile' || d === undefined || g.tabs.count === 0) return []
  const { chain } = profileChain(g)
  const length = chainLength(chain)
  if (!(length > 0)) return []
  const local = localStock(d, stockSize(stock))
  return resolveProfileTabs(g, local).centres.flatMap((c) => {
    const p = chainPointAt(chain, ((c % length) + length) % length, true)
    return p.isOk() ? [{ at: flipPoint(f, p.unwrap().point), width: g.tabs.width }] : []
  })
}

/**
 * Where a loop chamfer's bevel sits (edge-chamfers.md E2): the face of `on`, or, when `on` is a
 * stock face that earlier facings of its direction cut down, the deepest such floor: the top of
 * the material along the edge (a part's outline profiled from `stock.top` after a top facing).
 */
function materialTopZ(
  onId: string,
  on: { readonly faceZ: { toNumber(): number }; readonly direction: Direction },
  before: readonly Operation[],
  table: SurfaceTable,
): number {
  let z = on.faceZ.toNumber()
  if (!onId.startsWith('stock.')) return z
  for (const f of before) {
    if (f.kind !== 'facing') continue
    const floor = table.get(`${f.id}.floor`)
    if (floor.isNone() || floor.unwrap().direction !== on.direction) continue
    z = Math.min(z, floor.unwrap().faceZ.toNumber())
  }
  return z
}

/**
 * The circular edge a chamfer bevels (design-v0.4.md § Chamfer operation): the mouth of the
 * drilling, circle pocket or inside circle profile `edgeOf` among `before`, as its axis `[u, v]` and diameter (float64
 * mm, as that operation's own geometry input). Undefined: no such round operation.
 */
export function chamferEdge(
  before: readonly Operation[],
  edgeOf: string,
): { center: readonly [number, number]; diameter: number } | undefined {
  const e = before.find((o) => o.id === edgeOf)
  const diameter = circularEdgeDiameter(e)
  if (e === undefined || diameter === undefined) return undefined
  if (e.kind === 'drilling') return { center: vec2(e.center), diameter: diameter.canonical }
  if (e.kind === 'pocket' || e.kind === 'profile')
    return { center: shapeCentre(e.shape), diameter: diameter.canonical }
  return undefined
}

function bug(op: Operation, message: string): AppResult<never> {
  return fail('internal.unexpected', message, {
    where: 'toGeometryInput',
    data: { operationId: op.id },
  })
}
