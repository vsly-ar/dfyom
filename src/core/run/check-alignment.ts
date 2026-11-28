/**
 * Check alignment (v0.5 RV6, Q226): whether the stock on the table is square to the machine's axes.
 * The pointer patterns: stops on the setup's stock outline offset outward by a gap (corners, both
 * ends of each edge, a perimeter trace, or corners and edges), walked counter-clockwise from the
 * corner nearest the plan's zero, and the jogs from one stop to the next (along the offset
 * outline at the sighting height, or the safe order of Go to from anywhere else: never lower Z
 * for an X/Y move). Measure: two edge probes along one edge give its angle and how far to nudge
 * which end. Nothing here rotates or writes anything (Q65: the stock is moved, not the program).
 * Pure. Doc: docs/modes/alignment.md#check-alignment-rv6
 */
import { fail, Ok, type AppResult } from '../../shared/result'
import { travelViolation, type Envelope } from './grbl/envelope'
import { goToMoves, machineTopZ, GOTO_EPS_MM, type GoToStep, type Vec3 } from './goto'
import type { PlanStock, Side } from './xy-zero'

export type CheckPattern = 'corners' | 'edges' | 'perimeter' | 'both'

export const CHECK_DEFAULTS = {
  /** The tool's axis this far (mm) outside the stock's edges. */
  gap: 2,
  /** The tool tip this far (mm) above the stock top (negative: beside the edge, below the top). */
  height: 2,
  /** Moves along the outline (mm/min, Q226). */
  traceFeed: 500,
  /** The edge pattern's stops this far (mm) in from each corner, at most a quarter of the edge. */
  edgeInset: 10,
  /** Measure probes this far (mm) in from each end of the edge, at most a fifth of it. */
  measureInset: 15,
  /** Measure starts this far (mm) inside the plan's edge, over the top (half the probe's reach). */
  measureInside: 5,
  /** Below the top the tool's side must clear the edge by this much (mm) beyond the gap's radius. */
  sideClearance: 0.5,
} as const

/** Within this (mm) the tool is at a stop (X/Y). */
export const AT_STOP_MM = 0.01

/** A place the pointer stops: a stock corner, or one end of an edge. */
export type CheckStop =
  | {
      readonly kind: 'corner'
      readonly corner: readonly [Side, Side]
      /** Work coordinates (X, Y), mm. */
      readonly at: readonly [number, number]
      /** Where on the offset outline (mm counter-clockwise from its front-left corner). */
      readonly s: number
    }
  | {
      readonly kind: 'edge'
      /** The edge: its axis (`y`: front Y− or back Y+, `x`: left X− or right X+) and side. */
      readonly edge: { readonly axis: 'x' | 'y'; readonly side: Side }
      /** The end: toward the X− (−1) or X+ (+1) corner for a Y edge, Y− or Y+ for an X edge. */
      readonly end: Side
      readonly at: readonly [number, number]
      readonly s: number
    }

/** A stable key of a stop ("corner:-1,-1", "edge:y-1:1"). */
export function stopKey(stop: CheckStop): string {
  return stop.kind === 'corner'
    ? `corner:${stop.corner[0]},${stop.corner[1]}`
    : `edge:${stop.edge.axis}${stop.edge.side}:${stop.end}`
}

/** The stock outline offset outward by `gap`, in work coordinates (mm). */
interface Rect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

function rectOf(stock: PlanStock, gap: number): Rect {
  return {
    x0: -stock.zero[0] - gap,
    y0: -stock.zero[1] - gap,
    x1: stock.length - stock.zero[0] + gap,
    y1: stock.width - stock.zero[1] + gap,
  }
}

const perimeter = (r: Rect) => 2 * (r.x1 - r.x0 + (r.y1 - r.y0))

/** The rectangle's corners' positions along it: front-left, front-right, back-right, back-left. */
function cornerParams(r: Rect): number[] {
  const l = r.x1 - r.x0
  const w = r.y1 - r.y0
  return [0, l, l + w, 2 * l + w]
}

/** The point `s` mm counter-clockwise from the front-left corner of the rectangle. */
function pointAt(r: Rect, s: number): readonly [number, number] {
  const l = r.x1 - r.x0
  const w = r.y1 - r.y0
  const p = perimeter(r)
  const t = ((s % p) + p) % p
  if (t < l) return [r.x0 + t, r.y0]
  if (t < l + w) return [r.x1, r.y0 + (t - l)]
  if (t < 2 * l + w) return [r.x1 - (t - l - w), r.y1]
  return [r.x0, r.y1 - (t - 2 * l - w)]
}

