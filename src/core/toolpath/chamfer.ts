/**
 * Chamfer (v0.4 T1): one circular chamfer per input, plunged at the centre (DC ≥ D) or
 * contoured on one ring at the chamfer depth (the fit rule makes the cutting edge cover the
 * slant, so one ring always cuts it). Doc: docs/modes/plan-v0.4.md#chamfer-toolpath
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  CHAMFER_ANGLE_TOLERANCE,
  chamferDepth,
  coneSlant,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import { HELIX_MIN_RADIUS } from './drilling'
import type { ChamferInput, Toolpath } from './model'
import { flat, MoveBuilder, slope, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'

/** Where the tool cuts a chamfer: its axis' distance from the chamfer's and its tip Z. */
export interface ChamferCut {
  /** 0 when plunged. */
  readonly ringRadius: number
  readonly tipZ: number
}

/**
 * Plunged: the tip where the tool's cone has the chamfer's Ø at the face. Contoured: the tip at
 * the chamfer's depth on the ring of radius (d − dt) / 2, where the tool's cone lies on the
 * chamfer's cone from d to D (equal angles).
 */
export function chamferCut(
  input: Pick<ChamferInput, 'operation' | 'tool' | 'strategy'>,
): ChamferCut {
  const op = input.operation
  const tip = input.tool.tipDiameter ?? 0
  return input.strategy.entry === 'plunge'
    ? { ringRadius: 0, tipZ: op.onZ - chamferDepth({ ...op, edgeDiameter: tip }) }
    : { ringRadius: (op.edgeDiameter - tip) / 2, tipZ: op.onZ - chamferDepth(op) }
}

/** One chamfer is one step (after the input checks), as one hole of a drilling. */
export function generateChamfer(input: ChamferInput, steps: Steps = noSteps): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const issues = commonIssues(input)
  issues.positive('operation.edgeDiameter', op.edgeDiameter)
  if (!(op.diameter > op.edgeDiameter))
    issues.rule('invariant', 'operation.diameter', 'greaterThanEdge', 'diameter must be > edge Ø', {
      diameter: op.diameter,
      edgeDiameter: op.edgeDiameter,
    })
  if (!(op.angle > 0 && op.angle < 180))
    issues.rule('invariant', 'operation.angle', 'range', 'angle must be in (0°, 180°)', {
      angle: op.angle,
    })
  if (st.entry === 'contour' && !(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
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
    if (tip >= op.edgeDiameter - TOOL_FIT_TOLERANCE)
      issues.rule('check', 'tool.tipDiameter', 'tip', 'the tip must be smaller than the edge Ø', {
        tipDiameter: tip,
        edgeDiameter: op.edgeDiameter,
      })
    if (st.entry === 'plunge' && tool.diameter + TOOL_FIT_TOLERANCE < op.diameter)
      issues.rule('check', 'strategy.entry', 'plungeSize', 'a plunge needs DC ≥ the chamfer Ø', {
        diameter: tool.diameter,
        chamfer: op.diameter,
      })
    if (
      st.entry === 'contour' &&
      coneSlant(tip, tool.diameter, tool.angle) + TOOL_FIT_TOLERANCE <
        coneSlant(op.edgeDiameter, op.diameter, op.angle)
    )
      issues.rule('check', 'tool.diameter', 'slant', 'the cutting edge is shorter than the slant', {
        cuttingEdge: coneSlant(tip, tool.diameter, tool.angle),
        slant: coneSlant(op.edgeDiameter, op.diameter, op.angle),
      })
  }
  const ok = issues.result('generateChamfer', input.planOperationId).andThen(() => steps.step())
  if (ok.isErr()) return Err(ok.unwrapErr())

  const { ringRadius: r, tipZ } = chamferCut(input)
  const retract = op.onZ + heights.retractHeight
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const c = op.center
  const b = new MoveBuilder()
  b.pass('finish')

  if (st.entry === 'plunge') {
    b.rapid(at(c, heights.clearanceHeight))
    b.rapid(at(c, retract))
    b.line(at(c, tipZ), cutting.plungeRate)
    b.rapid(at(c, heights.clearanceHeight))
    return Ok(toolpath(input, b.build()))
  }

  // Contour: down into the hole to the face (the tool touches nothing there), ramp along the ring
  // to the chamfer depth in whole turns (as helical boring: at most `rampAngle`, never descending
  // faster than the plunge rate), one full ring there, then a tangent half circle of radius r / 2
  // to the centre (the cone leaves the wall at once) and out.
  const sweep = st.direction === 'climb' ? 2 * Math.PI : -2 * Math.PI
  const start: Vec2 = [c[0], c[1] - r]
  const ring: Seg = { kind: 'arc', center: c, radius: r, start: -Math.PI / 2, sweep }
  b.rapid(at(start, heights.clearanceHeight))
  b.rapid(at(start, retract))
  b.line(at(start, op.onZ), cutting.plungeRate)
  const drop = op.onZ - tipZ
  if (r < HELIX_MIN_RADIUS) b.line(at(start, tipZ), cutting.plungeRate)
  else {
    const turn = 2 * Math.PI * r
    const turns = Math.max(
      1,
      Math.ceil(drop / (turn * Math.tan((st.rampAngle * Math.PI) / 180)) - 1e-9),
    )
    const perTurn = drop / turns
    const feed = Math.min(
      cutting.feedRate,
      (cutting.plungeRate * Math.hypot(turn, perTurn)) / perTurn,
    )
    for (const s of slope(Array<Seg>(turns).fill(ring), op.onZ, tipZ)) b.seg(s, feed)
  }
  for (const s of flat([ring], tipZ)) b.seg(s, cutting.feedRate)
  const exit: Seg = {
    kind: 'arc',
    center: [c[0], c[1] - r / 2],
    radius: r / 2,
    start: -Math.PI / 2,
    sweep: sweep / 2,
  }
  if (r < HELIX_MIN_RADIUS) b.line(at(c, tipZ), cutting.feedRate)
  else for (const s of flat([exit], tipZ)) b.seg(s, cutting.feedRate)
  b.rapid(at(c, heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}
