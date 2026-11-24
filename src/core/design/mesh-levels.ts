/**
 * Depth levels of a reference mesh seen from a stock face (DF60 P1): its flat faces parallel to
 * the face, grouped by height, from both sides of the axis in one pass, each with the part of it
 * that is visible from its side (a ray from it towards that stock face meets no triangle).
 * Pure; the worker task `reference.levels` runs it on the mesh it keeps.
 * Doc: docs/modes/reference-tools.md#levels
 *
 * Positions are the STL's as read (9 float32 per triangle, source units); `matrix` maps them to
 * the face frame (mm) with the face at w = 0 and the stock below it (w < 0).
 */
import { z } from 'zod'
import { Ok, type AppResult } from '../../shared/result'
import { noSteps, type Steps } from '../workers/steps'
import { STEP_TRIANGLES } from './mesh-section'

export interface LevelOptions {
  /** Levels smaller than this are dropped (mm²). */
  readonly minArea: number
  /** At most this many (largest areas win), then sorted by depth. */
  readonly limit: number
  /** `face`: only the levels facing the face. */
  readonly sides: 'both' | 'face'
  /** Stock extent along the face normal (mm), for `depthFromOpposite`. */
  readonly extent: number
}

export interface MeshLevel {
  /** Below the stock face (mm; negative above it). */
  readonly depth: number
  /** `face`: a floor seen from the face (machinable from it); `opposite`: from the opposite face. */
  readonly facing: 'face' | 'opposite'
  /** mm². */
  readonly area: number
  /** The part seen from its side (mm²); 0 = an undercut for 2.5D work. */
  readonly visibleArea: number
  /** In the face frame, mm. */
  readonly bounds: readonly [readonly [number, number], readonly [number, number]]
  /** For `opposite` levels: below the opposite stock face (mm). */
  readonly depthFromOpposite?: number
}

export interface MeshLevels {
  readonly levels: readonly MeshLevel[]
  /** Levels left out by `limit`. */
  readonly more?: number
}

const P2 = z.tuple([z.number(), z.number()]).readonly()
export const MeshLevelsSchema: z.ZodType<MeshLevels> = z.object({
  levels: z
    .array(
      z.object({
        depth: z.number(),
        facing: z.enum(['face', 'opposite']),
        area: z.number(),
        visibleArea: z.number(),
        bounds: z.tuple([P2, P2]).readonly(),
        depthFromOpposite: z.number().optional(),
      }),
    )
    .readonly(),
  more: z.number().int().optional(),
}) as unknown as z.ZodType<MeshLevels>

/** Flat: the normal within this of the face axis (0.5°). */
const FLAT_COS = Math.cos((0.5 * Math.PI) / 180)
/** Flat triangles within this height of each other are one level (mm). */
const JOIN = 0.005
/** Visibility sample grid (mm), coarsened to stay under `MAX_CELLS`. */
const CELL = 0.25
const MAX_CELLS = 4_000_000
/** A sample counts as seen when nothing lies more than this above it (mm). */
const SEEN_EPS = 0.01

const r3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

interface Flat {
  readonly t: number
  readonly w: number
  readonly area: number
  readonly up: boolean
}

