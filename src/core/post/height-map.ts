/**
 * Surface maps (v0.5 RV10, Q227): a probed grid of stock-top heights and the Z compensation the
 * export applies with it. Moves below the clearance height are split into short segments (arcs
 * linearised) and offset by the bilinear map relative to their tool run's touch-off spot, so the
 * Z0 set there stays exact; moves at or above the clearance are untouched. Pure and headless.
 * Doc: docs/modes/run-surface.md
 */
import type { Issue } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult } from '../../shared/result'
import { arcSweep } from '../toolpath/stats'
import type { Vec3 } from '../toolpath/model'
import type { Block, MachiningProgram } from './program'

/** A probed grid of surface heights in a setup's work frame (docs/modes/run-surface.md#the-map). */
export interface HeightMap {
  /** The grid's first point (front left), work X/Y (mm). */
  readonly origin: readonly [number, number]
  /** Between columns (X) and between rows (Y), mm > 0. */
  readonly spacing: readonly [number, number]
  /** Points along X and along Y, 2–30 each. */
  readonly cols: number
  readonly rows: number
  /** Work Z of the surface per point, row by row from the front; `null`: not measured. */
  readonly z: readonly (number | null)[]
  /** Points left out under workholding: filled from their neighbours when used. */
  readonly skipped?: readonly number[]
  /** G54 X/Y (MPos) when the map was taken. */
  readonly workZero?: readonly [number, number]
}

export const HEIGHT_MAP_DEFAULTS = {
  /** The follow limit: a larger range is refused (mm; app setting `surfaceMapMaxRange`). */
  maxRange: 1,
  /** Max segment length in X/Y (mm), and at most half the smaller spacing (Q227). */
  maxSegment: 2,
  /** Max sagitta of an arc's chords (mm). */
  arcTolerance: 0.002,
  /** Grid size limits. */
  minPoints: 2,
  maxPoints: 30,
} as const

/** The compensation's figures, for the pre-flight. */
export interface SurfaceSummary {
  /** The largest |dz| any written point got (mm). */
  readonly maxDz: number
  /** The map's range: max − min over its heights (mm). */
  readonly range: number
  /** Moves split or linearised. */
  readonly split: number
}

export interface HeightMapOptions {
  /** The follow limit (mm); default `HEIGHT_MAP_DEFAULTS.maxRange`. */
  readonly maxRange?: number
  /** Max segment length (mm); default `maxSegmentOf(map)`. */
  readonly maxSegment?: number
}

const EPS = 1e-6
const where = 'heightMap'

function refused(rule: string, message: string, params: Record<string, unknown> = {}) {
  return fail('run.surfaceMap', message, {
    where,
    issues: [{ path: ['surfaceMap'], rule, message, params }],
  })
}

/** Structural checks: counts, spacing, finite heights, skipped indices (`input.malformed`). */
export function checkHeightMap(map: HeightMap): AppResult<void> {
  const issues: Issue[] = []
  const d = HEIGHT_MAP_DEFAULTS
  for (const [k, v] of [
    ['cols', map.cols],
    ['rows', map.rows],
  ] as const)
    if (!Number.isInteger(v) || v < d.minPoints || v > d.maxPoints)
      issues.push({ path: [k], rule: 'range', message: `must be ${d.minPoints}–${d.maxPoints}` })
  map.spacing.forEach((s, k) => {
    if (!(Number.isFinite(s) && s > 0))
      issues.push({ path: ['spacing', k], rule: 'positive', message: 'must be > 0' })
  })
  if (!map.origin.every(Number.isFinite))
    issues.push({ path: ['origin'], rule: 'finite', message: 'must be finite' })
  if (map.z.length !== map.cols * map.rows)
    issues.push({ path: ['z'], rule: 'length', message: 'one height per point' })
  map.z.forEach((v, k) => {
    if (v !== null && !Number.isFinite(v))
      issues.push({ path: ['z', k], rule: 'finite', message: 'must be finite' })
  })
  for (const k of map.skipped ?? [])
    if (!Number.isInteger(k) || k < 0 || k >= map.z.length)
      issues.push({ path: ['skipped'], rule: 'range', message: 'must name a point' })
  if (issues.length > 0)
    return fail('input.malformed', `${issues.length} invalid surface map value(s)`, {
      where,
      issues,
    })
  return Ok(undefined)
}

/** The measured points (not skipped, with a height) and the total that should be. */
export function mapProgress(map: HeightMap): { measured: number; needed: number } {
  const skipped = new Set(map.skipped ?? [])
  let measured = 0
  let needed = 0
  map.z.forEach((v, k) => {
    if (skipped.has(k)) return
    needed++
    if (v !== null) measured++
  })
  return { measured, needed }
}