/** The corners in counter-clockwise order from the front-left one, with their sides. */
const CORNERS: readonly (readonly [Side, Side])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/** The corner nearest the plan's zero: where the walk starts. */
export function startCorner(stock: PlanStock): readonly [Side, Side] {
  return [stock.zero[0] > stock.length / 2 ? 1 : -1, stock.zero[1] > stock.width / 2 ? 1 : -1]
}

/**
 * The stops of a pattern in walking order (counter-clockwise seen from above), starting at the
 * corner nearest the plan's zero (edges: the first edge end after it). Corners sit `gap` outside
 * both edges; an edge's ends sit `gap` outside that edge, `edgeInset` in from its corners.
 */
export function checkStops(
  stock: PlanStock,
  pattern: CheckPattern,
  gap: number,
  edgeInset: number = CHECK_DEFAULTS.edgeInset,
): CheckStop[] {
  const r = rectOf(stock, gap)
  const cs = cornerParams(r)
  const corners: CheckStop[] = CORNERS.map((corner, i) => ({
    kind: 'corner',
    corner,
    at: pointAt(r, cs[i]!),
    s: cs[i]!,
  }))
  const ix = Math.min(edgeInset, stock.length / 4)
  const iy = Math.min(edgeInset, stock.width / 4)
  const L = stock.length
  const W = stock.width
  // each edge walked counter-clockwise from its first corner: [edge, its start param, along, inset]
  const sides: readonly [{ axis: 'x' | 'y'; side: Side }, number, number, number, Side][] = [
    // front: X− → X+; right: Y− → Y+; back: X+ → X−; left: Y+ → Y−
    [{ axis: 'y', side: -1 }, cs[0]!, L, ix, -1],
    [{ axis: 'x', side: 1 }, cs[1]!, W, iy, -1],
    [{ axis: 'y', side: 1 }, cs[2]!, L, ix, 1],
    [{ axis: 'x', side: -1 }, cs[3]!, W, iy, 1],
  ]
  const edges: CheckStop[] = sides.flatMap(([edge, s0, len, inset, firstEnd]) =>
    [
      [gap + inset, firstEnd],
      [gap + len - inset, -firstEnd as Side],
    ].map(([d, end]) => ({
      kind: 'edge' as const,
      edge,
      end: end as Side,
      at: pointAt(r, s0 + (d as number)),
      s: s0 + (d as number),
    })),
  )
  const all =
    pattern === 'edges'
      ? edges
      : pattern === 'both'
        ? [...corners, ...edges].sort((a, b) => a.s - b.s)
        : corners
  const sc = startCorner(stock)
  const s0 = cs[CORNERS.findIndex((c) => c[0] === sc[0] && c[1] === sc[1])]!
  const i = all.findIndex((st) => st.s >= s0 - 1e-9)
  const k = i < 0 ? 0 : i
  return [...all.slice(k), ...all.slice(0, k)]
}

/**
 * The work-coordinate points from stop `a` to stop `b` along the offset outline in direction
 * `dir` (+1 counter-clockwise), the outline's corners between them included; `b` last.
 */
export function legPoints(
  stock: PlanStock,
  gap: number,
  a: CheckStop,
  b: CheckStop,
  dir: 1 | -1,
): (readonly [number, number])[] {
  const r = rectOf(stock, gap)
  const p = perimeter(r)
  const mod = (v: number) => ((v % p) + p) % p
  const d = dir > 0 ? mod(b.s - a.s) : mod(a.s - b.s)
  if (d < 1e-9) return []
  const between = cornerParams(r)
    .map((c) => ({ c, off: dir > 0 ? mod(c - a.s) : mod(a.s - c) }))
    .filter((x) => x.off > 1e-9 && x.off < d - 1e-9)
    .sort((x, y) => x.off - y.off)
    .map((x) => pointAt(r, x.c))
  return [...between, b.at]
}

/** The sighting height (machine Z, mm): the stock top of the current work zero plus `height`. */
export function sightZ(p: {
  readonly wcoZ: number
  readonly zeroLevel?: number | undefined
  readonly height: number
  readonly envelope?: Pick<Envelope, 'travel' | 'pullOff'> | undefined
}): number {
  return Math.min(p.wcoZ - (p.zeroLevel ?? 0) + p.height, machineTopZ(p.envelope))
}

