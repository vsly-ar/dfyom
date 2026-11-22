/**
 * The clone path (v0.4 F5): path rows walked from a moving reference point, stable instance
 * numbers, skips. Pure numbers in the Clones face frame (mm, degrees); the feature model
 * (clones.ts) converts its quantities. Ported from cnc-code's `clonePath` / `arcSteps` /
 * `keepSkips` (src/core/composer/clones.ts, the user's earlier project) with v0.4's changes:
 * `[u, v]` instead of `x, y`, stable numbering (a skipped or duplicate position keeps its
 * number), no cut at a maximum (the limit is a feature invariant). The `along` row (F6) is new:
 * positions by arc length along a named shape's chain (cnc-code has no such row).
 * Doc: docs/modes/features.md#properties, docs/modes/design-v0.4.md#implementation-f5
 */

import { chainLength, chainPointAt } from '../../geometry/2d/measure'
import type { Element } from '../../geometry/2d/model'

/** A point or a step in the face frame, mm. */
export interface UV {
  readonly u: number
  readonly v: number
}

/** Fields every row has: its skipped points (0-based, numbering order), sorted and unique. */
interface RowBase {
  readonly skip?: readonly number[]
}

/** Columns × rows from the reference point (its first cell); cells numbered row by row, walked in zigzag. */
export interface GridRow extends RowBase {
  readonly kind: 'grid'
  readonly cols: number
  readonly rows: number
  /** Column to column, mm, not 0; negative grows towards −u. */
  readonly du: number
  /** Row to row, mm, not 0. */
  readonly dv: number
}
/** `count` positions, each a fixed step from the one before. */
export interface OffsetRow extends RowBase {
  readonly kind: 'offset'
  readonly count: number
  readonly du: number
  readonly dv: number
}
/** `count` positions along a direction (degrees from +u, counter-clockwise), `distance` apart. */
export interface PolarRow extends RowBase {
  readonly kind: 'polar'
  readonly count: number
  readonly angle: number
  readonly distance: number
}
/**
 * Positions round a circle whose centre is `radius` from the reference point in direction
 * `angle`; every `step` degrees for `arc` degrees (±360, positive counter-clockwise). Not a whole
 * number of steps: it stops at the last whole step. A full circle never repeats its start.
 */
export interface ArcRow extends RowBase {
  readonly kind: 'arc'
  readonly radius: number
  readonly angle: number
  readonly arc: number
  readonly step: number
}
/** One position at absolute `[u, v]` of the reference point (a jump). */
export interface PointRow extends RowBase {
  readonly kind: 'point'
  readonly u: number
  readonly v: number
}
/** A named shape's chain in its shape frame (mm): elements in order, closed or open. */
export interface AlongChain {
  readonly elements: readonly Element[]
  readonly closed: boolean
}
/**
 * Positions along `chain`, laid with its start point on the reference point and its shape frame
 * on the face frame (orientation kept), at arc lengths `start` + k · step from that start point:
 * `spacing` apart (as many as fit), or `count` spread evenly (an open path from `start` to its
 * end, a closed loop once round). A closed loop goes once round from `start`, wrapping past its
 * end. A position on the reference point itself (arc length 0) is the row's start (`closes`).
 * Exactly one of `spacing` and `count`; no chain (an unknown shape) gives no positions.
 */
export interface AlongRow extends RowBase {
  readonly kind: 'along'
  readonly chain: AlongChain | undefined
  readonly start: number
  readonly spacing?: number
  readonly count?: number
}
/** One path row. */
export type PathRow = GridRow | OffsetRow | PolarRow | ArcRow | PointRow | AlongRow

/**
 * What became of one point: a clone; skipped (in the row's `skip`); back on the row's start (a
 * full circle's last point, an `along` position at arc length 0: `closes`, no number, no clone);
 * or a duplicate of an earlier instance.
 */
export type PathPointKind = 'clone' | 'skipped' | 'closes' | 'duplicate'

export interface PathPoint {
  /** The reference point's position, rounded to the G-code's resolution. */
  readonly at: UV
  /** `at` minus the origin (what an instance is translated by), rounded likewise. */
  readonly offset: UV
  readonly kind: PathPointKind
  /** Stable instance number (2…); absent on `closes`. */
  readonly number?: number
}

