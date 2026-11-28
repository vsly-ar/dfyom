/**
 * Chamfer (v0.4 T1): one circular chamfer per input, plunged at the centre (DC ≥ D) or
 * contoured on one ring at the chamfer depth (the fit rule makes the cutting edge cover the
 * slant, so one ring always cuts it); stepped (F7): terraces by a flat end mill.
 * Doc: docs/modes/plan-v0.4.md#chamfer-toolpath, docs/modes/plan-v0.4.md#stepped-chamfer-f7
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  CHAMFER_ANGLE_TOLERANCE,
  chamferDepth,
  chamferTerraces,
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

/** Most terraces of a stepped chamfer (a guard; the design's 0.1 mm minimum keeps far below). */
export const MAX_TERRACES = 1000

/** One chamfer is one step (after the input checks), as one hole of a drilling. */
export function generateChamfer(input: ChamferInput, steps: Steps = noSteps): AppResult<Toolpath> {
  if (input.strategy.entry === 'stepped' || input.operation.stepdown !== undefined)
    return generateSteppedChamfer(input, steps)
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
  // DF135 C4 follow-up: a recut chamfer's ring goes down to its as-cut cone's depth in the air
  const sweep = st.direction === 'climb' ? 2 * Math.PI : -2 * Math.PI
  const start: Vec2 = [c[0], c[1] - r]
  const ring: Seg = { kind: 'arc', center: c, radius: r, start: -Math.PI / 2, sweep }
  const z0 = Math.max(tipZ, asCutLevel(op, input.material?.top, tool.angle))
  b.rapid(at(start, heights.clearanceHeight))
  b.rapid(at(start, retract))
  b.line(at(start, z0), cutting.plungeRate)
  if (z0 > tipZ + 1e-9) rampRing(b, ring, z0, tipZ, input)
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

/**
 * How deep (tip Z) a contour ring's tool lies wholly in a recut chamfer's as-cut cone (DF135 C4
 * follow-up): `top`, the as-cut cone's depth below `onZ` (same edge and angle), no deeper than
 * where the tool's cone reaches the old width at the face (a tool angle within the angle tolerance
 * of the chamfer's). `onZ` without one. The ring's axis is dt/2 inside the edge, so this holds for
 * any tip Ø.
 * Doc: docs/modes/cut-state.md#edge-operations-engravings-and-through-holes-c4-follow-up
 */
export function asCutLevel(
  op: { readonly onZ: number; readonly angle: number },
  top: number | undefined,
  toolAngle: number | undefined,
): number {
  if (top === undefined || !(top < op.onZ)) return op.onZ
  const d = op.onZ - top
  const width = d * Math.tan((op.angle * Math.PI) / 360)
  const reach = Math.tan(((toolAngle ?? op.angle) * Math.PI) / 360)
  return op.onZ - Math.min(d, width / reach)
}

/**
 * Down along `ring` from `z0` to `z1` in whole turns, each at most `rampAngle` and never
 * descending faster than the plunge rate (as helical boring); below r = 0.1 mm a straight plunge.
 */
function rampRing(
  b: MoveBuilder,
  ring: Extract<Seg, { kind: 'arc' }>,
  z0: number,
  z1: number,
  input: Pick<ChamferInput, 'cutting' | 'strategy'>,
): void {
  const { cutting, strategy: st } = input
  const r = ring.radius
  // every ring starts at −90°
  const start: Vec2 = [ring.center[0], ring.center[1] - r]
  if (r < HELIX_MIN_RADIUS) {
    b.line([start[0], start[1], z1], cutting.plungeRate)
    return
  }
  const drop = z0 - z1
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
  for (const s of slope(Array<Seg>(turns).fill(ring), z0, z1)) b.seg(s, feed)
}

/**
 * The ring radii (tool axis) of one terrace whose wall is at `wall`: the outermost at wall − R,
 * inner ones at most DC / 2 apart (equal) down to d / 2 + 0.4 · DC, so the innermost reaches
 * 0.1 · DC into the hole (plan-v0.4.md § Stepped chamfer). Inner to outer.
 */
export function terraceRings(wall: number, edgeDiameter: number, toolDiameter: number): number[] {
  const outer = wall - toolDiameter / 2
  const inner = edgeDiameter / 2 + 0.4 * toolDiameter
  if (outer <= inner + 1e-9) return [outer]
  const n = 1 + Math.ceil((outer - inner) / (toolDiameter / 2) - 1e-9)
  const w = (outer - inner) / (n - 1)
  return Array.from({ length: n }, (_, j) => inner + j * w)
}

/**
 * Stepped (F7): a flat end mill cuts the terraces top to bottom; per terrace a ramp along its
 * innermost ring from the level above, a full ring, then each outer ring after a radial feed
 * outward; back in at depth to the next terrace; at the end to the centre (the hole) and out.
 * Every top step corner lies on the cone (plan-v0.4.md § Stepped chamfer).
 */
function generateSteppedChamfer(input: ChamferInput, steps: Steps): AppResult<Toolpath> {
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
  if (st.entry !== 'stepped' || op.stepdown === undefined)
    issues.rule('invariant', 'strategy.entry', 'stepped', 'a stepped chamfer is cut in terraces', {
      entry: st.entry,
    })
  if (!(st.rampAngle >= 0.5 && st.rampAngle <= 30))
    issues.rule('invariant', 'strategy.rampAngle', 'range', 'rampAngle must be 0.5°–30°', {
      rampAngle: st.rampAngle,
    })
  const terraces =
    op.stepdown !== undefined && op.diameter > op.edgeDiameter
      ? chamferTerraces(op, op.stepdown)
      : undefined
  if (op.stepdown !== undefined && (terraces === undefined || terraces.count > MAX_TERRACES))
    issues.rule('invariant', 'operation.stepdown', 'range', 'stepdown gives too many terraces', {
      stepdown: op.stepdown,
      max: MAX_TERRACES,
    })
  if (tool.type !== 'flatEndMill')
    issues.rule('check', 'tool.type', 'toolType', 'a stepped chamfer needs a flat end mill')
  else if (tool.diameter >= op.edgeDiameter - TOOL_FIT_TOLERANCE)
    issues.rule('check', 'tool.diameter', 'diameter', 'the tool must be smaller than the edge Ø', {
      diameter: tool.diameter,
      edgeDiameter: op.edgeDiameter,
    })
  const ok = issues.result('generateChamfer', input.planOperationId).andThen(() => steps.step())
  if (ok.isErr()) return Err(ok.unwrapErr())

  const c = op.center
  const at = (r: number, z: number): Vec3 => [c[0], c[1] - r, z]
  const sweep = st.direction === 'climb' ? 2 * Math.PI : -2 * Math.PI
  const ring = (r: number): Extract<Seg, { kind: 'arc' }> => ({
    kind: 'arc',
    center: c,
    radius: r,
    start: -Math.PI / 2,
    sweep,
  })
  const { height, radii } = terraces!
  const rings = radii.map((wall) => terraceRings(wall, op.edgeDiameter, tool.diameter))
  const b = new MoveBuilder()
  b.pass('rough')
  const first = rings[0]![0]!
  b.rapid(at(first, heights.clearanceHeight))
  b.rapid(at(first, op.onZ + heights.retractHeight))
  b.line(at(first, op.onZ), cutting.plungeRate)
  let z = op.onZ
  rings.forEach((rs, k) => {
    const floor = op.onZ - (k + 1) * height
    // back in at the level above (cleared: the terrace above is wider), then down the ring
    if (k > 0) b.line(at(rs[0]!, z), cutting.feedRate)
    rampRing(b, ring(rs[0]!), z, floor, input)
    rs.forEach((r, j) => {
      if (j > 0) b.line(at(r, floor), cutting.feedRate)
      if (r >= HELIX_MIN_RADIUS) for (const s of flat([ring(r)], floor)) b.seg(s, cutting.feedRate)
    })
    z = floor
  })
  b.line([c[0], c[1], z], cutting.feedRate)
  b.rapid([c[0], c[1], heights.clearanceHeight])
  return Ok(toolpath(input, b.build()))
}
