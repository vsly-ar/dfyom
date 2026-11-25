/**
 * Edge chamfer (E1): a chamfer along a general edge, the top edge of a pocket of any shape or of
 * an inside profile, every loop (islands included). The path is the edge's air region shrunk by
 * the tip radius (the 2D port), at tip Z = face − width / tan(α / 2), so the cone reaches `width`
 * into the material at the face; one loop each, one `finish` pass. Circular chamfers keep
 * `generateChamfer` (chamfer.ts).
 * Doc: docs/modes/edge-chamfers.md#toolpath-plan, docs/modes/edge-chamfers.md#implementation-e1
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  CHAMFER_ANGLE_TOLERANCE,
  coneSlant,
  loopChamferDepth,
  type LoopChamferGeometry,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { loopChamferAir } from '../geometry/outline'
import { regionLoops } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import type { CutDirection, DrillCuttingParams, GeneratorInput, Toolpath } from './model'
import { flat, MoveBuilder, segLength, segReverse, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'
import { loopRing, ringFrom, ringStart } from './region-rings'

/** A loop chamfer as the generator reads it: its geometry input without the face direction. */
export type EdgeChamferOperation = Omit<LoopChamferGeometry, 'direction'>

/** Climb runs each loop with the air on its left (counter-clockwise in a pocket); one ring. */
export interface EdgeChamferStrategy {
  readonly direction: CutDirection
}

export type EdgeChamferInput = GeneratorInput<
  EdgeChamferOperation,
  EdgeChamferStrategy,
  DrillCuttingParams
>

/** The tip Z of an edge chamfer: the bevel's depth below its face. */
export const edgeChamferTipZ = (op: EdgeChamferOperation): number => op.onZ - loopChamferDepth(op)

/** The tool axis loops: the air region shrunk by the tip radius, in the face frame. */
export function edgeChamferLoops(
  op: EdgeChamferOperation,
  tipDiameter: number,
  port: Region2dPort,
): AppResult<Seg[][]> {
  return port
    .offset(loopChamferAir(op), tipDiameter / 2)
    .map((p) => regionLoops(p).map((l) => loopRing(l)))
}

export function generateEdgeChamfer(
  input: EdgeChamferInput,
  port: Region2dPort,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const issues = commonIssues(input)
  issues.positive('operation.width', op.width)
  if (!(op.angle > 0 && op.angle < 180))
    issues.rule('invariant', 'operation.angle', 'range', 'angle must be in (0°, 180°)', {
      angle: op.angle,
    })
  const tip = tool.tipDiameter ?? 0
  if (tool.type !== 'chamferMill' || tool.angle === undefined)
    issues.rule('check', 'tool.type', 'toolType', 'a chamfer needs a chamfer mill')
  else {
    if (Math.abs(tool.angle - op.angle) > CHAMFER_ANGLE_TOLERANCE)
      issues.rule('check', 'tool.angle', 'angle', 'the tool angle differs from the chamfer angle', {
        angle: tool.angle,
        chamfer: op.angle,
      })
    // one ring: the cutting edge covers the bevel, (DC − dt) / 2 ≥ width (rule `slant`)
    const edge = coneSlant(tip, tool.diameter, tool.angle)
    const slant = coneSlant(0, 2 * op.width, op.angle)
    if (edge + TOOL_FIT_TOLERANCE < slant)
      issues.rule('check', 'tool.diameter', 'slant', 'the cutting edge is shorter than the slant', {
        cuttingEdge: edge,
        slant,
      })
  }
  const loops = edgeChamferLoops(op, tip, port)
  if (loops.isErr()) return Err(loops.unwrapErr())
  const rings = loops.unwrap().filter((r) => r.length > 0)
  // air narrower than the tip everywhere: nothing of the edge is reached
  if (rings.length === 0)
    issues.rule('check', 'tool.tipDiameter', 'tip', "the tip does not fit the edge's opening", {
      tipDiameter: tip,
    })
  const ok = issues.result('generateEdgeChamfer', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  const tipZ = edgeChamferTipZ(op)
  const retract = op.onZ + heights.retractHeight
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const b = new MoveBuilder()
  b.pass('finish')
  let here: Vec2 = [0, 0]
  const left = rings.map((r) =>
    startAtLongest(st.direction === 'climb' ? r : [...r].reverse().map(segReverse)),
  )
  for (let k = 0; left.length > 0; k++) {
    const step = steps.step({
      done: k,
      total: rings.length,
      label: `loop ${k + 1}/${rings.length}`,
    })
    if (step.isErr()) return Err(step.unwrapErr())
    // loops in nearest-neighbour order of their start points
    let best = 0
    left.forEach((r, i) => {
      if (dist(ringStart(r), here) < dist(ringStart(left[best]!), here) - 1e-12) best = i
    })
    const ring = left.splice(best, 1)[0]!
    const start = ringStart(ring)
    // down in the air beside the edge (the edge's operation cut it), one loop, out
    b.rapid(at(start, heights.clearanceHeight))
    b.rapid(at(start, retract))
    b.line(at(start, tipZ), cutting.plungeRate)
    for (const s of flat(ring, tipZ)) b.seg(s, cutting.feedRate)
    b.rapid(at(start, heights.clearanceHeight))
    here = start
  }
  return Ok(toolpath(input, b.build()))
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * The ring from the middle of its longest line, else its longest arc (the pocket finishing
 * pass's rule, plan-v0.3.md § Implementation (T1)): the plunge stays off the corners.
 */
function startAtLongest(ring: readonly Seg[]): Seg[] {
  let li = 0
  ring.forEach((s, i) => {
    const better =
      (s.kind === 'line') !== (ring[li]!.kind === 'line')
        ? s.kind === 'line'
        : segLength(s) > segLength(ring[li]!) + 1e-9
    if (better) li = i
  })
  return ringFrom(ring, li, 0.5)
}
