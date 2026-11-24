/**
 * Design part → geometry input: quantities to canonical float64 mm/degrees, `on` to the
 * operation's `direction` and `onZ` (the z of `on` in its face frame, 0 at the stock face),
 * `on` and expression references to `references` (for `dfm.surfaceMissing`). Pure; the geometry types are owned by src/core/geometry/model.ts.
 * Doc: docs/modes/design.md#implementation-task-25, docs/architecture/geometry.md#evaluation-rules
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type {
  Contour,
  OperationGeometry,
  PartGeometryInput,
  Shape as ShapeGeometry,
  SurfaceReference,
} from '../geometry/model'
import type { Direction } from '../geometry/face'
import type { Stock } from '../library/stock'
import type { Region2dPort } from '../geometry/2d/port'
import {
  chamferDiameter,
  circularEdgeDiameter,
  isGeneralShape,
  type Operation,
  type Part,
  type Point,
  type Shape,
} from './operation'
import { throughDepths, withThroughDepths } from '../geometry/through-depth'
import { placeShape } from './placement'
import { requirePort } from './shape'
import { operationReferences, SurfaceTable } from './surfaces'
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
): AppResult<PartGeometryInput> {
  const table = SurfaceTable.build(part.operations, stock, part.shapes)
  const operations: OperationGeometry[] = []
  const references: SurfaceReference[] = []
  for (const [i, op] of part.operations.entries()) {
    const g = operationGeometry(op, i, table, part.shapes, port, part.operations)
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
        depth: op.depth.canonical,
        floorRadius: op.floorRadius.canonical,
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
  }
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
