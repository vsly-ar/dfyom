/**
 * Profile with tabs: through cut along a closed shape, slot passes from the part side away from
 * it, ramp or plunge entry, lifts over the tabs, optional finishing pass.
 * Doc: docs/modes/plan-v0.1.md#profile-with-tabs and #toolpath-generators-task-210
 */
import { contourParam, offsetContour, perimeter } from '../geometry/contour'
import { EPSILON, type Contour, type Vec2, type Vec3 } from '../geometry/model'
import { slotCoversOpening } from '../geometry/operations'
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, levels, passSteps, toolpath } from './common'
import { rowPositions } from './facing'
import type { ProfileInput, Toolpath } from './model'
import { flat, MoveBuilder, ringSegs, segPoint, slope, walkRing, type Seg, type Seg3 } from './path'
import { inradius, ringOffsets, TOOL_FIT_TOLERANCE, wallMiddle } from './pocket'
import { diskHitsBands, liftOverTabs, tabBands } from './tabs'

/** `steps.step()` before every level and before the finishing pass. */
export function generateProfile(input: ProfileInput, steps: Steps = noSteps): AppResult<Toolpath> {
  const { tool, cutting, heights, stock, operation: op, strategy: st } = input
  const shape = op.shape.contour
  const c = op.shape.center
  const T = stock.thickness
  const R = tool.diameter / 2
  const sw = op.slotWidth
  const issues = commonIssues(input)
  issues.positive('operation.slotWidth', sw)
  issues.nonNegative('strategy.breakthrough', st.breakthrough)
  issues.nonNegative('strategy.finishAllowance', st.finishAllowance)
  if (!(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
    })
  if (cutting.stepover > tool.diameter + EPSILON)
    issues.rule('invariant', 'cutting.stepover', 'atMost', 'stepover must be ≤ tool diameter', {
      stepover: cutting.stepover,
      max: tool.diameter,
    })
  if (!(Number.isInteger(op.tabs.count) && op.tabs.count >= 0))
    issues.rule(
      'invariant',
      'operation.tabs.count',
      'integer',
      'tabs.count must be an integer ≥ 0',
      {
        count: op.tabs.count,
      },
    )
  if (op.tabs.count > 0) {
    issues.positive('operation.tabs.width', op.tabs.width)
    if (!(op.tabs.thickness > 0 && op.tabs.thickness < T))
      issues.rule(
        'invariant',
        'operation.tabs.thickness',
        'range',
        'tabs.thickness must be > 0 and < stock thickness',
        {
          thickness: op.tabs.thickness,
        },
      )
  }
  if (tool.diameter > sw + TOOL_FIT_TOLERANCE)
    issues.rule('check', 'tool.diameter', 'toolTooLarge', 'the tool is wider than the slot', {
      diameter: tool.diameter,
      slotWidth: sw,
    })
  const m = inradius(shape)
  const outside = op.side === 'outside'
  if (!outside && R > m + TOOL_FIT_TOLERANCE)
    issues.rule('check', 'tool.diameter', 'toolTooLarge', 'the tool is wider than the opening', {
      diameter: tool.diameter,
      narrowest: 2 * m,
    })
  const ok = issues.result('generateProfile', input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())

  const covers = slotCoversOpening(op)
  const tabCount = covers ? 0 : op.tabs.count
  const bandsResult = tabBands(op, tabCount)
  if (bandsResult.isErr())
    return Err(
      bandsResult
        .unwrapErr()
        .withContext('generateProfile', { planOperationId: input.planOperationId }),
    )
  const bands = bandsResult.unwrap()
  const tabTop = -T + op.tabs.thickness
  const hits = (p: Vec2) => diskHitsBands(p, R, bands)
  const lift = (pieces: Seg3[]): Seg3[] =>
    bands.length === 0 ? pieces : liftOverTabs(pieces, hits, tabTop, Math.min(R / 4, 0.5))
  const liftZ = (p: Vec2, z: number) => (z < tabTop && bands.length > 0 && hits(p) ? tabTop : z)

  // Slot passes as distances from the shape into the slot, cut from the offcut/slug side to the
  // part side, so breakthrough frees the offcut with no pass beside it afterwards (a covering
  // inside slot: from the center outwards, as a pocket).
  const far = Math.max(R, sw - R)
  const first = Math.min(R + st.finishAllowance, covers ? m : far)
  const spacing = Math.min(
    cutting.stepover,
    !outside && shape.kind === 'rectangle' ? Math.SQRT2 * R : 2 * R,
  )
  const distances = covers
    ? ringOffsets(first, m, spacing)
    : rowPositions(first, Math.max(first, far), spacing).reverse()
  /** The ring at `d`; an inside slot's far ring goes round the slug (its offset by R). */
  const ringContour = (d: number): Contour | undefined => {
    if (outside) return offsetContour(shape, -d).into()
    if (!covers && Math.abs(d - far) <= EPSILON && sw - R > R + EPSILON)
      return offsetContour(shape, sw)
        .andThen((slug) => offsetContour(slug, -R))
        .into()
    return offsetContour(shape, d).into()
  }
  const cw = outside === (st.direction === 'climb')
  const ring = (d: number, s: number): Seg[] => {
    const rc = ringContour(d)
    return rc === undefined ? [] : ringSegs(shape, rc, c, s, cw)
  }
  /** Shape arc length nearest to a point. */
  const paramOf = (p: Vec2) => contourParam(shape, [p[0] - c[0], p[1] - c[1]])

  // start between tabs (evenly spaced, so half a spacing after the first one)
  const start = wallMiddle(shape) + (tabCount > 0 ? perimeter(shape) / (2 * tabCount) : 0)
  const retract = heights.retractHeight
  const bottom = -T - st.breakthrough
  const tan = Math.tan((st.rampAngle * Math.PI) / 180)
  const feed = cutting.feedRate
  const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z]
  const xy = (p: Vec3): Vec2 => [p[0], p[1]]

  const b = new MoveBuilder()
  /** Pieces in order, with vertical moves between them: up at feed, down at the plunge rate. */
  const emit = (pieces: readonly Seg3[]) => {
    for (const piece of pieces) {
      const pos = b.position!
      if (Math.abs(pos[2] - piece.z0) > EPSILON)
        b.line([pos[0], pos[1], piece.z0], piece.z0 > pos[2] ? feed : cutting.plungeRate)
      b.seg(piece, feed)
    }
  }
  const lineTo = (p: Vec2, z: number): Seg3[] => {
    const from = xy(b.position!)
    return [{ seg: { kind: 'line', from, to: p }, z0: z, z1: z }]
  }

  const finishing = first - R > EPSILON
  const zs = levels(0, bottom, cutting.stepdown)
  const pass = passSteps(steps, zs.length + (finishing ? 1 : 0))
  let previous = 0
  for (const [k, z] of zs.entries()) {
    const step = pass(k)
    if (step.isErr()) return Err(step.unwrapErr())
    b.pass('rough')
    const ring0 = ring(distances[0]!, start)
    const p0 = ring0.length > 0 ? segPoint(ring0[0]!, 0) : c
    if (b.position === undefined) b.rapid(at(p0, heights.clearanceHeight))
    b.rapid(at(p0, retract))
    if (ring0.length === 0) {
      // the ring collapsed to a point (tool ≈ opening): plunge straight down, as boring
      b.line(at(p0, liftZ(p0, z)), cutting.plungeRate)
    } else if (st.entry === 'ramp' && previous - z > EPSILON) {
      b.line(at(p0, liftZ(p0, previous)), cutting.plungeRate)
      const { walked, lap } = walkRing(ring0, (previous - z) / tan)
      emit(lift(slope(walked, previous, z)))
      emit(lift(flat(lap, z)))
    } else {
      b.line(at(p0, liftZ(p0, z)), cutting.plungeRate)
      emit(lift(flat(ring0, z)))
    }
    for (const d of distances.slice(1)) {
      const segs = ring(d, paramOf(xy(b.position!)))
      if (segs.length === 0) continue
      emit(lift(lineTo(segPoint(segs[0]!, 0), z)))
      emit(lift(flat(segs, z)))
    }
    b.rapid(at(xy(b.position!), retract))
    previous = z
  }

  // finishing: the part-side ring at full depth, lead-in/out from the part-side rough ring
  if (finishing) {
    const step = pass(zs.length)
    if (step.isErr()) return Err(step.unwrapErr())
    b.pass('finish')
    const wall = ring(R, start)
    const leadRing = ring(first, start)
    const lead = leadRing.length > 0 ? segPoint(leadRing[0]!, 0) : c
    b.rapid(at(lead, retract))
    b.line(at(lead, liftZ(lead, bottom)), cutting.plungeRate)
    if (wall.length > 0) emit(lift(lineTo(segPoint(wall[0]!, 0), bottom)))
    emit(lift(flat(wall, bottom)))
    emit(lift(lineTo(lead, bottom)))
    b.rapid(at(lead, retract))
  }
  b.rapid(at(xy(b.position!), heights.clearanceHeight))
  return Ok(toolpath(input, b.build()))
}