export interface PathRowResult {
  readonly kind: PathRow['kind']
  /** The reference point the row starts from. */
  readonly start: UV
  /** Its points in numbering order (a grid row by row). */
  readonly points: readonly PathPoint[]
  /** Where the reference point moves: the row's last point (a grid's zigzag-last cell). */
  readonly end: UV
  /**
   * What the clone path draws for a straight row: from `start` through its points in number order
   * (a grid row by row), then on to `end` when that is another point (a grid's zigzag-last cell).
   */
  readonly line: readonly UV[]
  /**
   * What the clone path draws for the row where it is not straight (v0.4 U3): an arc row's arc
   * from `start` through its sweep, an `along` row's shape chain from `start` to its last
   * station, sampled to `CURVE_STEP_DEG` / `CURVE_SAMPLES`; absent: draw `line`.
   */
  readonly curve?: readonly UV[]
  /** An arc row's circle: centre, radius, angle of `start` from the centre, the angle turned. */
  readonly arc?: {
    readonly centre: UV
    readonly radius: number
    readonly from: number
    readonly sweep: number
  }
}

export interface ClonePath {
  /** Instance 1 (the source, offset 0) and every clone, in number order. */
  readonly instances: readonly { readonly number: number; readonly offset: UV; readonly at: UV }[]
  readonly rows: readonly PathRowResult[]
  /** Positions left out because they sat on an earlier instance. */
  readonly duplicates: readonly number[]
  /** Skipped positions' numbers. */
  readonly skipped: readonly number[]
  /** The highest number given (1 without rows). */
  readonly lastNumber: number
}

/** Two instances closer than this, mm, in u and v, are one spot: the G-code's resolution. */
export const SAME_SPOT = 0.001

/**
 * The clone path from the source's reference point `origin`: instance 1, then each row's points
 * from the moving reference point. Every point but a circle's closing one gets the next number,
 * so skipping keeps the numbers of the others (D30). Duplicates of an earlier clone are left out.
 */
export function clonePath(origin: UV, rows: readonly PathRow[]): ClonePath {
  const instances: { number: number; offset: UV; at: UV }[] = [
    { number: 1, offset: { u: 0, v: 0 }, at: origin },
  ]
  const taken = new Set<string>([key({ u: 0, v: 0 })])
  const duplicates: number[] = []
  const skipped: number[] = []
  const out: PathRowResult[] = []
  let number = 1
  // the reference point relative to the origin, exact so a long chain adds up no rounding
  let ref: UV = { u: 0, v: 0 }
  for (const row of rows) {
    const { points, end, arc, closes, curve } = rowPoints(row, ref, origin)
    const skip = new Set(row.skip)
    const marked = points.map((p, k): PathPoint => {
      const offset = { u: round(p.u), v: round(p.v) }
      const at = { u: round(origin.u + p.u), v: round(origin.v + p.v) }
      if (closes.includes(k)) return { at, offset, kind: 'closes' }
      const n = ++number
      if (skip.has(k)) {
        skipped.push(n)
        return { at, offset, kind: 'skipped', number: n }
      }
      if (near(taken, offset)) {
        duplicates.push(n)
        return { at, offset, kind: 'duplicate', number: n }
      }
      taken.add(key(offset))
      instances.push({ number: n, offset, at })
      return { at, offset, kind: 'clone', number: n }
    })
    const next = points[end] ?? ref
    const abs = (p: UV) => ({ u: origin.u + p.u, v: origin.v + p.v })
    out.push({
      kind: row.kind,
      start: abs(ref),
      points: marked,
      end: abs(next),
      // number order, so the drawn path visits 1, 2, 3, 4 (D45); then on to `end` where that is
      // another point (a grid's zigzag-last cell), so the next row starts on the line
      line: [
        abs(ref),
        ...points.map(abs),
        ...(end >= 0 && end !== points.length - 1 ? [abs(next)] : []),
      ],
      ...(arc && { arc: { ...arc, centre: abs(arc.centre) } }),
      ...(curve && { curve: curve.map(abs) }),
    })
    ref = next
  }
  return { instances, rows: out, duplicates, skipped, lastNumber: number }
}

/**
 * How many whole steps an arc row makes, and the angle it really turns (degrees, with the arc's
 * sign): less than `arc` when arc° is not a whole number of steps.
 */
export function arcSteps(row: Pick<ArcRow, 'arc' | 'step'>): { n: number; sweep: number } {
  // a hair of slack so 360 / 60 is 6 steps whatever the float division gives
  const n = Math.floor(Math.abs(row.arc) / row.step + 1e-9)
  return { n, sweep: Math.sign(row.arc) * n * row.step }
}

/** How many points a row has (its numbered positions plus a full circle's closing point). */
export function rowPointCount(row: PathRow): number {
  return rowPoints(row, { u: 0, v: 0 }).points.length
}