/**
 * Every point's height: measured points as they are, skipped points filled with the mean of their
 * measured or already filled 8-neighbours, repeatedly. Refused (`incomplete`) while a point that is
 * not skipped has no height, or when nothing was measured.
 */
export function filledHeights(map: HeightMap): AppResult<number[]> {
  const checked = checkHeightMap(map)
  if (checked.isErr()) return checked
  const { measured, needed } = mapProgress(map)
  if (measured < needed || measured === 0)
    return refused(
      'incomplete',
      `The map is incomplete (${measured} of ${needed} points): Retry from there or map again.`,
      { measured, needed },
    )
  const z: (number | null)[] = [...map.z]
  const skipped = new Set(map.skipped ?? [])
  for (const k of skipped) z[k] = null
  let open = [...skipped]
  while (open.length > 0) {
    const next: number[] = []
    const found: [number, number][] = []
    for (const k of open) {
      const c = k % map.cols
      const r = Math.floor(k / map.cols)
      let sum = 0
      let n = 0
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr
          const cc = c + dc
          if ((dr === 0 && dc === 0) || rr < 0 || cc < 0 || rr >= map.rows || cc >= map.cols)
            continue
          const v = z[rr * map.cols + cc]
          if (v !== null && v !== undefined) {
            sum += v
            n++
          }
        }
      if (n > 0) found.push([k, sum / n])
      else next.push(k)
    }
    // fill a whole ring at once, so the order inside it does not matter
    for (const [k, v] of found) z[k] = v
    if (found.length === 0) break
    open = next
  }
  return Ok(z.map((v) => v ?? 0))
}

/** Min, max and range over the measured points. */
export function mapRange(map: HeightMap): { min: number; max: number; range: number } {
  const v = map.z.filter((x): x is number => x !== null)
  if (v.length === 0) return { min: 0, max: 0, range: 0 }
  const min = Math.min(...v)
  const max = Math.max(...v)
  return { min, max, range: max - min }
}

/** Q227: half the smaller spacing, at most 2 mm. */
export function maxSegmentOf(map: HeightMap): number {
  return Math.min(HEIGHT_MAP_DEFAULTS.maxSegment, Math.min(...map.spacing) / 2)
}

/**
 * The bilinear surface over `heights` (every point filled): its height at (x, y), extrapolated
 * linearly from the edge cell up to one spacing outside the grid; `undefined` further out.
 */
export function mapHeight(
  map: HeightMap,
  heights: readonly number[],
): (x: number, y: number) => number | undefined {
  const { cols, rows } = map
  const [ox, oy] = map.origin
  const [dx, dy] = map.spacing
  return (x, y) => {
    const u = (x - ox) / dx
    const v = (y - oy) / dy
    if (u < -1 - EPS || v < -1 - EPS || u > cols + EPS || v > rows + EPS) return undefined
    const i = Math.min(cols - 2, Math.max(0, Math.floor(u)))
    const j = Math.min(rows - 2, Math.max(0, Math.floor(v)))
    const s = u - i
    const t = v - j
    const h = (c: number, r: number) => heights[r * cols + c]!
    return (
      h(i, j) * (1 - s) * (1 - t) +
      h(i + 1, j) * s * (1 - t) +
      h(i, j + 1) * (1 - s) * t +
      h(i + 1, j + 1) * s * t
    )
  }
}

const fmt1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)

/**
 * The program with its Z following the map (docs/modes/run-surface.md#following-the-map): every
 * move with an end below the clearance height split into segments of at most `maxSegment` in X/Y
 * (arcs linearised first), each end below the clearance offset by `h(x, y) − h(spot)` of its tool
 * run's touch-off spot. Refused (`run.surfaceMap`) for an incomplete map, a range over the limit,
 * a move or a touch-off spot more than one cell outside the grid, or a dz reaching the clearance.
 */
