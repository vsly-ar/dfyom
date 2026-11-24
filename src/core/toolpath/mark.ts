/**
 * Witness mark (alignment phase 1, an alignment aid): a pointed V-bit plunged once to the mark's
 * depth at a spot, or plunged at a line's start and fed along it to its end (across an edge it
 * leaves a V notch on the side face), then up. One pass at the depth; the depth comes from the
 * plan (`d = markDiameter / (2·tan(α/2))`).
 * Doc: docs/modes/alignment.md#alignment-aids, docs/modes/alignment.md#implementation-slice-2
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, toolpath } from './common'
import type { DrillCuttingParams, GeneratorInput, Toolpath, Vec2, Vec3 } from './model'
import { MoveBuilder } from './path'

/** A mark in the face frame: `from` = `to` for a spot; `depth` below the face (mm, > 0). */
export interface MarkOperation {
  readonly id: string
  readonly from: Vec2
  readonly to: Vec2
  readonly depth: number
}

export type MarkInput = GeneratorInput<MarkOperation, Record<string, never>, DrillCuttingParams>

export function generateMark(input: MarkInput, steps: Steps = noSteps): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op } = input
  const issues = commonIssues(input)
  issues.positive('operation.depth', op.depth)
  if (tool.type !== 'chamferMill' || (tool.tipDiameter ?? 0) > 1e-9)
    issues.rule('check', 'tool.type', 'pointedVBit', 'a witness mark needs a pointed V-bit')
  const ok = issues.result('generateMark', input.planOperationId).andThen(() => steps.step())
  if (ok.isErr()) return Err(ok.unwrapErr())
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const b = new MoveBuilder()
  b.pass('finish')
  b.rapid(at(op.from, heights.clearanceHeight))
  b.rapid(at(op.from, heights.retractHeight))
  b.line(at(op.from, -op.depth), cutting.plungeRate)
  const line = Math.hypot(op.to[0] - op.from[0], op.to[1] - op.from[1]) > 1e-9
  if (line) b.line(at(op.to, -op.depth), cutting.feedRate)
  b.rapid(at(line ? op.to : op.from, heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}
