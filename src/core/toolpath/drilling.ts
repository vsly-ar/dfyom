/**
 * Drilling: one hole per operation, as a drill cycle (drill) or by helical boring (end mill).
 * Doc: docs/modes/plan-v0.1.md#drilling and #toolpath-generators-task-210
 */
import { EPSILON, type Vec2, type Vec3 } from '../geometry/model'
import { Err, Ok, type AppResult } from '../../shared/result'
import { commonIssues, toolpath } from './common'
import type { DrillingInput, Toolpath } from './model'
import { flat, MoveBuilder, slope, type Seg } from './path'
import { TOOL_FIT_TOLERANCE } from './pocket'

/** Length of a drill's conical tip: radius / tan(SIG / 2). */
export function tipLength(diameter: number, pointAngle: number): number {
  return pointAngle >= 180 ? 0 : diameter / 2 / Math.tan((pointAngle * Math.PI) / 360)
}

export function generateDrilling(input: DrillingInput): AppResult<Toolpath> {
  const { tool, cutting, heights, stock, operation: op, strategy: st } = input
  const issues = commonIssues(input)
  issues.positive('operation.diameter', op.diameter)
  issues.nonNegative('strategy.breakthrough', st.breakthrough)
  if (op.bottom.kind !== 'through') issues.positive('operation.depth', op.bottom.depth)
  if (st.cycle === 'peck' || st.cycle === 'chipBreak')
    issues.positive('strategy.peckDepth', st.peckDepth)
  if (st.cycle === 'chipBreak') issues.positive('strategy.chipBreakBack', st.chipBreakBack)
  if (st.cycle === 'helix') issues.positive('strategy.helixPitch', st.helixPitch)

  const isDrill = tool.type === 'drill'
  if (st.cycle === 'helix') {
    if (isDrill)
      issues.rule(
        'check',
        'strategy.cycle',
        'helixNeedsEndMill',
        'helical boring needs an end mill',
      )
    if (!(tool.diameter > op.diameter / 2 && tool.diameter < op.diameter - EPSILON))
      issues.rule(
        'check',
        'tool.diameter',
        'boringToolSize',
        'helical boring needs diameter/2 < DC < diameter',
        {
          diameter: tool.diameter,
          hole: op.diameter,
        },
      )
    if (op.bottom.kind === 'drillPoint')
      issues.rule(
        'check',
        'operation.bottom',
        'pointNeedsDrill',
        'a drill-point bottom needs a drill',
      )
  } else {
    if (!isDrill)
      issues.rule('check', 'strategy.cycle', 'cycleNeedsDrill', `cycle ${st.cycle} needs a drill`)
    if (Math.abs(tool.diameter - op.diameter) > TOOL_FIT_TOLERANCE)
      issues.rule(
        'check',
        'tool.diameter',
        'drillSize',
        'the drill diameter differs from the hole',
        {
          diameter: tool.diameter,
          hole: op.diameter,
        },
      )
    if (op.bottom.kind === 'flat')
      issues.rule(
        'check',
        'operation.bottom',
        'flatNeedsEndMill',
        'a drill cannot make a flat bottom',
      )
    if (
      isDrill &&
      !(tool.pointAngle !== undefined && tool.pointAngle > 0 && tool.pointAngle <= 180)
    )
      issues.rule(
        'invariant',
        'tool.pointAngle',
        'range',
        'a drill needs a point angle in (0°, 180°]',
        {
          pointAngle: tool.pointAngle,
        },
      )
  }
  const ok = issues.result('generateDrilling', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  // z where the hole reaches its full diameter
  const full =
    op.bottom.kind === 'through' ? -stock.thickness - st.breakthrough : op.onZ - op.bottom.depth
  const retract = op.onZ + heights.retractHeight
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const c = op.center
  const b = new MoveBuilder()

  if (st.cycle !== 'helix') {
    b.pass('drill')
    b.rapid(at(c, heights.clearanceHeight))
    b.rapid(at(c, retract))
    b.drill({
      kind: 'drill',
      at: c,
      top: op.onZ,
      bottom: full - tipLength(tool.diameter, tool.pointAngle!),
      cycle: st.cycle,
      ...(st.cycle === 'simple' ? {} : { peck: st.peckDepth }),
      ...(st.cycle === 'chipBreak' ? { back: st.chipBreakBack } : {}),
      retract,
      feed: cutting.plungeRate,
    })
    b.rapid(at(c, heights.clearanceHeight))
    return Ok(toolpath(input, b.build()))
  }

  // helical boring: helix of radius ρ down to `full`, a full circle there, back to the center
  const radius = (op.diameter - tool.diameter) / 2
  const start: Vec2 = [c[0], c[1] - radius]
  const circle: Seg = {
    kind: 'arc',
    center: c,
    radius,
    start: -Math.PI / 2,
    sweep: st.direction === 'climb' ? 2 * Math.PI : -2 * Math.PI,
  }
  const turns = Math.max(1, Math.ceil((op.onZ - full) / st.helixPitch - 1e-9))
  b.pass('rough')
  b.rapid(at(start, heights.clearanceHeight))
  b.rapid(at(start, retract))
  b.line(at(start, op.onZ), cutting.plungeRate)
  for (const s of slope(Array<Seg>(turns).fill(circle), op.onZ, full)) b.seg(s, cutting.feedRate)
  for (const s of flat([circle], full)) b.seg(s, cutting.feedRate)
  b.line(at(c, full), cutting.feedRate)
  b.rapid(at(c, heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}