/**
 * Why a pointer height and gap may not be used: below the top the tool's side must clear the
 * edge (gap ≥ radius + 0.5 mm), and never below the stock's bottom.
 */
export function pointerProblem(p: {
  readonly height: number
  readonly gap: number
  readonly toolDiameter: number
  readonly thickness: number
}): 'belowBottom' | 'sideTouches' | 'negativeGap' | undefined {
  if (p.gap < 0) return 'negativeGap'
  if (p.height <= -p.thickness) return 'belowBottom'
  if (p.height < 0 && p.gap < p.toolDiameter / 2 + CHECK_DEFAULTS.sideClearance)
    return 'sideTouches'
  return undefined
}

/** One jog of the pointer: a Go to step with the feed it runs at (the trace's or the jog's). */
export interface CheckStep extends GoToStep {
  readonly feed: 'trace' | 'jog'
}

export interface CheckMoveInput {
  /** The machine position (MPos), mm. */
  readonly from: Vec3
  /** MPos − WPos of the last status, mm. */
  readonly wco: Vec3
  /** The Z reference surface's level (DF69), mm; the stock top is WCO Z − it. */
  readonly zeroLevel?: number | undefined
  readonly stock: PlanStock
  readonly gap: number
  readonly height: number
  /** The safe height (machine Z, `goToSafeZ`) for a move that does not start at a stop. */
  readonly safeZ: number
  /** The stop the walk was at; the move runs along the outline when the tool is still there. */
  readonly fromStop?: CheckStop | undefined
  readonly to: CheckStop
  /** +1 counter-clockwise (Next, Continue), −1 (Previous). */
  readonly dir: 1 | -1
  readonly envelope?: Pick<Envelope, 'travel' | 'pullOff'> | undefined
}

/** A stop's machine position at the sighting height. */
export function stopMachine(
  stop: CheckStop,
  wco: Vec3,
  z: number,
): readonly [number, number, number] {
  return [stop.at[0] + wco[0], stop.at[1] + wco[1], z]
}

/**
 * The jogs to the stop `to`. From the stop the walk is at (the tool within 0.01 mm of it in X/Y):
 * Z up to the sighting height when lower, then along the offset outline (its corners included)
 * at the trace feed, then Z down to the sighting height when higher (Z is never lowered before an
 * X/Y move). From anywhere else, Go to's safe order (`goToMoves`): Z up to the safe height, X/Y,
 * down to the sighting height. Every end is checked against the travel (`run.travel`).
 */
export function checkMoves(p: CheckMoveInput): AppResult<CheckStep[]> {
  const z0 = sightZ({
    wcoZ: p.wco[2],
    zeroLevel: p.zeroLevel,
    height: p.height,
    envelope: p.envelope,
  })
  const target = stopMachine(p.to, p.wco, z0)
  const atFrom =
    p.fromStop !== undefined &&
    Math.abs(p.from[0] - (p.fromStop.at[0] + p.wco[0])) <= AT_STOP_MM &&
    Math.abs(p.from[1] - (p.fromStop.at[1] + p.wco[1])) <= AT_STOP_MM
  if (!atFrom) {
    const r = goToMoves({
      from: p.from,
      wco: p.wco,
      target,
      frame: 'machine',
      mode: 'absolute',
      safeZ: p.safeZ,
      liftToTop: false,
      envelope: p.envelope,
    })
    return r.map((steps) => steps.map((s) => ({ ...s, feed: 'jog' as const })))
  }
  const steps: CheckStep[] = []
  let z = p.from[2]
  if (z < z0 - GOTO_EPS_MM) {
    z = z0
    steps.push({ to: [p.from[0], p.from[1], z], axis: 'z', feed: 'jog' })
  }
  for (const [x, y] of legPoints(p.stock, p.gap, p.fromStop!, p.to, p.dir))
    steps.push({ to: [x + p.wco[0], y + p.wco[1], z], axis: 'xy', feed: 'trace' })
  if (z > z0 + GOTO_EPS_MM) steps.push({ to: target, axis: 'z', feed: 'jog' })
  if (p.envelope !== undefined) {
    for (const [i, s] of steps.entries()) {
      const v = travelViolation(p.envelope.travel, s.to)
      if (v !== undefined)
        return fail(
          'run.travel',
          `${v.axis.toUpperCase()} would leave the travel: the pointer would reach ${v.target.toFixed(3)} mm, the travel is ${v.min.toFixed(3)} to ${v.max.toFixed(3)} mm`,
          { where: 'checkMoves', data: { ...v, step: i } },
        )
    }
  }
  return Ok(steps)
}

