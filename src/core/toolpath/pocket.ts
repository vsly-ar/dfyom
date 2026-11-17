/**
 * Pocket: offset clearing from the center outwards, helix/ramp/plunge entry, wall finishing.
 * Doc: docs/modes/plan-v0.1.md#pocket-offset-clearing and #toolpath-generators-task-210
 */
import { EPSILON, type Contour, type Vec2, type Vec3 } from '../geometry/model'
import { Err, Ok, type AppResult } from '../../shared/result'
import { commonIssues, levels, toolpath } from './common'
import { rowPositions } from './facing'
import type { PocketInput, Toolpath } from './model'
import { flat, MoveBuilder, offsetRing, segPoint, slope, type Seg } from './path'

/** Sizes within this count as equal when a tool must fit (mm), as in the DFM tool checks. */
export const TOOL_FIT_TOLERANCE = 0.01

/** Half the narrowest size: the inward offset at which the contour collapses. */
export function inradius(c: Contour): number {
  return c.kind === 'circle' ? c.radius : Math.min(c.length, c.width) / 2
}

/** Arc length of the middle of `wall[0]` (circle: the front point): where rings start. */
export function wallMiddle(c: Contour): number {
  return c.kind === 'circle' ? 0 : (c.length - 2 * c.cornerRadius) / 2
}

/**
 * Largest ring spacing for which the flat of the tool (radius `flatRadius`) still covers the
 * floor: 2·flat between parallel rings, √2·flat between the sharp corners of rectangle rings.
 */
export function coverSpacing(c: Contour, stepover: number, flatRadius: number): number {
  return Math.min(stepover, (c.kind === 'circle' ? 2 : Math.SQRT2) * flatRadius)
}

/**
 * Offsets of the clearing rings, innermost first: from `outermost` towards the center in equal
 * steps of at most `spacing`, the innermost no more than `spacing / 2` from the collapse
 * offset `m`, so it covers the center.
 */
export function ringOffsets(outermost: number, m: number, spacing: number): number[] {
  return rowPositions(outermost, Math.max(outermost, m - spacing / 2), spacing).reverse()
}

