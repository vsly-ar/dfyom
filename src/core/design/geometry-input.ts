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
import type { Operation, Part, Point, Shape } from './operation'
import { operationReferences, SurfaceTable } from './surfaces'

const vec2 = (p: Point) => [p[0].canonical, p[1].canonical] as const

function shapeGeometry(s: Shape): ShapeGeometry {
  const contour: Contour =
    s.kind === 'circle'
      ? { kind: 'circle', radius: s.diameter.canonical / 2 }
      : {
          kind: 'rectangle',
          length: s.length.canonical,
          width: s.width.canonical,
          cornerRadius: s.cornerRadius.canonical,
        }
  return { center: vec2(s.center), contour }
}

/**
 * The geometry input of a (valid) part. A dangling `on` or a missing drill depth cannot happen
 * after the commands' checks, so it is `internal.unexpected`.
 */
export function toGeometryInput(part: Part, stock: Stock): AppResult<PartGeometryInput> {
  const table = SurfaceTable.build(part.operations, stock)
  const operations: OperationGeometry[] = []
  const references: SurfaceReference[] = []
  for (const [i, op] of part.operations.entries()) {
    const g = operationGeometry(op, i, table)
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
  return Ok({
    stock: {
      length: stock.length.canonical,
      width: stock.width.canonical,
      thickness: stock.thickness.canonical,
    },
    operations,
    references,
  })
}

function operationGeometry(
  op: Operation,
  index: number,
  table: SurfaceTable,
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
      return Ok({
        kind: 'pocket',
        id: op.id,
        ...direction,
        onZ: on.faceZ.toNumber(),
        shape: shapeGeometry(op.shape),
        depth: op.depth.canonical,
        floorRadius: op.floorRadius.canonical,
      })
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
      return Ok({
        kind: 'profile',
        id: op.id,
        ...direction,
        shape: shapeGeometry(op.shape),
        side: op.side,
        slotWidth: op.slotWidth.canonical,
        tabs: {
          count: op.tabs.count.canonical,
          width: op.tabs.width.canonical,
          thickness: op.tabs.thickness.canonical,
        },
      })
  }
}

function bug(op: Operation, message: string): AppResult<never> {
  return fail('internal.unexpected', message, {
    where: 'toGeometryInput',
    data: { operationId: op.id },
  })
}
