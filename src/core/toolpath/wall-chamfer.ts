/**
 * The toolpath of a one-sided chamfer along a through Line (DF147 SL4): the edge chamfer's rings by
 * level (`edgeChamferPasses`, E4a / DF142: one ring when the cutting edge covers the width, else
 * levels from the wall out to the bevel), each cut as a Line along the wall on the kept side
 * (`wallPath`) at the ring's tip depth in one pass, entered from outside the stock at open ends
 * (the through Line's side entry) and by ramp-back at an inner end. Refused when the cone would
 * reach the slot's other wall.
 * Doc: docs/modes/engraved-patterns.md#one-sided-chamfer-along-a-line
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import {
  isWallRefusal,
  wallChamferDepth,
  wallPath,
  type ChamferWall,
} from '../geometry/wall-chamfer'
import { edgeChamferPasses } from './edge-chamfer'
import type { LineOperation } from './line'
import type { ToolpathTool } from './model'

/** What the wall chamfer's toolpath needs of its geometry (face frame). */
export interface WallChamferOperation {
  readonly id: string
  readonly onZ: number
  readonly width: number
  readonly angle: number
  readonly wall: ChamferWall
}

/** One ring as a Line: its operation (one pass at `depth`). */
export interface WallChamferRing {
  readonly operation: LineOperation
  readonly depth: number
}

const TOL = 1e-6

/**
 * The rings of `op` cut by `tool` (a chamfer mill) on a face `length` × `width`, outermost level
 * first, each from the wall out to the bevel; refused (`model.invariant`, rule `otherWall`)
 * when a ring's cone reaches past the slot's other wall at the face.
 */
export function wallChamferRings(
  op: WallChamferOperation,
  tool: ToolpathTool,
  face: { readonly length: number; readonly width: number },
): AppResult<WallChamferRing[]> {
  const dt = tool.tipDiameter ?? 0
  const angle = tool.angle ?? op.angle
  const t = Math.tan(((angle / 2) * Math.PI) / 180)
  const levels = edgeChamferPasses(op, { diameter: tool.diameter, tipDiameter: dt })
  const g = op.wall.halfWidth
  // a blind groove (or one above tabs): the bevel ends above its floor (rule `belowGroove`)
  const floor = op.wall.floor
  if (floor !== undefined && wallChamferDepth(op) > floor + TOL)
    return fail(
      'model.invariant',
      `${op.id}: the bevel (${wallChamferDepth(op).toFixed(2)} mm deep) reaches below the groove's wall (${floor.toFixed(2)} mm)`,
      {
        where: 'wallChamferRings',
        issues: [
          {
            path: ['operations', op.id, 'width'],
            rule: 'belowGroove',
            message: 'the bevel is deeper than the groove',
            params: { depth: wallChamferDepth(op), floor },
          },
        ],
      },
    )
  const out: WallChamferRing[] = []
  for (const level of levels)
    for (const ring of level) {
      // the axis at the wall less the ring's offset into the air (the slot)
      const d = g - ring.offset
      const reach = Math.min(tool.diameter / 2, dt / 2 + ring.depth * t)
      if (d - reach < -g - TOL)
        return fail(
          'model.invariant',
          `${op.id}: the tool's cone (${(2 * reach).toFixed(2)} mm at the face) reaches past the slot's other wall`,
          {
            where: 'wallChamferRings',
            issues: [
              {
                path: ['operations', op.id, 'width'],
                rule: 'otherWall',
                message: 'the chamfer and the tool tip are wider than the slot',
                params: { slot: 2 * g, reach: 2 * reach },
              },
            ],
          },
        )
      const elements = wallPath(op.wall, d, reach, face)
      if (isWallRefusal(elements))
        return fail('model.invariant', `${op.id}: ${elements.message}`, {
          where: 'wallChamferRings',
          issues: [
            {
              path: ['operations', op.id, 'edgeOf'],
              rule: elements.refused,
              message: elements.message,
            },
          ],
        })
      if (elements === undefined) continue
      out.push({
        depth: ring.depth,
        operation: {
          kind: 'line',
          id: op.id,
          onZ: op.onZ,
          paths: [{ center: [0, 0], contour: { kind: 'path', path: { elements } } }],
          depth: { start: ring.depth, end: ring.depth },
          cutter: { kind: 'vBit', diameter: tool.diameter, angle, tipDiameter: dt },
          // open ends are entered from outside the stock (the through Line's side entry; a capped
          // end runs out only when square on the stock edge, `openLead` checks the lead is air)
          through: true,
        },
      })
    }
  return Ok(out)
}