export function generatePocket(input: PocketInput): AppResult<Toolpath> {
  const { tool, cutting, heights, operation: op, strategy: st } = input
  const contour = op.shape.contour
  const c = op.shape.center
  const issues = commonIssues(input)
  issues.positive('operation.depth', op.depth)
  issues.nonNegative('strategy.finishAllowance', st.finishAllowance)
  issues.positive('strategy.finishStepdown', st.finishStepdown)
  issues.positive('strategy.helixDiameter', st.helixDiameter)
  if (!(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
    })
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
  const R = tool.diameter / 2
  const m = inradius(contour)
  const flatRadius = R - tool.cornerRadius
  if (R > m + TOOL_FIT_TOLERANCE)
    issues.rule('check', 'tool.diameter', 'toolTooLarge', 'the tool is wider than the pocket', {
      diameter: tool.diameter,
      narrowest: 2 * m,
    })
  if (tool.diameter > 0 && flatRadius <= EPSILON)
    issues.rule('check', 'tool', 'noFlat', 'the tool has no flat bottom to clear a floor', {
      cornerRadius: tool.cornerRadius,
    })
  const ok = issues.result('generatePocket', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  const wall = Math.min(R, m)
  const outermost = Math.min(R + st.finishAllowance, m)
  const offsets = ringOffsets(outermost, m, coverSpacing(contour, cutting.stepover, flatRadius))
  const s0 = wallMiddle(contour)
  const cw = st.direction === 'conventional'
  const ring = (o: number): Seg[] => offsetRing(contour, o, c, s0, cw)
  const floor = op.onZ - op.depth
  const retract = op.onZ + heights.retractHeight
  const tan = Math.tan((st.rampAngle * Math.PI) / 180)
  const feed = cutting.feedRate

  // entry: helix → ramp → plunge, whichever fits first (from the requested one on)
  const helixRadius = st.helixDiameter / 2
  const helixFits = st.helixDiameter + tool.diameter <= 2 * m + EPSILON
  const longX = contour.kind === 'circle' || contour.length >= contour.width
  const longSize =
    contour.kind === 'circle' ? 2 * contour.radius : Math.max(contour.length, contour.width)
  const rampLength = longSize - tool.diameter
  const rampFits = rampLength >= tool.diameter - EPSILON
  const order = ['helix', 'ramp', 'plunge'] as const
  const entry = order
    .slice(order.indexOf(st.entry))
    .find((e) => (e === 'helix' ? helixFits : e === 'ramp' ? rampFits : true))!
  const dir: Vec2 = longX ? [1, 0] : [0, 1]
  const rampA: Vec2 = [c[0] - (dir[0] * rampLength) / 2, c[1] - (dir[1] * rampLength) / 2]
  const rampB: Vec2 = [c[0] + (dir[0] * rampLength) / 2, c[1] + (dir[1] * rampLength) / 2]
  const helixStart: Vec2 = [c[0], c[1] - helixRadius]
  const entryStart = entry === 'helix' ? helixStart : entry === 'ramp' ? rampA : c
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]

  const b = new MoveBuilder()
  let previous = op.onZ
  for (const z of levels(op.onZ, floor, cutting.stepdown)) {
    b.pass('rough')
    if (b.position === undefined) b.rapid(at(entryStart, heights.clearanceHeight))
    b.rapid(at(entryStart, retract))
    if (entry === 'helix') {
      const circle: Seg = {
        kind: 'arc',
        center: c,
        radius: helixRadius,
        start: -Math.PI / 2,
        sweep: cw ? -2 * Math.PI : 2 * Math.PI,
      }
      const turns = Math.max(
        1,
        Math.ceil((previous - z) / (2 * Math.PI * helixRadius * tan) - 1e-9),
      )
      b.line(at(helixStart, previous), cutting.plungeRate)
      for (const s of slope(Array<Seg>(turns).fill(circle), previous, z)) b.seg(s, feed)
      for (const s of flat([circle], z)) b.seg(s, feed) // flatten the helix floor
    } else if (entry === 'ramp') {
      const legs = Math.max(1, Math.ceil((previous - z) / (rampLength * tan) - 1e-9))
      const leg = (i: number): Seg =>
        i % 2 === 0
          ? { kind: 'line', from: rampA, to: rampB }
          : { kind: 'line', from: rampB, to: rampA }
      b.line(at(rampA, previous), cutting.plungeRate)
      const ramp = Array.from({ length: legs }, (_, i) => leg(i))
      for (const s of slope(ramp, previous, z)) b.seg(s, feed)
      for (const s of flat([leg(legs)], z)) b.seg(s, feed) // clean the wedge under the last leg
      b.line(at(c, z), feed)
    } else b.line(at(c, z), cutting.plungeRate)
    for (const o of offsets) {
      const segs = ring(o)
      if (segs.length === 0) continue
      b.line(at(segPoint(segs[0]!, 0), z), feed)
      for (const s of flat(segs, z)) b.seg(s, feed)
    }
    b.rapid(at(xyOf(b.position!), retract))
    previous = z
  }

  // finishing: the wall ring at full size, lead-in and lead-out from the roughed ring
  if (outermost - wall > EPSILON) {
    b.pass('finish')
    const wallRing = ring(wall)
    const lead = ring(outermost)
    const leadPoint = lead.length > 0 ? segPoint(lead[0]!, 0) : c
    const wallStart = wallRing.length > 0 ? segPoint(wallRing[0]!, 0) : c
    b.rapid(at(leadPoint, retract))
    for (const z of levels(op.onZ, floor, st.finishStepdown)) {
      b.line(at(leadPoint, z), cutting.plungeRate)
      b.line(at(wallStart, z), feed)
      for (const s of flat(wallRing, z)) b.seg(s, feed)
      b.line(at(leadPoint, z), feed)
    }
    b.rapid(at(leadPoint, retract))
  }
  b.rapid(at(xyOf(b.position!), heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}

const xyOf = (p: Vec3): Vec2 => [p[0], p[1]]
