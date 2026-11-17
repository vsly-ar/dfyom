/**
 * Design part → geometry input: quantities to canonical float64 mm/degrees, `on` to `onZ`.
 * Pure; the geometry types are owned by src/core/geometry/model.ts.
 * Doc: docs/modes/design.md#implementation-task-25, docs/architecture/geometry.md#evaluation-rules
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type {
  Contour,
  OperationGeometry,
  PartGeometryInput,
  Shape as ShapeGeometry,
} from '../geometry/model'
import type { Stock } from '../library/stock'
import type { Operation, Part, Point, Shape } from './operation'
import { SurfaceTable } from './surfaces'

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
  for (const [i, op] of part.operations.entries()) {
    const g = operationGeometry(op, i, table)
    if (g.isErr()) return Err(g.unwrapErr())
    operations.push(g.unwrap())
  }
  return Ok({
    stock: {
      length: stock.length.canonical,
      width: stock.width.canonical,
      thickness: stock.thickness.canonical,
    },
    operations,
  })
}

function operationGeometry(
  op: Operation,
  index: number,
  table: SurfaceTable,
): AppResult<OperationGeometry> {
  const onZ = (id: string): AppResult<number> => {
    const e = table.get(id)
    return e.isSome() && e.unwrap().owner < index
      ? Ok(e.unwrap().z.z.toNumber())
      : bug(op, `on surface ${id} does not exist before the operation`)
  }
  switch (op.kind) {
    case 'facing':
      return Ok({ kind: 'facing', id: op.id, depth: op.depth.canonical })
    case 'pocket':
      return onZ(op.on).map((z) => ({
        kind: 'pocket',
        id: op.id,
        onZ: z,
        shape: shapeGeometry(op.shape),
        depth: op.depth.canonical,
        floorRadius: op.floorRadius.canonical,
      }))
    case 'drilling': {
      const z = onZ(op.on)
      if (z.isErr()) return Err(z.unwrapErr())
      const base = {
        kind: 'drilling',
        id: op.id,
        onZ: z.unwrap(),
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
