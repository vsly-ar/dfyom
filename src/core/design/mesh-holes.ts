/**
 * Holes of a reference mesh seen from a stock face (DF60 P3): circle slices of sections between
 * the flat levels stacked into holes, each read from the triangles near its axis (mouth: a
 * countersink by its tilted facets' slope, a counterbore, or steps; bottom: flat, cone or
 * through along the axis), then grouped by size with grid and circle patterns and turned into
 * ready-to-send `design.hole.add` / `design.drilling.add` (+ `design.clones.add`) suggestions.
 * Pure; the worker task `reference.holes` runs `meshHoles` on the mesh it keeps, the query
 * groups and suggests (`holeGroups`).
 * Doc: docs/modes/reference-tools.md#2-features-holes
 *
 * Positions are the STL's as read (9 float32 per triangle, source units); `matrix` maps them to
 * the face frame (mm) with the face at w = 0 and the stock below it (w < 0), depth = −w.
 */
import { z } from 'zod'
import { Ok, type AppResult } from '../../shared/result'
import { circleOf, cleanPolyline } from '../geometry/2d/fit-polyline'
import { noSteps, type Steps } from '../workers/steps'
import type { FastenerFit } from './fastener/data'
import { FASTENER_TABLE } from './fastener/data'
import { sectionChains } from './mesh-section'
import { nestingRoles } from './reference-section'

export interface HoleOptions {
  /** Holes wider than this are left out (mm). */
  readonly maxDiameter: number
  /** At most this many holes (largest diameters first). */
  readonly limit: number
}

export const HOLE_MAX_DIAMETER_MM = 50
export const HOLE_LIMIT = 64
/** At most this many groups in a result. */
export const HOLE_GROUPS_MAX = 16

export type HoleMouth =
  | { readonly type: 'countersink'; readonly diameter: number; readonly angle: number }
  | { readonly type: 'counterbore'; readonly diameter: number; readonly depth: number }

export type HoleBottom = 'through' | 'flat' | 'cone'

/** One hole, face frame, mm. */
export interface MeshHole {
  readonly center: readonly [number, number]
  /** The bore's (narrowest band's) diameter. */
  readonly diameter: number
  /** Depth of the mouth's level below the stock face (0: it opens on the face). */
  readonly top: number
  /** flat: the floor; cone: to full diameter; through: where the bore ends (a read-out). */
  readonly depth: number
  readonly bottom: HoleBottom
  /** cone: included angle (°). */
  readonly coneAngle?: number
  readonly mouth?: HoleMouth
  /** Two or more vertical bands above the bore: each band's diameter and end depth, widest first. */
  readonly steps?: readonly { readonly diameter: number; readonly depth: number }[]
}

export interface MeshHoles {
  readonly holes: readonly MeshHole[]
  /** Holes left out by `limit`. */
  readonly more?: number
}

const P2 = z.tuple([z.number(), z.number()]).readonly()
const MouthSchema = z.union([
  z.object({ type: z.literal('countersink'), diameter: z.number(), angle: z.number() }),
  z.object({ type: z.literal('counterbore'), diameter: z.number(), depth: z.number() }),
])
const StepsSchema = z.array(z.object({ diameter: z.number(), depth: z.number() })).readonly()
export const MeshHolesSchema: z.ZodType<MeshHoles> = z.object({
  holes: z
    .array(
      z.object({
        center: P2,
        diameter: z.number(),
        top: z.number(),
        depth: z.number(),
        bottom: z.enum(['through', 'flat', 'cone']),
        coneAngle: z.number().optional(),
        mouth: MouthSchema.optional(),
        steps: StepsSchema.optional(),
      }),
    )
    .readonly(),
  more: z.number().int().optional(),
}) as unknown as z.ZodType<MeshHoles>