export function applyHeightMap(
  program: MachiningProgram,
  map: HeightMap,
  opts: HeightMapOptions = {},
): AppResult<{ program: MachiningProgram; surface: SurfaceSummary }> {
  const filled = filledHeights(map)
  if (filled.isErr()) return filled
  const heights = filled.unwrap()
  const range = Math.max(...heights) - Math.min(...heights)
  const limit = opts.maxRange ?? HEIGHT_MAP_DEFAULTS.maxRange
  if (range > limit + EPS)
    return refused(
      'range',
      `The surface varies by ${range.toFixed(2)} mm, more than the ${limit.toFixed(2)} mm limit: check the stock and the map, or raise the limit in Settings.`,
      { range, limit },
    )
  const h = mapHeight(map, heights)
  const top = Math.max(...heights)
  const seg = opts.maxSegment ?? maxSegmentOf(map)
  const clearance = program.clearanceZ
  const below = (z: number) => z < clearance - EPS

  const out: Block[] = []
  let pos: Vec3 | undefined
  let anchor: { at: readonly [number, number]; h: number } | undefined
  let anchorAt: readonly [number, number] | undefined
  let maxDz = 0
  let split = 0

  const useAnchor = (): AppResult<number> => {
    if (anchor !== undefined) return Ok(anchor.h)
    if (anchorAt === undefined)
      return refused('anchor', 'A tool run has no touch-off spot to anchor the map at.')
    const a = h(anchorAt[0], anchorAt[1])
    if (a === undefined)
      return refused(
        'anchor',
        `The touch-off spot X ${fmt1(anchorAt[0])} Y ${fmt1(anchorAt[1])} is outside the map: map an area that includes it.`,
        { at: [...anchorAt] },
      )
    if (top - a >= clearance - EPS)
      return refused(
        'clearance',
        `The surface rises ${(top - a).toFixed(2)} mm above Z0, at or above the clearance height: raise the clearance or check the map.`,
        { rise: top - a, clearance },
      )
    anchor = { at: anchorAt, h: a }
    return Ok(a)
  }

  /** `p` offset when below the clearance. */
  const comp = (p: Vec3): AppResult<Vec3> => {
    if (!below(p[2])) return Ok(p)
    const a = useAnchor()
    if (a.isErr()) return a
    const z = h(p[0], p[1])
    if (z === undefined)
      return refused(
        'outside',
        `The program leaves the mapped area at X ${fmt1(p[0])} Y ${fmt1(p[1])}: map a larger area.`,
        { at: [p[0], p[1]] },
      )
    const dz = z - a.unwrap()
    maxDz = Math.max(maxDz, Math.abs(dz))
    return Ok([p[0], p[1], p[2] + dz])
  }

  /** A straight move from `from` (unknown: one segment) split and offset. */
  const line = (
    kind: 'rapid' | 'feed',
    from: Vec3 | undefined,
    to: Vec3,
    feed: number,
  ): AppResult<number> => {
    const n =
      from === undefined
        ? 1
        : Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / seg - 1e-9))
    for (let k = 1; k <= n; k++) {
      const p: Vec3 =
        from === undefined || k === n
          ? to
          : [
              from[0] + ((to[0] - from[0]) * k) / n,
              from[1] + ((to[1] - from[1]) * k) / n,
              from[2] + ((to[2] - from[2]) * k) / n,
            ]
      const c = comp(p)
      if (c.isErr()) return c
      out.push(kind === 'rapid' ? { kind, to: c.unwrap() } : { kind, to: c.unwrap(), feed })
    }
    return Ok(n)
  }

  for (const b of program.blocks) {
    if (b.kind === 'toolChange') {
      anchorAt = b.zRef?.at
      anchor = undefined
      out.push(b)
      // the post retracts to the clearance (and may rapid to the spot) after a tool change
      pos = undefined
      continue
    }
    if (b.kind !== 'rapid' && b.kind !== 'feed' && b.kind !== 'arc') {
      out.push(b)
      continue
    }
    const untouched = !below(b.to[2]) && (pos === undefined || !below(pos[2]))
    if (untouched) {
      out.push(b)
      pos = b.to
      continue
    }
    if (b.kind === 'arc') {
      if (pos === undefined) return refused('arc', 'An arc starts from an unknown position.')
      const from = pos
      const center: Vec3 = [from[0] + b.i, from[1] + b.j, 0]
      const r = Math.hypot(b.i, b.j)
      const total = arcSweep(from, {
        kind: 'arc',
        to: b.to,
        center: [center[0], center[1]],
        cw: b.cw,
        feed: b.feed,
      })
      const tol = HEIGHT_MAP_DEFAULTS.arcTolerance
      const perChord = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 2
      const n = Math.max(1, Math.ceil(Math.abs(total) / Math.min(perChord, Math.PI / 4) - 1e-9))
      const a0 = Math.atan2(from[1] - center[1], from[0] - center[0])
      split++
      let prev = from
      for (let k = 1; k <= n; k++) {
        const a = a0 + (total * k) / n
        const p: Vec3 =
          k === n
            ? b.to
            : [
                center[0] + r * Math.cos(a),
                center[1] + r * Math.sin(a),
                from[2] + ((b.to[2] - from[2]) * k) / n,
              ]
        const done = line('feed', prev, p, b.feed)
        if (done.isErr()) return done
        prev = p
      }
      pos = b.to
      continue
    }
    const done = line(b.kind, pos, b.to, b.kind === 'feed' ? b.feed : 0)
    if (done.isErr()) return done
    if (done.unwrap() > 1) split++
    pos = b.to
  }
  return Ok({ program: { ...program, blocks: out }, surface: { maxDz, range, split } })
}