/** An arc row's drawn curve: one sample per this many degrees of sweep. */
export const CURVE_STEP_DEG = 5
/** An `along` row's drawn curve: at most this many samples (one per mm below it, at least 8). */
export const CURVE_SAMPLES = 256

/** Most stations an `along` row computes (the row limit, 100, is checked on them). */
const ALONG_POINTS_MAX = 10_000

/**
 * The arc lengths of an `along` row's positions from its chain's start point, and the chain's
 * length (mm); none without a chain or with neither `spacing` nor `count`.
 */
export function alongStations(row: AlongRow): { s: number[]; length: number } {
  if (row.chain === undefined || row.chain.elements.length === 0) return { s: [], length: 0 }
  const length = chainLength({ elements: [...row.chain.elements] })
  const { closed } = row.chain
  const s0 = row.start
  let n = 0
  let step = 0
  if (row.spacing !== undefined && row.spacing > 0) {
    step = row.spacing
    // as many as fit: to the end of a path, once round a loop (not back onto `start`)
    n = closed
      ? Math.ceil((length - SAME_SPOT) / step - 1e-9)
      : Math.floor((length - s0) / step + 1e-9) + 1
  } else if (row.count !== undefined && row.count >= 1) {
    n = row.count
    step = closed ? length / n : n > 1 ? (length - s0) / (n - 1) : 0
  }
  // a hostile spacing never runs away: the row limit is checked on this count
  n = Math.max(0, Math.min(n, ALONG_POINTS_MAX))
  return { s: Array.from({ length: n }, (_, k) => s0 + k * step), length }
}

/**
 * A row's points from the reference point `r` (both relative to `origin`; a point row's
 * absolute `[u, v]` is made relative with it), in numbering order; the index of the point the
 * reference point moves to (a grid's zigzag-last cell); an arc's circle; the points back on the
 * row's start (`closes`).
 */
function rowPoints(
  row: PathRow,
  r: UV,
  origin: UV = { u: 0, v: 0 },
): {
  points: UV[]
  end: number
  arc?: NonNullable<PathRowResult['arc']>
  closes: number[]
  curve?: UV[]
} {
  const points: UV[] = []
  switch (row.kind) {
    case 'grid': {
      for (let j = 0; j < row.rows; j++)
        for (let c = 0; c < row.cols; c++)
          if (j > 0 || c > 0) points.push({ u: r.u + c * row.du, v: r.v + j * row.dv })
      // cell (c, j) is point j · cols + c − 1 (cell 0 is `r`); the reference point ends on the
      // zigzag-last cell: odd rows run back, so an even number of rows ends in column 0
      const last = row.rows - 1
      const end = last * row.cols + (last % 2 === 0 ? row.cols - 1 : 0) - 1
      return { points, end: points.length === 0 ? -1 : end, closes: [] }
    }
    case 'offset':
      for (let k = 1; k <= row.count; k++) points.push({ u: r.u + k * row.du, v: r.v + k * row.dv })
      break
    case 'polar': {
      const a = rad(row.angle)
      for (let k = 1; k <= row.count; k++)
        points.push({
          u: r.u + k * row.distance * Math.cos(a),
          v: r.v + k * row.distance * Math.sin(a),
        })
      break
    }
    case 'point':
      points.push({ u: row.u - origin.u, v: row.v - origin.v })
      break
    case 'arc': {
      const a = rad(row.angle)
      const c = { u: r.u + row.radius * Math.cos(a), v: r.v + row.radius * Math.sin(a) }
      // from the centre the reference point is the other way round
      const start = row.angle + 180
      const dir = Math.sign(row.arc)
      const { n, sweep } = arcSteps(row)
      for (let k = 1; k <= n; k++) {
        const t = rad(start + dir * k * row.step)
        points.push({ u: c.u + row.radius * Math.cos(t), v: c.v + row.radius * Math.sin(t) })
      }
      const samples = Math.max(1, Math.ceil(Math.abs(sweep) / CURVE_STEP_DEG))
      const curve = Array.from({ length: samples + 1 }, (_, k) => {
        const t = rad(start + (sweep * k) / samples)
        return { u: c.u + row.radius * Math.cos(t), v: c.v + row.radius * Math.sin(t) }
      })
      return {
        points,
        end: points.length - 1,
        arc: { centre: c, radius: row.radius, from: start, sweep },
        closes: Math.abs(Math.abs(sweep) - 360) < 1e-6 ? [points.length - 1] : [],
        ...(n > 0 && { curve }),
      }
    }
    case 'along': {
      const { s, length } = alongStations(row)
      const chain = row.chain
      if (chain === undefined) break
      const loop = { elements: [...chain.elements] }
      const [a0, a1] = chain.elements[0]!.a
      const closes: number[] = []
      for (const [k, sk] of s.entries()) {
        // the chain's start point lies on the reference point
        const p = chainPointAt(loop, Math.min(sk, length), chain.closed)
        const [x, y] = p.isOk() ? p.unwrap().point : [a0, a1]
        points.push({ u: r.u + x - a0, v: r.v + y - a1 })
        const wrapped = chain.closed && length > 0 ? sk % length : sk
        if (Math.abs(wrapped) < SAME_SPOT || (chain.closed && length - wrapped < SAME_SPOT))
          closes.push(k)
      }
      // the drawn path: the chain from its start point (on `r`) to the last station
      const last = s.at(-1) ?? 0
      const curve: UV[] = []
      if (last > 0) {
        const samples = Math.min(CURVE_SAMPLES, Math.max(8, Math.ceil(last)))
        for (let k = 0; k <= samples; k++) {
          const p = chainPointAt(loop, Math.min((last * k) / samples, length), chain.closed)
          if (p.isErr()) continue
          const [x, y] = p.unwrap().point
          curve.push({ u: r.u + x - a0, v: r.v + y - a1 })
        }
      }
      return {
        points,
        end: points.length - 1,
        closes,
        ...(curve.length > 1 && { curve }),
      }
    }
  }
  return { points, end: points.length - 1, closes: [] }
}

