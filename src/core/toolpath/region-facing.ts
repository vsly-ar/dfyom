/**
 * Facing of a region (hardening DF145): the facing's rows clipped to the tool-centre region, a
 * boundary pass along the inner sides, side or ramp entry.
 * Doc: docs/modes/design.md#facing-region-hardening-df145
 *
 * The tool-centre region C is the face grown by `overshoot + R` minus the material outside the
 * region grown by R: on a stock-edge (open) side the rows run off the stock as a whole facing's;
 * on an inner side the tool's edge stays on the boundary. C is cut down to where the tool reaches
 * the region (within `R + overshoot` of it), so no row runs wholly in air.
 */
import { EPSILON, type Vec2 } from '../geometry/model'
import { chainBounds, line, regionLoops, type Loop, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { shapeOutline } from '../geometry/outline'
import { flattenRegion } from '../geometry/prism'
import { Err, Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { commonIssues, cutLevels, cutTop, passSteps, toolpath } from './common'
import { rowPositions } from './facing'
import type { FacingInput, Toolpath } from './model'
import { MoveBuilder, segLength, segPoint, segReverse, type Seg } from './path'
import { elementSeg } from './region-rings'

/**
 * Ramp angle of a closed entry (degrees): a region facing whose row starts inside the stock ramps
 * down along the row (the WH-D facing around workholding uses the same angle).
 */
export const FACING_RAMP_ANGLE = 3
/** Links and row ends may graze C by this (mm), well under the 0.01 mm coverage tolerance. */
const SLACK = 1e-4
/** A row span shorter than this (mm) enters by a plunge: too short to ramp along. */
const MIN_RAMP_SPAN = 0.5

type Span = readonly [number, number]

const rect = (u0: number, v0: number, u1: number, v1: number): Region => {
  const p: Vec2[] = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ]
  return {
    pieces: [{ outer: { elements: p.map((a, i) => line(a, p[(i + 1) % 4]!)) }, holes: [] }],
  }
}

/** `steps.step()` before every level. */
export function generateRegionFacing(
  input: FacingInput,
  port: Region2dPort,
  steps: Steps = noSteps,
): AppResult<Toolpath> {
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
  const where = 'generateRegionFacing'
  const ok = issues.result(where, input.planOperationId)
  if (ok.isErr()) return Err(ok.unwrapErr())
  const centre = centreRegion(input, port)
  if (centre.isErr()) return Err(centre.unwrapErr())
  const c = centre.unwrap()
  if (c === undefined) {
    issues.rule('check', 'operation.region', 'noFit', 'the tool does not fit the region', {
      diameter: tool.diameter,
    })
    return Err(issues.result(where, input.planOperationId).unwrapErr())
  }
  const { region: C, own } = c

  // (u, v) = (along, across) the rows, as a whole facing's
  const xy = (u: number, v: number): Vec2 => (st.axis === 'x' ? [u, v] : [v, u])
  const vAxis = st.axis === 'x' ? 1 : 0
  const ownBox = chainBounds(own.pieces.flatMap((p) => p.outer.elements))!
  // rows over the tool centres above the face: an end on a stock edge is open (the outer row puts
  // the flat edge `overshoot` past the stock, as a whole facing's), else an inner side bounds it
  const onFace = port.intersect(C, rect(0, 0, stock.length, stock.width))
  if (onFace.isErr()) return Err(onFace.unwrapErr())
  const box =
    chainBounds(onFace.unwrap().pieces.flatMap((p) => p.outer.elements)) ??
    chainBounds(C.pieces.flatMap((p) => p.outer.elements))!
  const size = vAxis === 1 ? stock.width : stock.length
  const rows = rowPositions(
    box.min[vAxis] <= EPSILON ? ownBox.min[vAxis] - st.overshoot + flatRadius : box.min[vAxis],
    box.max[vAxis] >= size - EPSILON
      ? ownBox.max[vAxis] + st.overshoot - flatRadius
      : box.max[vAxis],
    Math.min(cutting.stepover, 2 * flatRadius),
  )
  const spans = rowSpans(C, rows, st.axis)
  const climbForward = st.axis === 'y'
  const forward = st.direction === 'climb' ? climbForward : !climbForward
  // a tool position whose disc clears the stock: entered by a plunge, linked at depth
  const offStock = (p: Vec2): 'u0' | 'u1' | 'v0' | 'v1' | undefined =>
    p[0] <= -R - EPSILON
      ? 'u0'
      : p[0] >= stock.length + R + EPSILON
        ? 'u1'
        : p[1] <= -R - EPSILON
          ? 'v0'
          : p[1] >= stock.width + R + EPSILON
            ? 'v1'
            : undefined
  // the cuts of a level in order: each row's spans in the row's direction; a span too short to
  // ramp along with both ends over the stock is left to the boundary pass, which runs over it
  const cuts: { v: number; from: number; to: number }[] = []
  let k = 0
  for (const [i, v] of rows.entries()) {
    const row = spans[i]!.filter(
      ([a, b]) =>
        b - a >= MIN_RAMP_SPAN ||
        offStock(xy(a, v)) !== undefined ||
        offStock(xy(b, v)) !== undefined,
    )
    if (row.length === 0) continue
    const fwd = st.pattern === 'oneWay' || k % 2 === 0 ? forward : !forward
    k++
    for (const [a, b] of fwd ? row : [...row].reverse())
      cuts.push({ v, from: fwd ? a : b, to: fwd ? b : a })
  }
  if (cuts.length === 0) {
    issues.rule('check', 'operation.region', 'noFit', 'the tool does not fit the region', {
      diameter: tool.diameter,
    })
    return Err(issues.result(where, input.planOperationId).unwrapErr())
  }
  const boundary = boundaryChains(C, stock, rows, st.axis, st.direction === 'climb')

  const slack = port.offset(C, -SLACK)
  if (slack.isErr()) return Err(slack.unwrapErr())
  const inside = (a: Vec2, b: Vec2): boolean => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      if (!port.contains(slack.unwrap(), [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]))
        return false
    }
    return true
  }

  const retract = heights.retractHeight
  const b = new MoveBuilder()
  const at = (p: Vec2, z: number): [number, number, number] => [p[0], p[1], z]
  const slope = Math.tan((FACING_RAMP_ANGLE * Math.PI) / 180)
  /** From above `from` down to `z` (the material at most at `top`), then to `from` at `z`. */
  const enter = (from: Vec2, along: Vec2, z: number, top: number) => {
    if (b.position === undefined) b.rapid(at(from, heights.clearanceHeight))
    b.rapid(at(from, retract))
    const span = Math.hypot(along[0] - from[0], along[1] - from[1])
    if (offStock(from) !== undefined || span < MIN_RAMP_SPAN || top - z <= EPSILON) {
      b.line(at(from, z), cutting.plungeRate)
      return
    }
    // a ramp along the row, back and forth when the row is short, then back to its start
    b.line(at(from, top), cutting.plungeRate)
    const lerp = (t: number): Vec2 => [
      from[0] + ((along[0] - from[0]) * t) / span,
      from[1] + ((along[1] - from[1]) * t) / span,
    ]
    let s = 0
    let h = top
    let out = true
    while (h > z + EPSILON) {
      const d = Math.min(out ? span - s : s, (h - z) / slope)
      s += out ? d : -d
      h = Math.max(z, h - d * slope)
      b.line(at(lerp(s), h), cutting.feedRate)
      out = !out
    }
    b.line(at(from, z), cutting.feedRate)
  }

  const zs = cutLevels(0, -op.depth, cutting.stepdown, input.material)
  const firstTop = cutTop(0, -op.depth, input.material)
  const pass = passSteps(steps, zs.length)
  for (const [lv, z] of zs.entries()) {
    const step = pass(lv)
    if (step.isErr()) return Err(step.unwrapErr())
    const top = lv === 0 ? firstTop : zs[lv - 1]!
    b.pass('rough')
    let last: Vec2 | undefined
    for (const cut of cuts) {
      const from = xy(cut.from, cut.v)
      const to = xy(cut.to, cut.v)
      const linked =
        last !== undefined &&
        st.pattern === 'zigzag' &&
        ((offStock(last) !== undefined && offStock(last) === offStock(from)) || inside(last, from))
      if (linked) b.line(at(from, z), cutting.feedRate)
      else {
        if (last !== undefined) b.rapid(at(last, retract))
        enter(from, to, z, top)
      }
      b.line(at(to, z), cutting.feedRate)
      last = to
    }
    // the inner sides: no cusps between the rows' ends on a slanted or curved boundary
    for (const chain of boundary) {
      const start = segPoint(chain[0]!, 0)
      b.rapid(at(last!, retract))
      b.rapid(at(start, retract))
      b.line(at(start, z), cutting.plungeRate)
      for (const s of chain) b.seg({ seg: s, z0: z, z1: z }, cutting.feedRate)
      last = segPoint(chain.at(-1)!, 1)
    }
    b.rapid(at(last!, retract))
  }
  const end = b.position!
  b.rapid([end[0], end[1], heights.clearanceHeight])
  return Ok(toolpath(input, b.build()))
}