/** The levels of a mesh (see the file comment). */
export function meshLevels(
  positions: Float32Array,
  matrix: readonly number[],
  o: LevelOptions,
  steps: Steps = noSteps,
): AppResult<MeshLevels> {
  const m = matrix
  const n = Math.floor(positions.length / 9)
  // every vertex in the face frame, once
  const uvw = new Float64Array(n * 9)
  let u0 = Infinity
  let v0 = Infinity
  let u1 = -Infinity
  let v1 = -Infinity
  for (let i = 0; i < n * 3; i++) {
    const x = positions[3 * i]!
    const y = positions[3 * i + 1]!
    const z = positions[3 * i + 2]!
    const u = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    const v = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    uvw[3 * i] = u
    uvw[3 * i + 1] = v
    uvw[3 * i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    if (u < u0) u0 = u
    if (u > u1) u1 = u
    if (v < v0) v0 = v
    if (v > v1) v1 = v
  }
  if (n === 0) return Ok({ levels: [] })
  const flats: Flat[] = []
  for (let t = 0; t < n; t++) {
    if (t % STEP_TRIANGLES === 0 && t > 0) {
      const s = steps.step({ done: t, total: 3 * n, label: 'Reference levels' })
      if (s.isErr()) return s
    }
    const o9 = 9 * t
    const ax = uvw[o9 + 3]! - uvw[o9]!
    const ay = uvw[o9 + 4]! - uvw[o9 + 1]!
    const az = uvw[o9 + 5]! - uvw[o9 + 2]!
    const bx = uvw[o9 + 6]! - uvw[o9]!
    const by = uvw[o9 + 7]! - uvw[o9 + 1]!
    const bz = uvw[o9 + 8]! - uvw[o9 + 2]!
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0 || Math.abs(nz) < FLAT_COS * len) continue
    const up = nz > 0
    if (!up && o.sides === 'face') continue
    flats.push({ t, w: (uvw[o9 + 2]! + uvw[o9 + 5]! + uvw[o9 + 8]!) / 3, area: len / 2, up })
  }
  // group by side, then by height
  flats.sort((a, b) => (a.up === b.up ? a.w - b.w : a.up ? -1 : 1))
  const groups: Flat[][] = []
  for (const f of flats) {
    const g = groups[groups.length - 1]
    const last = g?.[g.length - 1]
    if (g !== undefined && last !== undefined && last.up === f.up && f.w - last.w <= JOIN) g.push(f)
    else groups.push([f])
  }
  let kept = groups
    .map((g) => ({ g, area: g.reduce((s, f) => s + f.area, 0) }))
    .filter((x) => x.area >= o.minArea)
  const more = Math.max(0, kept.length - o.limit)
  kept = kept.sort((a, b) => b.area - a.area).slice(0, o.limit)

  // envelopes for visibility: the highest and lowest mesh point over each cell centre
  let cell = CELL
  while (((u1 - u0) / cell + 1) * ((v1 - v0) / cell + 1) > MAX_CELLS) cell *= 2
  const nu = Math.max(1, Math.ceil((u1 - u0) / cell))
  const nv = Math.max(1, Math.ceil((v1 - v0) / cell))
  const top = new Float32Array(nu * nv).fill(-Infinity)
  const bottom = new Float32Array(nu * nv).fill(Infinity)
  /** Calls `f(cell index, w)` for each cell centre inside triangle `t`'s projection. */
  const raster = (t: number, f: (c: number, w: number) => void): number => {
    const o9 = 9 * t
    const ax = uvw[o9]!
    const ay = uvw[o9 + 1]!
    const bx = uvw[o9 + 3]!
    const by = uvw[o9 + 4]!
    const cx = uvw[o9 + 6]!
    const cy = uvw[o9 + 7]!
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(det) < 1e-12) return 0
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - u0) / cell - 0.5))
    const i1 = Math.min(nu - 1, Math.floor((Math.max(ax, bx, cx) - u0) / cell - 0.5))
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - v0) / cell - 0.5))
    const j1 = Math.min(nv - 1, Math.floor((Math.max(ay, by, cy) - v0) / cell - 0.5))
    let count = 0
    for (let j = j0; j <= j1; j++) {
      const py = v0 + (j + 0.5) * cell
      for (let i = i0; i <= i1; i++) {
        const px = u0 + (i + 0.5) * cell
        const l1 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det
        const l2 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det
        const l3 = 1 - l1 - l2
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
        f(j * nu + i, l1 * uvw[o9 + 2]! + l2 * uvw[o9 + 5]! + l3 * uvw[o9 + 8]!)
        count++
      }
    }
    return count
  }
  for (let t = 0; t < n; t++) {
    if (t % STEP_TRIANGLES === 0 && t > 0) {
      const s = steps.step({ done: n + t, total: 3 * n, label: 'Reference levels' })
      if (s.isErr()) return s
    }
    raster(t, (c, w) => {
      if (w > top[c]!) top[c] = w
      if (w < bottom[c]!) bottom[c] = w
    })
  }
  const cellOf = (t: number): number => {
    const o9 = 9 * t
    const u = (uvw[o9]! + uvw[o9 + 3]! + uvw[o9 + 6]!) / 3
    const v = (uvw[o9 + 1]! + uvw[o9 + 4]! + uvw[o9 + 7]!) / 3
    const i = Math.min(nu - 1, Math.max(0, Math.floor((u - u0) / cell)))
    const j = Math.min(nv - 1, Math.max(0, Math.floor((v - v0) / cell)))
    return j * nu + i
  }

  const levels: MeshLevel[] = kept.map(({ g, area }) => {
    let w = 0
    let lu0 = Infinity
    let lv0 = Infinity
    let lu1 = -Infinity
    let lv1 = -Infinity
    let seen = 0
    let total = 0
    const up = g[0]!.up
    for (const f of g) {
      w += f.w * f.area
      for (let k = 0; k < 3; k++) {
        const u = uvw[9 * f.t + 3 * k]!
        const v = uvw[9 * f.t + 3 * k + 1]!
        lu0 = Math.min(lu0, u)
        lu1 = Math.max(lu1, u)
        lv0 = Math.min(lv0, v)
        lv1 = Math.max(lv1, v)
      }
    }
    w /= area
    const visible = (c: number) => (up ? top[c]! <= w + SEEN_EPS : bottom[c]! >= w - SEEN_EPS)
    for (const f of g) {
      const hits = raster(f.t, (c) => {
        total++
        if (visible(c)) seen++
      })
      if (hits === 0) {
        total++
        if (visible(cellOf(f.t))) seen++
      }
    }
    const depth = r3(-w)
    return {
      depth,
      facing: up ? 'face' : 'opposite',
      area: r3(area),
      visibleArea: total === 0 ? 0 : r3((area * seen) / total),
      bounds: [
        [r3(lu0), r3(lv0)],
        [r3(lu1), r3(lv1)],
      ],
      ...(up ? {} : { depthFromOpposite: r3(o.extent + w) }),
    }
  })
  levels.sort(
    (a, b) => a.depth - b.depth || (a.facing === b.facing ? 0 : a.facing === 'face' ? -1 : 1),
  )
  return Ok(more > 0 ? { levels, more } : { levels })
}