/** The stock edge Measure probes: `y` the front (−1) or back (+1), `x` the left or right. */
export interface MeasureEdge {
  readonly axis: 'x' | 'y'
  readonly side: Side
}

/**
 * Where Measure starts its two edge probes (work coordinates X, Y, mm): over the top,
 * `measureInside` in from the plan's edge, `measureInset` (at most a fifth of the edge) in from
 * each end; the end with the lower coordinate along the edge first.
 */
export function measureStarts(
  stock: PlanStock,
  edge: MeasureEdge,
): readonly [readonly [number, number], readonly [number, number]] {
  const alongLen = edge.axis === 'y' ? stock.length : stock.width
  const inset = Math.min(CHECK_DEFAULTS.measureInset, alongLen / 5)
  const across = edge.axis === 'y' ? stock.width : stock.length
  const inside = Math.min(CHECK_DEFAULTS.measureInside, across / 4)
  const ai = edge.axis === 'y' ? 0 : 1
  const ei = 1 - ai
  const edgeAt = (edge.side < 0 ? 0 : across) - stock.zero[ei]! - edge.side * inside
  const pt = (along: number): readonly [number, number] => {
    const v = along - stock.zero[ai]!
    return ai === 0 ? [v, edgeAt] : [edgeAt, v]
  }
  return [pt(inset), pt(alongLen - inset)]
}

/** One probed point on the edge: where along it (MPos) and the edge's position there (MPos). */
export interface EdgePoint {
  readonly along: number
  readonly value: number
  /** ± mm (the probe's reading). */
  readonly uncertainty: number
}

export interface EdgeAngle {
  /** The stock's turn, degrees counter-clockwise seen from above (+Z). */
  readonly angle: number
  /** ± degrees, from the two readings' uncertainties over the points' spacing. */
  readonly uncertainty: number
  /** The corner to keep where it is: the edge's end nearest the plan's zero. */
  readonly keep: readonly [Side, Side]
  /** The corner to move. */
  readonly move: readonly [Side, Side]
  /** How far (mm, ≥ 0) to move it, across the edge, so the edge is parallel to the axis. */
  readonly nudge: number
  /** Which way: along `axis` toward `sign`. */
  readonly toward: { readonly axis: 'x' | 'y'; readonly sign: Side }
}

/**
 * The edge's angle from two probed points and the nudge that squares it: the far end moves by the
 * edge's length × the slope, across the edge, while the end nearest the plan's zero stays (the
 * zero is set there and is probed again after the nudge). A Y edge's slope is ΔY/ΔX (counter-
 * clockwise positive); an X edge's is ΔX/ΔY, whose turn is the opposite sign.
 */
export function edgeAngle(
  stock: PlanStock,
  edge: MeasureEdge,
  a: EdgePoint,
  b: EdgePoint,
): EdgeAngle {
  const span = b.along - a.along
  const slope = (b.value - a.value) / span
  const rad = edge.axis === 'y' ? Math.atan(slope) : Math.atan(-slope)
  const u = Math.hypot(a.uncertainty, b.uncertainty) / Math.abs(span)
  const alongLen = edge.axis === 'y' ? stock.length : stock.width
  const ai = edge.axis === 'y' ? 0 : 1
  const pivot: Side = stock.zero[ai]! > alongLen / 2 ? 1 : -1
  const far = -pivot as Side
  const corner = (end: Side): readonly [Side, Side] =>
    edge.axis === 'y' ? [end, edge.side] : [edge.side, end]
  // the far end sits slope × length off the pivot's line parallel to the axis
  const off = slope * alongLen * (far > 0 ? 1 : -1)
  return {
    angle: (rad * 180) / Math.PI,
    uncertainty: (u * 180) / Math.PI,
    keep: corner(pivot),
    move: corner(far),
    nudge: Math.abs(off),
    toward: { axis: edge.axis, sign: off > 0 ? -1 : 1 },
  }
}