/**
 * The tool-centre region (face frame) and the region within the face; undefined when the tool
 * fits nowhere or the region misses the face.
 */
export function centreRegion(
  input: Pick<FacingInput, 'tool' | 'stock' | 'operation' | 'strategy'>,
  port: Region2dPort,
): AppResult<{ region: Region; own: Region } | undefined> {
  const { tool, stock, operation: op, strategy: st } = input
  const R = tool.diameter / 2
  const face = rect(0, 0, stock.length, stock.width)
  const outline = op.region === undefined ? face : regionOf(op.region)
  const own = port.intersect(outline, face)
  if (own.isErr()) return Err(own.unwrapErr())
  if (own.unwrap().pieces.length === 0) return Ok(undefined)
  const forbidden = port.difference(face, own.unwrap())
  if (forbidden.isErr()) return Err(forbidden.unwrapErr())
  const g = st.overshoot + R
  const big = rect(-g, -g, stock.length + g, stock.width + g)
  const grown =
    forbidden.unwrap().pieces.length === 0
      ? Ok(forbidden.unwrap())
      : port.offset(forbidden.unwrap(), -R)
  if (grown.isErr()) return Err(grown.unwrapErr())
  const free = port.difference(big, grown.unwrap())
  if (free.isErr()) return Err(free.unwrapErr())
  const reach = port.offset(own.unwrap(), -g)
  if (reach.isErr()) return Err(reach.unwrapErr())
  const c = port.intersect(free.unwrap(), reach.unwrap())
  if (c.isErr()) return Err(c.unwrapErr())
  return Ok(c.unwrap().pieces.length === 0 ? undefined : { region: c.unwrap(), own: own.unwrap() })
}