/** A slice's loop is a circle within this (mm), and sizes and mouths agree within it. */
export const HOLE_TOLERANCE = 0.02
/** Slices whose centres agree within this stack into one hole (mm). */
const STACK = 0.05
/** Flat heights within this are one level (mm), as `meshLevels`. */
const JOIN = 0.005
/** Flat: the normal within 0.5° of the axis, as `meshLevels`. */
const FLAT_COS = Math.cos((0.5 * Math.PI) / 180)
/** A wall facet is tilted (a cone, not a cylinder) above this share of its normal on the axis. */
const TILTED = 0.1
/** Sections this far inside each end of a gap between levels (mm). */
const INSET = 0.02

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

interface Slice {
  readonly w: number
  readonly u: number
  readonly v: number
  readonly d: number
}

/** The holes of a mesh (see the file comment), largest diameters first. */
export function meshHoles(
  positions: Float32Array,
  matrix: readonly number[],
  o: HoleOptions,
  steps: Steps = noSteps,
): AppResult<MeshHoles> {
  const m = matrix
  const n = Math.floor(positions.length / 9)
  if (n === 0) return Ok({ holes: [] })
  // every vertex in the face frame; per triangle its box and normal's share on the axis
  const uvw = new Float64Array(n * 9)
  for (let i = 0; i < n * 3; i++) {
    const x = positions[3 * i]!
    const y = positions[3 * i + 1]!
    const z = positions[3 * i + 2]!
    uvw[3 * i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    uvw[3 * i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    uvw[3 * i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  }
  const box = new Float64Array(n * 6) // u0 v0 w0 u1 v1 w1
  const axial = new Float64Array(n) // signed nz / |n|
  const flats: number[] = []
  let wmin = Infinity
  let wmax = -Infinity
  for (let t = 0; t < n; t++) {
    const o9 = 9 * t
    for (let k = 0; k < 3; k++) {
      const lo = (a: number, b: number) => (k === 0 ? b : Math.min(a, b))
      const hi = (a: number, b: number) => (k === 0 ? b : Math.max(a, b))
      box[6 * t] = lo(box[6 * t]!, uvw[o9 + 3 * k]!)
      box[6 * t + 1] = lo(box[6 * t + 1]!, uvw[o9 + 3 * k + 1]!)
      box[6 * t + 2] = lo(box[6 * t + 2]!, uvw[o9 + 3 * k + 2]!)
      box[6 * t + 3] = hi(box[6 * t + 3]!, uvw[o9 + 3 * k]!)
      box[6 * t + 4] = hi(box[6 * t + 4]!, uvw[o9 + 3 * k + 1]!)
      box[6 * t + 5] = hi(box[6 * t + 5]!, uvw[o9 + 3 * k + 2]!)
    }
    wmin = Math.min(wmin, box[6 * t + 2]!)
    wmax = Math.max(wmax, box[6 * t + 5]!)
    const ax = uvw[o9 + 3]! - uvw[o9]!
    const ay = uvw[o9 + 4]! - uvw[o9 + 1]!
    const az = uvw[o9 + 5]! - uvw[o9 + 2]!
    const bx = uvw[o9 + 6]! - uvw[o9]!
    const by = uvw[o9 + 7]! - uvw[o9 + 1]!
    const bz = uvw[o9 + 8]! - uvw[o9 + 2]!
    const nz = ax * by - ay * bx
    const len = Math.hypot(ay * bz - az * by, az * bx - ax * bz, nz)
    axial[t] = len === 0 ? 0 : nz / len
    if (len > 0 && Math.abs(nz) >= FLAT_COS * len)
      flats.push((uvw[o9 + 2]! + uvw[o9 + 5]! + uvw[o9 + 8]!) / 3)
  }
  // the heights (flat levels, the mesh's top and bottom), highest first
  const raw = [...flats, wmin, wmax].sort((a, b) => b - a)
  const heights: number[] = []
  for (const h of raw)
    if (heights.length === 0 || heights[heights.length - 1]! - h > JOIN) heights.push(h)
  // sections: the middle of each gap, and just inside its ends
  const planes: number[] = []
  for (let i = 0; i + 1 < heights.length; i++) {
    const a = heights[i]!
    const b = heights[i + 1]!
    if (a - b < 2 * INSET) continue
    if (a - b > 4 * INSET) planes.push(a - INSET)
    planes.push((a + b) / 2)
    if (a - b > 4 * INSET) planes.push(b + INSET)
  }
  const slices: Slice[] = []
  for (const w of planes) {
    const chains = sectionChains(positions, matrix, w, steps)
    if (chains.isErr()) return chains
    const closed = chains.unwrap().filter((c) => c.closed && c.points.length >= 16)
    const { roles } = nestingRoles(closed)
    closed.forEach((c, i) => {
      if (roles[i] !== 'hole') return
      const p = c.points
      let u0 = Infinity
      let u1 = -Infinity
      for (let k = 0; k < p.length; k += 2) {
        u0 = Math.min(u0, p[k]!)
        u1 = Math.max(u1, p[k]!)
      }
      if (u1 - u0 > o.maxDiameter + 1) return
      const pts: [number, number][] = []
      for (let k = 0; k < p.length; k += 2) pts.push([p[k]!, p[k + 1]!])
      const circle = circleOf(cleanPolyline(pts), HOLE_TOLERANCE)
      if (circle === undefined || 2 * circle.circle.radius > o.maxDiameter) return
      const [u, v] = circle.circle.centre
      slices.push({ w, u, v, d: 2 * circle.circle.radius })
    })
  }
  // stack the slices by centre, shallowest first
  slices.sort((a, b) => b.w - a.w)
  const stacks: Slice[][] = []
  for (const s of slices) {
    const st = stacks.find((x) => Math.hypot(x[0]!.u - s.u, x[0]!.v - s.v) <= STACK)
    if (st === undefined) stacks.push([s])
    else st.push(s)
  }
  const holes: MeshHole[] = []
  for (const st of stacks) {
    const hole = readHole(st, { uvw, box, axial, n, heights, planes, wmin })
    if (hole !== undefined) holes.push(hole)
  }
  holes.sort(
    (a, b) => b.diameter - a.diameter || a.center[1] - b.center[1] || a.center[0] - b.center[0],
  )
  const kept = holes.slice(0, o.limit)
  return Ok(
    holes.length > kept.length
      ? { holes: kept, more: holes.length - kept.length }
      : { holes: kept },
  )
}

interface MeshData {
  readonly uvw: Float64Array
  readonly box: Float64Array
  readonly axial: Float64Array
  readonly n: number
  /** Distinct heights (flat levels, mesh top and bottom), highest first. */
  readonly heights: readonly number[]
  /** The section planes, highest first. */
  readonly planes: readonly number[]
  readonly wmin: number
}

/** One stack of slices read as a hole (see the file comment); undefined when it is none. */
function readHole(st: readonly Slice[], g: MeshData): MeshHole | undefined {
  const { uvw, box, axial } = g
  const rMax = Math.max(...st.map((s) => s.d / 2))
  const cu0 = st[0]!.u
  const cv0 = st[0]!.v
  // the triangles near the axis (their boxes meet the widest slice's square)
  const near: number[] = []
  for (let t = 0; t < g.n; t++) {
    const b = 6 * t
    if (box[b]! > cu0 + rMax + 0.1 || box[b + 3]! < cu0 - rMax - 0.1) continue
    if (box[b + 1]! > cv0 + rMax + 0.1 || box[b + 4]! < cv0 - rMax - 0.1) continue
    near.push(t)
  }
  // each slice: does its circle lie on vertical walls (a bore) or tilted ones (a cone)?
  const tilted = st.map((s) => {
    let up = 0
    let all = 0
    for (const t of near) {
      if (box[6 * t + 2]! >= s.w || box[6 * t + 5]! <= s.w) continue
      const c = crossing(uvw, t, s.w)
      if (c === undefined) continue
      const r = Math.hypot(c[0] - s.u, c[1] - s.v)
      if (Math.abs(r - s.d / 2) > Math.max(0.05, 0.05 * s.d)) continue
      all++
      if (Math.abs(axial[t]!) > TILTED) up++
    }
    return all > 0 && up * 2 > all
  })
  // bands of equal diameter among the bore slices (vertical walls), shallowest first
  type Band = { slices: Slice[]; tilted: boolean }
  const bands: Band[] = []
  st.forEach((s, i) => {
    const last = bands[bands.length - 1]
    if (
      last !== undefined &&
      last.tilted === tilted[i] &&
      (tilted[i] || Math.abs(last.slices[0]!.d - s.d) <= HOLE_TOLERANCE)
    )
      last.slices.push(s)
    else bands.push({ slices: [s], tilted: tilted[i]! })
  })
  const vertical = bands.map((b, i) => ({ b, i })).filter((x) => !x.b.tilted)
  if (vertical.length === 0) return undefined
  const boreAt = vertical.reduce((best, x) =>
    x.b.slices[0]!.d < best.b.slices[0]!.d - HOLE_TOLERANCE ? x : best,
  ).i
  const bore = bands[boreAt]!
  const mean = (f: (s: Slice) => number) =>
    bore.slices.reduce((a, s) => a + f(s), 0) / bore.slices.length
  const cu = mean((s) => s.u)
  const cv = mean((s) => s.v)
  const D = mean((s) => s.d)
  const R = D / 2
  // the mouth's level: the height just above the shallowest slice
  const firstW = st[0]!.w
  const above = g.heights.filter((h) => h > firstW)
  const topW = above.length === 0 ? firstW : above[above.length - 1]!
  const top = -topW
  // along the axis: the triangles whose projection holds the centre, by depth
  const hits: { depth: number; t: number }[] = []
  for (const t of near) {
    const w = atPoint(uvw, t, cu, cv)
    if (w !== undefined) hits.push({ depth: -w, t })
  }
  hits.sort((a, b) => a.depth - b.depth)
  // material on the axis above the shallowest slice: the hole does not open towards this face
  if (hits.some((h) => h.depth < -firstW)) return undefined
  // where the bore's wall ends: its deepest vertex (vertical facets on the bore's radius)
  const lastBore = bore.slices[bore.slices.length - 1]!
  const firstBore = bore.slices[0]!
  const after = hits.find((h) => h.depth > -lastBore.w)
  const limit = after === undefined ? Infinity : after.depth + 0.01
  const tolR = Math.max(HOLE_TOLERANCE, 0.005 * D)
  let boreEnd = -lastBore.w
  for (const t of near) {
    if (Math.abs(axial[t]!) > TILTED) continue
    for (let k = 0; k < 3; k++) {
      const o3 = 9 * t + 3 * k
      const depth = -uvw[o3 + 2]!
      if (depth <= boreEnd || depth > limit) continue
      if (Math.abs(Math.hypot(uvw[o3]! - cu, uvw[o3 + 1]! - cv) - R) <= tolR) boreEnd = depth
    }
  }
  // the bottom
  let bottom: HoleBottom
  let depth: number
  let coneAngle: number | undefined
  if (after !== undefined && after.depth - boreEnd <= D) {
    if (Math.abs(axial[after.t]!) >= FLAT_COS) {
      bottom = 'flat'
      depth = after.depth
    } else {
      bottom = 'cone'
      depth = boreEnd
      const h = after.depth - boreEnd
      coneAngle = h <= 1e-6 ? 180 : (2 * Math.atan(R / h) * 180) / Math.PI
    }
  } else {
    bottom = after === undefined ? 'through' : 'flat'
    depth = boreEnd
  }
  // above the bore: a countersink (tilted facets), a counterbore (one vertical band) or steps
  const upper = bands.slice(0, boreAt)
  const levelBetween = (a: number, b: number): number => {
    // the flat level between two depths (a < b), else their middle
    const h = g.heights.find((x) => -x > a && -x < b)
    return h === undefined ? (a + b) / 2 : -h
  }
  let mouth: HoleMouth | undefined
  let steps: { diameter: number; depth: number }[] | undefined
  if (upper.length > 0) {
    const bandEnd = (i: number) =>
      levelBetween(
        -upper[i]!.slices[upper[i]!.slices.length - 1]!.w,
        -(upper[i + 1] ?? bore).slices[0]!.w,
      )
    if (upper.some((b) => b.tilted)) {
      const slopes: number[] = []
      for (const t of near) {
        const a = Math.abs(axial[t]!)
        if (a <= TILTED || a >= FLAT_COS) continue
        let dMin = Infinity
        let dMax = -Infinity
        let rAtMin = 0
        let rAtMax = 0
        let rSum = 0
        for (let k = 0; k < 3; k++) {
          const o3 = 9 * t + 3 * k
          const dk = -uvw[o3 + 2]!
          const rk = Math.hypot(uvw[o3]! - cu, uvw[o3 + 1]! - cv)
          rSum += rk
          if (dk < dMin) {
            dMin = dk
            rAtMin = rk
          }
          if (dk > dMax) {
            dMax = dk
            rAtMax = rk
          }
        }
        const rc = rSum / 3
        if (dMin < top - 0.01 || dMax > -firstBore.w || rc < R - tolR || rc > rMax + 0.1) continue
        if (dMax - dMin > 1e-6) slopes.push(Math.abs(rAtMin - rAtMax) / (dMax - dMin))
      }
      if (slopes.length > 0) {
        const s = median(slopes)
        const first = st[0]!
        mouth = {
          type: 'countersink',
          diameter: first.d + 2 * s * (-first.w - top),
          angle: (2 * Math.atan(s) * 180) / Math.PI,
        }
      }
    } else if (upper.length === 1) {
      const b = upper[0]!.slices
      mouth = {
        type: 'counterbore',
        diameter: b.reduce((a, s) => a + s.d, 0) / b.length,
        depth: bandEnd(0),
      }
    } else {
      steps = upper.map((b, i) => ({
        diameter: b.slices.reduce((a, s) => a + s.d, 0) / b.slices.length,
        depth: bandEnd(i),
      }))
      steps.push({ diameter: D, depth })
    }
  }
  return {
    center: [cu, cv],
    diameter: D,
    top,
    depth,
    bottom,
    ...(coneAngle === undefined ? {} : { coneAngle }),
    ...(mouth === undefined ? {} : { mouth }),
    ...(steps === undefined ? {} : { steps }),
  }
}

/** The midpoint of triangle `t`'s crossing of the plane w (face frame), if it crosses it. */
function crossing(uvw: Float64Array, t: number, w: number): [number, number] | undefined {
  const pts: [number, number][] = []
  for (let k = 0; k < 3; k++) {
    const a = 9 * t + 3 * k
    const b = 9 * t + 3 * ((k + 1) % 3)
    const wa = uvw[a + 2]! - w
    const wb = uvw[b + 2]! - w
    if (wa >= 0 === wb >= 0) continue
    const f = wa / (wa - wb)
    pts.push([uvw[a]! + f * (uvw[b]! - uvw[a]!), uvw[a + 1]! + f * (uvw[b + 1]! - uvw[a + 1]!)])
  }
  return pts.length === 2
    ? [(pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2]
    : undefined
}

/** The height w of triangle `t` over the point (u, v), when its projection holds it. */
function atPoint(uvw: Float64Array, t: number, u: number, v: number): number | undefined {
  const o9 = 9 * t
  const ax = uvw[o9]!
  const ay = uvw[o9 + 1]!
  const bx = uvw[o9 + 3]!
  const by = uvw[o9 + 4]!
  const cx = uvw[o9 + 6]!
  const cy = uvw[o9 + 7]!
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
  if (Math.abs(det) < 1e-12) return undefined
  const l1 = ((bx - u) * (cy - v) - (cx - u) * (by - v)) / det
  const l2 = ((cx - u) * (ay - v) - (ax - u) * (cy - v)) / det
  const l3 = 1 - l1 - l2
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return undefined
  return l1 * uvw[o9 + 2]! + l2 * uvw[o9 + 5]! + l3 * uvw[o9 + 8]!
}

// ── groups, patterns, suggestions ───────────────────────────────────────────────────────────

export type HolePattern =
  | {
      readonly kind: 'grid'
      readonly origin: readonly [number, number]
      readonly pitch: readonly [number, number]
      readonly count: readonly [number, number]
    }
  | {
      readonly kind: 'circle'
      readonly center: readonly [number, number]
      readonly pitchDiameter: number
      readonly count: number
      readonly startAngle: number
    }

/** A hole's size: everything but its centre. */
export type HoleSize = Omit<MeshHole, 'center'>

export interface HoleGroup {
  readonly count: number
  /** From the pattern's first instance (grid origin, circle start), then by v, u. */
  readonly holes: readonly (readonly [number, number])[]
  readonly size: HoleSize
  readonly pattern?: HolePattern
}

const near2 = (a: number, b: number, tol = HOLE_TOLERANCE) => Math.abs(a - b) <= tol

function sameSize(a: HoleSize, b: HoleSize): boolean {
  if (a.bottom !== b.bottom) return false
  if (!near2(a.diameter, b.diameter) || !near2(a.depth, b.depth) || !near2(a.top, b.top))
    return false
  if ((a.coneAngle === undefined) !== (b.coneAngle === undefined)) return false
  if (a.coneAngle !== undefined && !near2(a.coneAngle, b.coneAngle!, 1)) return false
  const ma = a.mouth
  const mb = b.mouth
  if ((ma === undefined) !== (mb === undefined)) return false
  if (ma !== undefined && mb !== undefined) {
    if (ma.type !== mb.type || !near2(ma.diameter, mb.diameter)) return false
    if (ma.type === 'countersink' && mb.type === 'countersink' && !near2(ma.angle, mb.angle, 1))
      return false
    if (ma.type === 'counterbore' && mb.type === 'counterbore' && !near2(ma.depth, mb.depth))
      return false
  }
  const sa = a.steps ?? []
  const sb = b.steps ?? []
  return (
    sa.length === sb.length &&
    sa.every((s, i) => near2(s.diameter, sb[i]!.diameter) && near2(s.depth, sb[i]!.depth))
  )
}

/** Distinct values within the tolerance, ascending (each the mean of its members). */
function clusters(xs: readonly number[]): number[] {
  const s = [...xs].sort((a, b) => a - b)
  const out: number[][] = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last !== undefined && x - last[0]! <= HOLE_TOLERANCE) last.push(x)
    else out.push([x])
  }
  return out.map((c) => c.reduce((a, b) => a + b, 0) / c.length)
}

/** Equal steps between consecutive values within the tolerance: the mean step, else undefined. */
function pitchOf(xs: readonly number[]): number | undefined {
  if (xs.length < 2) return 0
  const d = xs[1]! - xs[0]!
  for (let i = 1; i + 1 < xs.length; i++) if (!near2(xs[i + 1]! - xs[i]!, d)) return undefined
  return (xs[xs.length - 1]! - xs[0]!) / (xs.length - 1)
}

function gridOf(cs: readonly (readonly [number, number])[]): HolePattern | undefined {
  if (cs.length < 2) return undefined
  const us = clusters(cs.map((c) => c[0]))
  const vs = clusters(cs.map((c) => c[1]))
  if (us.length * vs.length !== cs.length) return undefined
  const du = pitchOf(us)
  const dv = pitchOf(vs)
  if (du === undefined || dv === undefined) return undefined
  // every crossing filled, each by one hole, on the regular grid
  const seen = new Set<string>()
  for (const c of cs) {
    const i = Math.round((c[0] - us[0]!) / (du || 1))
    const j = Math.round((c[1] - vs[0]!) / (dv || 1))
    if (!near2(c[0], us[0]! + i * du) || !near2(c[1], vs[0]! + j * dv)) return undefined
    seen.add(`${i},${j}`)
  }
  if (seen.size !== cs.length) return undefined
  return { kind: 'grid', origin: [us[0]!, vs[0]!], pitch: [du, dv], count: [us.length, vs.length] }
}

const deg = (rad: number) => (rad * 180) / Math.PI
const norm360 = (a: number) => ((a % 360) + 360) % 360

function circleOfCentres(cs: readonly (readonly [number, number])[]): HolePattern | undefined {
  const n = cs.length
  if (n < 3) return undefined
  // equal angles on a circle: the centroid is its centre
  const cu = cs.reduce((a, c) => a + c[0], 0) / n
  const cv = cs.reduce((a, c) => a + c[1], 0) / n
  const r = cs.reduce((a, c) => a + Math.hypot(c[0] - cu, c[1] - cv), 0) / n
  if (r < HOLE_TOLERANCE) return undefined
  if (!cs.every((c) => near2(Math.hypot(c[0] - cu, c[1] - cv), r))) return undefined
  const angles = cs.map((c) => norm360(deg(Math.atan2(c[1] - cv, c[0] - cu)))).sort((a, b) => a - b)
  const step = 360 / n
  const tolDeg = deg(HOLE_TOLERANCE / r)
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? angles[i + 1]! : angles[0]! + 360
    if (Math.abs(next - angles[i]! - step) > tolDeg) return undefined
  }
  return {
    kind: 'circle',
    center: [cu, cv],
    pitchDiameter: 2 * r,
    count: n,
    startAngle: angles[0]!,
  }
}

/** The holes in pattern order: grid from its origin by v, u; circle counter-clockwise from its start. */
function ordered(
  cs: readonly (readonly [number, number])[],
  p: HolePattern | undefined,
): (readonly [number, number])[] {
  if (p?.kind === 'circle') {
    const a = (c: readonly [number, number]) =>
      norm360(deg(Math.atan2(c[1] - p.center[1], c[0] - p.center[0])) - p.startAngle + 1e-6)
    return [...cs].sort((x, y) => a(x) - a(y))
  }
  return [...cs].sort((x, y) => (near2(x[1], y[1]) ? x[0] - y[0] : x[1] - y[1]))
}

/** Groups equal holes (see the file comment), largest diameters first; at most `HOLE_GROUPS_MAX`. */
export function holeGroups(holes: readonly MeshHole[]): { groups: HoleGroup[]; more?: number } {
  const raw: { size: HoleSize; centres: (readonly [number, number])[] }[] = []
  for (const h of holes) {
    const { center, ...size } = h
    const g = raw.find((x) => sameSize(x.size, size))
    if (g === undefined) raw.push({ size, centres: [center] })
    else g.centres.push(center)
  }
  raw.sort((a, b) => b.size.diameter - a.size.diameter || b.centres.length - a.centres.length)
  const groups = raw.slice(0, HOLE_GROUPS_MAX).map(({ size, centres }) => {
    const pattern = gridOf(centres) ?? circleOfCentres(centres)
    return {
      count: centres.length,
      holes: ordered(centres, pattern),
      size,
      ...(pattern === undefined ? {} : { pattern }),
    }
  })
  const left = raw.slice(HOLE_GROUPS_MAX).reduce((a, g) => a + g.centres.length, 0)
  return left > 0 ? { groups, more: left } : { groups }
}

/** Standard countersink angles (°): a measured one within 2° snaps to the nearest. */
export const CS_ANGLES = [82, 90, 100, 120] as const

/** A measured countersink angle snapped to the nearest standard one within 2°, else to 0.1°. */
export function csAngle(measured: number): number {
  const nearest = CS_ANGLES.reduce<number>(
    (best, a) => (Math.abs(a - measured) < Math.abs(best - measured) ? a : best),
    CS_ANGLES[0],
  )
  return Math.abs(nearest - measured) <= 2 ? nearest : Math.round(measured * 10) / 10
}

/** The fastener whose clearance (any fit) is within 0.1 mm of a diameter, nearest first. */
export function fastenerFor(
  diameter: number,
): { readonly size: string; readonly fit: FastenerFit } | undefined {
  let best: { size: string; fit: FastenerFit; off: number } | undefined
  for (const row of FASTENER_TABLE)
    for (const fit of ['normal', 'close', 'loose'] as const) {
      const off = Math.abs(row.clearance[fit] - diameter)
      if (off <= 0.1 + 1e-9 && (best === undefined || off < best.off - 1e-9))
        best = { size: row.size, fit, off }
    }
  return best === undefined ? undefined : { size: best.size, fit: best.fit }
}

/** "2.447 mm": a length read-out as a source (0.001 mm). */
export const mmSource = (mm: number): string => {
  const s = (Math.round(mm * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${s === '-0' ? '0' : s} mm`
}
const degSource = (d: number): string => {
  const s = (Math.round(d * 100) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${s}°`
}

export interface HoleSuggestion {
  readonly command: 'design.hole.add' | 'design.drilling.add'
  /** The first hole's args (no `partId`). */
  readonly args: Record<string, unknown>
  /** Further calls of the same command at the same centre (a stepped hole, narrower bands). */
  readonly also?: readonly Record<string, unknown>[]
  /** The Clones row for a pattern; its source is what the calls made. */
  readonly clones?: { readonly rows: readonly Record<string, unknown>[] }
  /** `belowFace`: a Bolt hole whose mouth is below the face (set `on` to the surface there). */
  readonly note?: 'belowFace'
}

/** The suggestion of a group read from `face` (a stock face id). */
export function holeSuggestion(group: HoleGroup, face: string): HoleSuggestion {
  const s = group.size
  const first = group.holes[0]!
  const center = [mmSource(first[0]), mmSource(first[1])]
  const clones =
    group.pattern?.kind === 'grid'
      ? {
          rows: [
            {
              kind: 'grid',
              cols: group.pattern.count[0],
              rows: group.pattern.count[1],
              du: mmSource(group.pattern.pitch[0]),
              dv: mmSource(group.pattern.pitch[1]),
            },
          ],
        }
      : group.pattern?.kind === 'circle'
        ? {
            rows: [
              {
                kind: 'arc',
                radius: mmSource(group.pattern.pitchDiameter / 2),
                angle: degSource(norm360(group.pattern.startAngle + 180)),
                arc: '360°',
                step: degSource(360 / group.pattern.count),
              },
            ],
          }
        : undefined
  const bottomArgs = (bottom: HoleBottom, depth: number, from = 0) =>
    bottom === 'through'
      ? { bottom: 'through' }
      : { bottom: bottom === 'cone' ? 'drillPoint' : 'flat', depth: mmSource(depth - from) }
  const withClones = <T extends object>(x: T) => (clones === undefined ? x : { ...x, clones })
  if (s.mouth !== undefined) {
    const below = s.top > 0.01
    const from = below ? s.top : 0
    const fast = fastenerFor(s.diameter)
    const head =
      s.mouth.type === 'countersink'
        ? {
            type: 'countersink',
            csDiameter: mmSource(s.mouth.diameter),
            csAngle: degSource(csAngle(s.mouth.angle)),
          }
        : {
            type: 'counterbore',
            cbDiameter: mmSource(s.mouth.diameter),
            cbDepth: mmSource(s.mouth.depth - from),
          }
    return withClones({
      command: 'design.hole.add' as const,
      args: {
        on: face,
        center,
        ...head,
        ...(fast === undefined ? {} : { fastener: fast.size, fit: fast.fit }),
        diameter: mmSource(s.diameter),
        ...bottomArgs(s.bottom, s.depth, from),
      },
      ...(below ? { note: 'belowFace' as const } : {}),
    })
  }
  const drilling = (diameter: number, bottom: HoleBottom, depth: number) => ({
    on: face,
    center,
    diameter: mmSource(diameter),
    ...bottomArgs(bottom, depth),
    ...(bottom === 'cone' && s.coneAngle !== undefined && Math.abs(s.coneAngle - 118) > 1
      ? { pointAngle: degSource(s.coneAngle) }
      : {}),
  })
  if (s.steps !== undefined && s.steps.length > 1) {
    const [head, ...rest] = s.steps.map((b, i) =>
      i === s.steps!.length - 1
        ? drilling(b.diameter, s.bottom, s.depth)
        : drilling(b.diameter, 'flat', b.depth),
    )
    return withClones({ command: 'design.drilling.add' as const, args: head!, also: rest })
  }
  return withClones({
    command: 'design.drilling.add' as const,
    args: drilling(s.diameter, s.bottom, s.depth),
  })
}
