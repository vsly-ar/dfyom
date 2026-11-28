/**
 * The removal solid of a one-sided chamfer along a groove (DF147 SL4): a pointed cone of the
 * chamfer's angle swept along the groove's wall on the kept side (`wallPath` at the half width), its
 * tip at the bevel's depth, so its kept-side flank is the bevel and its other flank lies in the
 * slot (air). Open ends run on past the face; an inner end stops short by the bevel's width (the
 * slot's round end is not chamfered). Role `bevel`.
 * Doc: docs/modes/engraved-patterns.md#one-sided-chamfer-along-a-line
 */
import { Ok, type AppResult } from '../../shared/result'
import { localStock } from './face'
import { lineSolids } from './line'
import type { LocalSolids } from './local-solids'
import { OVERSHOOT, type StockGeometry, type WallChamferGeometry } from './model'
import { localSolids, Table } from './local-solids'
import { isWallRefusal, wallChamferDepth, wallPath } from './wall-chamfer'

export function wallChamferSolids(
  op: WallChamferGeometry,
  stock: StockGeometry,
): AppResult<LocalSolids> {
  const h = wallChamferDepth(op)
  const face = localStock(op.direction ?? '+z', stock)
  const elements = wallPath(op.wall, op.wall.halfWidth, op.width, face)
  // nothing left, or a path the toolpath refuses (its error names why): no removal
  if (elements === undefined || isWallRefusal(elements))
    return Ok(localSolids(op.id, new Table(), { removal: [] }))
  const t = Math.tan(((op.angle / 2) * Math.PI) / 180)
  return lineSolids(
    {
      kind: 'line',
      id: op.id,
      ...(op.direction === undefined ? {} : { direction: op.direction }),
      onZ: op.onZ,
      paths: [{ center: [0, 0], contour: { kind: 'path', path: { elements } } }],
      depth: { start: h, end: h },
      // the cone runs on above the face (no cylinder below it)
      cutter: {
        kind: 'vBit',
        diameter: 2 * (h + 2 * OVERSHOOT) * t,
        angle: op.angle,
        tipDiameter: 0,
      },
    },
    'bevel',
  )
}