function regionOf(shape: NonNullable<FacingInput['operation']['region']>): Region {
  const o = shapeOutline(shape)
  return o.kind === 'region' ? o.region : { pieces: [] }
}

/**
 * Per row, C's spans along it (sorted, `u` of the row frame): even-odd crossings of the row with
 * C flattened inside itself (chords within `SLACK` of the arcs).
 */
function rowSpans(C: Region, rows: readonly number[], axis: 'x' | 'y'): Span[][] {
  const [a, b] = axis === 'x' ? [0, 1] : [1, 0]
  const rings = flattenRegion(C, 'shrink', SLACK).map((r) => r.points)
  const lo = rows[0]!
  const hi = rows.at(-1)!
  return rows.map((row0) => {
    // the outer rows may lie on C's edge: read just inside it
    const v = row0 === hi && hi > lo ? hi - 1e-7 : row0 === lo ? lo + 1e-7 : row0
    const us: number[] = []
    for (const pts of rings)
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const p = pts[i]!
        const q = pts[j]!
        if (p[b]! > v !== q[b]! > v)
          us.push(p[a]! + ((v - p[b]!) * (q[a]! - p[a]!)) / (q[b]! - p[b]!))
      }
    us.sort((x, y) => x - y)
    const row: Span[] = []
    for (let i = 0; i + 1 < us.length; i += 2) {
      const prev = row.at(-1)
      // spans meeting at a point (C pinched there) run on as one
      if (prev !== undefined && us[i]! - prev[1] <= SLACK)
        row[row.length - 1] = [prev[0], us[i + 1]!]
      else if (us[i + 1]! - us[i]! > EPSILON) row.push([us[i]!, us[i + 1]!])
    }
    return row
  })
}

/**
 * The inner sides of C as chains of `Seg`s: its boundary elements whose middle lies on the stock
 * face, less straight pieces along a row (the row already runs there). Climb keeps the material on
 * the right: C's loops in their own direction (outer counter-clockwise, holes clockwise).
 */
export function boundaryChains(
  C: Region,
  stock: { readonly length: number; readonly width: number },
  rows: readonly number[],
  axis: 'x' | 'y',
  climb: boolean,
): Seg[][] {
  const out: Seg[][] = []
  const onRow = (s: Seg): boolean => {
    if (s.kind !== 'line') return false
    const a = axis === 'x' ? 1 : 0
    return (
      Math.abs(s.from[a] - s.to[a]) <= EPSILON &&
      segLength(s) >= MIN_RAMP_SPAN &&
      rows.some((v) => Math.abs(v - s.from[a]) <= 1e-6)
    )
  }
  const inner = (s: Seg): boolean => {
    const m = segPoint(s, 0.5)
    return (
      m[0] > EPSILON &&
      m[0] < stock.length - EPSILON &&
      m[1] > EPSILON &&
      m[1] < stock.width - EPSILON &&
      !onRow(s)
    )
  }
  for (const loop of regionLoops(C)) {
    const segs = loopSegs(loop)
    const keep = segs.map(inner)
    if (keep.every((x) => x)) {
      out.push(segs)
      continue
    }
    // start right after a dropped piece, so each chain is whole
    const first = keep.findIndex((x) => !x)
    let chain: Seg[] = []
    for (let i = 1; i <= segs.length; i++) {
      const j = (first + i) % segs.length
      if (keep[j]) chain.push(segs[j]!)
      else if (chain.length > 0) {
        out.push(chain)
        chain = []
      }
    }
    if (chain.length > 0) out.push(chain)
  }
  const kept = out.filter((ch) => ch.reduce((n, s) => n + segLength(s), 0) > 1e-3)
  return climb ? kept : kept.map((ch) => [...ch].reverse().map(segReverse))
}

function loopSegs(l: Loop): Seg[] {
  const out: Seg[] = []
  for (const e of l.elements) {
    const s = elementSeg(e)
    if (s !== undefined) out.push(s)
  }
  return out
}