/**
 * Which row and which of its points has instance number `number`; null for 1 (the source) and
 * numbers the path does not give.
 */
export function rowPointOf(path: ClonePath, number: number): { row: number; point: number } | null {
  if (number < 2) return null
  for (const [row, r] of path.rows.entries()) {
    const point = r.points.findIndex((p) => p.number === number)
    if (point >= 0) return { row, point }
  }
  return null
}

/** Point `point` of row `row` in or out of its `skip`, kept sorted; other rows are the same objects. */
export function toggleSkip<R extends PathRow>(
  rows: readonly R[],
  row: number,
  point: number,
): readonly R[] {
  const r = rows[row]
  if (r === undefined || !Number.isInteger(point) || point < 0) return rows
  const had = r.skip ?? []
  const skip = had.includes(point) ? had.filter((k) => k !== point) : [...had, point]
  return rows.map((c, i) => (i === row ? withSkip(c, skip) : c))
}

/**
 * `next` with `prev`'s skips carried over where they still mean the same spot: a grid keeps each
 * skipped cell (column, row) across a change of columns or rows; other kinds keep the indices
 * still inside the row; a change of kind drops them all.
 */
export function keepSkips<R extends PathRow>(prev: PathRow, next: R): R {
  const had = prev.skip ?? []
  if (prev.kind !== next.kind) return withSkip(next, [])
  if (prev.kind === 'grid' && next.kind === 'grid') {
    const cells = had.flatMap((k) => {
      // point k is cell k + 1 (cell 0 is the reference point)
      const c = (k + 1) % prev.cols
      const j = Math.floor((k + 1) / prev.cols)
      return j < prev.rows && c < next.cols && j < next.rows ? [j * next.cols + c - 1] : []
    })
    return withSkip(next, cells)
  }
  const n = rowPointCount(next)
  return withSkip(
    next,
    had.filter((k) => k < n),
  )
}

/** `row` with `skip` sorted and unique, or without `skip` when it is empty. */
export function withSkip<R extends PathRow>(row: R, skip: readonly number[]): R {
  const { skip: _, ...rest } = row
  const sorted = [...new Set(skip)].sort((a, b) => a - b)
  return (sorted.length > 0 ? { ...rest, skip: sorted } : rest) as R
}

/** A position already taken within `SAME_SPOT`: the same 0.001 mm step or a neighbouring one. */
function near(taken: ReadonlySet<string>, p: UV): boolean {
  const u = Math.round(p.u / SAME_SPOT)
  const v = Math.round(p.v / SAME_SPOT)
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) if (taken.has(`${u + i},${v + j}`)) return true
  return false
}

const key = (p: UV) => `${Math.round(p.u / SAME_SPOT)},${Math.round(p.v / SAME_SPOT)}`
const rad = (deg: number) => (deg * Math.PI) / 180
/** To the G-code's resolution, so 0.1 · 3 lands where 0.3 does. */
const round = (v: number) => Math.round(v * 1000) / 1000 + 0
