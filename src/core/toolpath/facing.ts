/**
 * Facing: parallel rows over the whole stock top, entered from the side.
 * Doc: docs/modes/plan-v0.1.md#facing and #toolpath-generators-task-210
 */
import { EPSILON, type Vec2 } from '../geometry/model'
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, cutLevels, passSteps, toolpath } from './common'
import type { FacingInput, Toolpath } from './model'
import { MoveBuilder } from './path'

/** Row positions from `a` to `b` in equal steps of at most `step` (one row if `b` < `a`). */
export function rowPositions(a: number, b: number, step: number): number[] {
  if (b - a <= EPSILON) return [(a + b) / 2]
  const n = Math.ceil((b - a) / step - 1e-9) + 1
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
}

/** `steps.step()` before every level. */
export function generateFacing(input: FacingInput, steps: Steps = noSteps): AppResult<Toolpath> {
  const { tool, cutting, heights, stock, operation: op, strategy: st } = input
  const issues = commonIssues(input)
  issues.positive('operation.depth', op.depth)
  issues.nonNegative('strategy.overshoot', st.overshoot)
  const R = tool.diameter / 2
  if (cutting.stepover > 0.9 * tool.diameter + EPSILON)
    issues.rule(
      'invariant',
      'cutting.stepover',
      'atMost',
      'stepover must be ≤ 0.9 × tool diameter',
      {
        stepover: cutting.stepover,
        max: 0.9 * tool.diameter,
      },
    )
  const flatRadius = R - tool.cornerRadius
  if (tool.diameter > 0 && flatRadius <= EPSILON)
    issues.rule('check', 'tool', 'noFlat', 'the tool has no flat bottom to face with', {
      cornerRadius: tool.cornerRadius,
    })
  const ok = issues.result('generateFacing', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  // Rows run along `axis` and step across it; (u, v) = (along, across). Each row starts and ends
  // with the tool fully outside the stock; the outer rows put the flat edge `overshoot` past it.
  const [along, across] =
    st.axis === 'x' ? [stock.length, stock.width] : [stock.width, stock.length]
  const xy = (u: number, v: number): Vec2 => (st.axis === 'x' ? [u, v] : [v, u])
  const lo = -st.overshoot - R
  const hi = along + st.overshoot + R
  const rows = rowPositions(
    -st.overshoot + flatRadius,
    across + st.overshoot - flatRadius,
    Math.min(cutting.stepover, 2 * flatRadius),
  )
  // Rows step towards +across, so uncut material lies on that side. With M3 (clockwise) climb
  // milling keeps the material on the right: axis x rows run −X, axis y rows run +Y.
  const climbForward = st.axis === 'y'
  const forward = st.direction === 'climb' ? climbForward : !climbForward
  const rowForward = (i: number) => (st.pattern === 'oneWay' || i % 2 === 0 ? forward : !forward)
  const rowStart = (i: number) => (rowForward(i) ? lo : hi)
  const rowEnd = (i: number) => (rowForward(i) ? hi : lo)

  const retract = heights.retractHeight
  const b = new MoveBuilder()
  const at = (u: number, v: number, z: number): [number, number, number] => [...xy(u, v), z]
  const zs = cutLevels(0, -op.depth, cutting.stepdown, input.material)
  const pass = passSteps(steps, zs.length)
  for (const [k, z] of zs.entries()) {
    const step = pass(k)
    if (step.isErr()) return Err(step.unwrapErr())
    b.pass('rough')
    if (b.position === undefined) b.rapid(at(rowStart(0), rows[0]!, heights.clearanceHeight))
    b.rapid(at(rowStart(0), rows[0]!, retract))
    b.line(at(rowStart(0), rows[0]!, z), cutting.plungeRate)
    rows.forEach((v, i) => {
      if (i > 0) {
        if (st.pattern === 'zigzag') b.line(at(rowStart(i), v, z), cutting.feedRate)
        else {
          b.rapid(at(rowEnd(i - 1), rows[i - 1]!, retract))
          b.rapid(at(rowStart(i), v, retract))
          b.line(at(rowStart(i), v, z), cutting.plungeRate)
        }
      }
      b.line(at(rowEnd(i), v, z), cutting.feedRate)
    })
    b.rapid(at(rowEnd(rows.length - 1), rows.at(-1)!, retract))
  }
  const end = b.position!
  b.rapid([end[0], end[1], heights.clearanceHeight])
  return Ok(toolpath(input, b.build()))
}
