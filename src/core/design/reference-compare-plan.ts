/**
 * The simulated cut against the reference (v0.4 follow-up V3): per setup direction the cut map
 * of the plan's toolpaths (`simulateHeightmap`) minus the reference map (`referenceHeightmaps`),
 * cell by cell, reduced to statistics outside the edge band and at most `PLAN_REGIONS_MAX`
 * regions with their causes and operations (DV-C, DV-D). Pure and headless: the
 * `design.reference.compare { source: { kind: 'plan' } }` job feeds it the two workers' maps.
 * Doc: docs/modes/deviation.md#result, #implementation-v3
 *
 * Deviation = cut − reference height (face frame): positive = material left (under-cut),
 * negative = cut too deep (over-cut).
 */
import {
  faceToFace,
  localStock,
  oppositeDirection,
  STOCK_FACE,
  type Direction,
  type StockSize,
} from '../geometry/face'
import type { Vec2 } from '../geometry/model'
import type { ToolpathTool } from '../toolpath/model'
import type { CutMap, SimulateInput } from '../toolpath/simulate'
import { fromWcs, setupWcs } from '../toolpath/wcs'
import type { ReferenceMap } from './reference-compare'

/** Regions in the result at most (Q43). */
export const PLAN_REGIONS_MAX = 20
/** The result's JSON at most (bytes): regions past it go to `more`. */
export const PLAN_RESULT_BYTES_MAX = 5_000
/** The domain: reference material in the column, grown by this (mm). */
export const DOMAIN_GROW_MM = 1
/** Regions deeper than this need a cause (Q44, mm). */
export const EXPLAIN_OVER_MM = 0.5

/** What the plan knows about the operation of each toolpath (index = `CutMap.by` − 1). */
export interface CutOwner {
  /** The plan operation id. */
  readonly operationId: string
  /** The tool radius (mm). */
  readonly toolRadius: number
  /** A profile that leaves tabs. */
  readonly tabs: boolean
}

/** A drilled hole (a drill cycle's point) in a direction's face frame (mm). */
export interface CutHole {
  readonly direction: Direction
  readonly at: Vec2
  readonly diameter: number
  /** The height of the drill's point cone (mm; 0 for a flat end). */
  readonly point: number
}

/** Material a keep-out leaves (`plan.workholding.unmachined`), face frame bounds (mm). */
export interface CutKeepOut {
  readonly direction: Direction
  readonly bounds: readonly [Vec2, Vec2]
}

export interface PlanCompareInput {
  readonly stock: StockSize
  readonly threshold: number
  readonly reference: readonly ReferenceMap[]
  readonly cut: readonly CutMap[]
  readonly owners: readonly CutOwner[]
  readonly holes?: readonly CutHole[] | undefined
  readonly keepOut?: readonly CutKeepOut[] | undefined
  /** Regions listed at most (≤ `PLAN_REGIONS_MAX`). */
  readonly limit?: number | undefined
}

export type PlanCause = 'toolRadius' | 'workholding' | 'holeMouth' | 'drillPoint' | 'tab'

export interface PlanRegion {
  /** The stock face looked from (`stock.top`). */
  readonly face: string
  /** Face frame [u, v] (mm), cell edges. */
  readonly bounds: [[number, number], [number, number]]
  readonly area: number
  readonly volume: number
  readonly maxDev: number
  readonly sign: 'undercut' | 'overcut'
  /** Depths below the face of the cut and reference surfaces over the region (mm). */
  readonly depthRange: [number, number]
  readonly cause?: PlanCause
  /** The plan operation whose toolpath cut the region (or its neighbourhood). */
  readonly operationId?: string
}

export interface PlanStats {
  /** Cells compared (in the domain, off the edge band). */
  readonly cells: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly overcutMax: number
  readonly undercutMax: number
  /** Area of the compared cells beyond the threshold (mm²). */
  readonly areaOver: number
}

export interface PlanCompareResult {
  readonly source: 'plan'
  readonly method: 'heightmap'
  readonly cell: number
  readonly threshold: number
  readonly stats: PlanStats
  /** Per face, the same statistics (Q44 is measured per setup direction). */
  readonly faces: (PlanStats & { readonly face: string })[]
  /** Areas left out of the statistics (mm²). */
  readonly excluded: { readonly outsidePart: number; readonly edgeBand: number }
  /** Largest volume first. */
  readonly regions: PlanRegion[]
  readonly more?: number
  /** Regions deeper than `EXPLAIN_OVER_MM` without a cause, listed or not (Q44: 0). */
  readonly unexplained: number
}

const r3 = (x: number) => Math.round(x * 1000) / 1000 || 0

/** The value at quantile `f` of ascending `sorted`. */
const quantile = (sorted: Float64Array, f: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!

function statsOf(devs: number[], over: number, area: number): PlanStats {
  const abs = Float64Array.from(devs, Math.abs).sort()
  let sum = 0
  let under = 0
  let overcut = 0
  for (const d of devs) {
    sum += Math.abs(d)
    if (d > under) under = d
    if (-d > overcut) overcut = -d
  }
  return {
    cells: devs.length,
    mean: r3(devs.length === 0 ? 0 : sum / devs.length),
    p50: r3(quantile(abs, 0.5)),
    p95: r3(quantile(abs, 0.95)),
    p99: r3(quantile(abs, 0.99)),
    max: r3(abs.length === 0 ? 0 : abs[abs.length - 1]!),
    overcutMax: r3(overcut),
    undercutMax: r3(under),
    areaOver: r3(over * area),
  }
}

/** A region before its cause, with what the causes read. */
interface RawRegion {
  readonly direction: Direction
  readonly cells: number[]
  readonly sign: 1 | -1
  readonly i0: number
  readonly i1: number
  readonly j0: number
  readonly j1: number
  readonly volume: number
  readonly maxDev: number
  readonly w0: number
  readonly w1: number
}

/** One direction's maps, with the masks the causes share. */
interface Maps {
  readonly direction: Direction
  readonly nu: number
  readonly nv: number
  readonly cell: number
  readonly ref: Float32Array
  readonly cut: Float32Array
  readonly by: Uint16Array
  /** The reference height with an empty column at the stock bottom. */
  readonly refAt: (c: number) => number
  /** The cell of the opposite direction's maps on the same column (−1: none). */
  readonly across: (c: number) => number
  /** The opposite direction's `by`, when it was cut. */
  readonly byAcross?: Uint16Array | undefined
}

/**
 * The cell of `to`'s grid on the column of cell `c` of `from`'s (opposite faces; −1 off the grid).
 */
function columnMap(
  from: Direction,
  to: Direction,
  stock: StockSize,
  g: { nu: number; nv: number; cell: number },
): (c: number) => number {
  const { m, t } = faceToFace(from, to, stock)
  const { nu, nv, cell } = g
  return (c) => {
    const i = c % nu
    const u = (i + 0.5) * cell
    const v = ((c - i) / nu + 0.5) * cell
    const ii = Math.floor((m[0][0] * u + m[0][1] * v + t[0]) / cell)
    const jj = Math.floor((m[1][0] * u + m[1][1] * v + t[1]) / cell)
    return ii < 0 || jj < 0 || ii >= nu || jj >= nv ? -1 : jj * nu + ii
  }
}

/**
 * Columns cut through from the opposite face (V3's one piece of in-process stock): where the
 * material one face leaves lies wholly above what the opposite face's cut left, the column is
 * empty, so both maps read the stock bottom there. Without it an outline cut through from the
 * top would show, from the bottom, as material left beside every bottom step.
 */
function throughColumns(cut: readonly CutMap[], stock: StockSize): Map<Direction, Float32Array> {
  const out = new Map<Direction, Float32Array>(cut.map((m) => [m.direction, m.h.slice()]))
  for (const a of cut) {
    const b = cut.find((m) => m.direction === oppositeDirection(a.direction))
    if (b === undefined || a.direction > b.direction) continue
    if (a.nu * a.nv !== b.nu * b.nv) continue
    const T = localStock(a.direction, stock).thickness
    const across = columnMap(a.direction, b.direction, stock, a)
    const ha = out.get(a.direction)!
    const hb = out.get(b.direction)!
    for (let c = 0; c < ha.length; c++) {
      const k = across(c)
      // a's material spans w ∈ [−T − h_b, h_a] in a's frame
      if (k < 0 || a.h[c]! > -T - b.h[k]! + 1e-6) continue
      ha[c] = -T
      hb[k] = -T
    }
  }
  return out
}

/**
 * The compare (deviation.md § Height map method): per direction, the domain (reference material
 * grown by `DOMAIN_GROW_MM`), the edge band (a reference step over the threshold to any of the 8
 * neighbours, an empty column counting as the stock bottom), the statistics of |dev| over the
 * rest, and 4-connected regions of one sign beyond the threshold.
 */
export function comparePlanMaps(input: PlanCompareInput): PlanCompareResult {
  const { threshold } = input
  const cell = input.cut[0]?.cell ?? input.reference[0]?.cell ?? 0.5
  const area = cell * cell
  const all: number[] = []
  let overAll = 0
  const faces: (PlanStats & { face: string })[] = []
  let outsidePart = 0
  let edgeBand = 0
  const raw: RawRegion[] = []
  const maps: Maps[] = []
  const through = throughColumns(input.cut, input.stock)
  for (const map of input.cut) {
    const cut = { ...map, h: through.get(map.direction)! }
    const back = input.cut.find((q) => q.direction === oppositeDirection(map.direction))
    const ref = input.reference.find((r) => r.direction === cut.direction)
    if (ref === undefined || ref.nu !== cut.nu || ref.nv !== cut.nv) continue
    const { nu, nv } = cut
    const floor = -localStock(cut.direction, input.stock).thickness
    const refAt = (c: number) => {
      const v = ref.h[c]!
      return Number.isNaN(v) ? floor : v
    }
    const m: Maps = {
      direction: cut.direction,
      nu,
      nv,
      cell,
      ref: ref.h,
      cut: cut.h,
      by: cut.by,
      refAt,
      across:
        back === undefined || back.nu * back.nv !== nu * nv
          ? () => -1
          : columnMap(cut.direction, back.direction, input.stock, cut),
      byAcross: back?.by,
    }
    maps.push(m)
    const n = nu * nv
    const grow = Math.ceil(DOMAIN_GROW_MM / cell - 1e-9)
    const domain = new Uint8Array(n)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        if (Number.isNaN(ref.h[j * nu + i]!)) continue
        for (let jj = Math.max(0, j - grow); jj <= Math.min(nv - 1, j + grow); jj++)
          domain.fill(1, jj * nu + Math.max(0, i - grow), jj * nu + Math.min(nu - 1, i + grow) + 1)
      }
    const dev = new Float64Array(n)
    const sign = new Int8Array(n)
    const devs: number[] = []
    let over = 0
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const c = j * nu + i
        if (domain[c] === 0) {
          outsidePart += area
          continue
        }
        const r = refAt(c)
        let edge = false
        for (let dj = -1; dj <= 1 && !edge; dj++)
          for (let di = -1; di <= 1 && !edge; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii < 0 || jj < 0 || ii >= nu || jj >= nv) continue
            if (Math.abs(refAt(jj * nu + ii) - r) > threshold) edge = true
          }
        if (edge) {
          edgeBand += area
          continue
        }
        const d = cut.h[c]! - r
        dev[c] = d
        devs.push(d)
        if (Math.abs(d) >= threshold) {
          sign[c] = d > 0 ? 1 : -1
          over++
        }
      }
    faces.push({ face: STOCK_FACE[cut.direction], ...statsOf(devs, over, area) })
    for (const d of devs) all.push(d)
    overAll += over
    // regions: 4-connected cells of one sign
    const seen = new Uint8Array(n)
    for (let s0 = 0; s0 < n; s0++) {
      if (sign[s0] === 0 || seen[s0] === 1) continue
      const sg = sign[s0]! as 1 | -1
      const queue = [s0]
      const cells: number[] = []
      seen[s0] = 1
      let volume = 0
      let maxDev = 0
      let i0 = nu,
        i1 = -1,
        j0 = nv,
        j1 = -1,
        w0 = Infinity,
        w1 = -Infinity
      while (queue.length > 0) {
        const c = queue.pop()!
        cells.push(c)
        const i = c % nu
        const j = (c - i) / nu
        const d = Math.abs(dev[c]!)
        volume += d * area
        if (d > maxDev) maxDev = d
        i0 = Math.min(i0, i)
        i1 = Math.max(i1, i)
        j0 = Math.min(j0, j)
        j1 = Math.max(j1, j)
        w0 = Math.min(w0, cut.h[c]!, refAt(c))
        w1 = Math.max(w1, cut.h[c]!, refAt(c))
        for (const cc of [i > 0 ? c - 1 : -1, i < nu - 1 ? c + 1 : -1, c - nu, c + nu]) {
          if (cc < 0 || cc >= n || seen[cc] === 1 || sign[cc] !== sg) continue
          seen[cc] = 1
          queue.push(cc)
        }
      }
      raw.push({
        direction: cut.direction,
        cells,
        sign: sg,
        i0,
        i1,
        j0,
        j1,
        volume,
        maxDev,
        w0,
        w1,
      })
    }
  }
  raw.sort((a, b) => b.volume - a.volume)
  const regions: PlanRegion[] = []
  let unexplained = 0
  for (const x of raw) {
    const m = maps.find((q) => q.direction === x.direction)!
    const owner = ownerOf(m, x, input.owners)
    const cause = causeOf(m, x, owner, input, threshold)
    if (cause === undefined && x.maxDev > EXPLAIN_OVER_MM) unexplained++
    regions.push({
      face: STOCK_FACE[x.direction],
      bounds: [
        [r3(x.i0 * cell), r3(x.j0 * cell)],
        [r3((x.i1 + 1) * cell), r3((x.j1 + 1) * cell)],
      ],
      area: r3(x.cells.length * area),
      volume: r3(x.volume),
      maxDev: r3(x.maxDev),
      sign: x.sign > 0 ? 'undercut' : 'overcut',
      depthRange: [r3(-x.w1), r3(-x.w0)],
      ...(cause === undefined ? {} : { cause }),
      ...(owner === undefined ? {} : { operationId: owner.operationId }),
    })
  }
  const limit = Math.min(PLAN_REGIONS_MAX, input.limit ?? PLAN_REGIONS_MAX)
  const result: PlanCompareResult = {
    source: 'plan',
    method: 'heightmap',
    cell,
    threshold,
    stats: statsOf(all, overAll, area),
    faces,
    excluded: { outsidePart: r3(outsidePart), edgeBand: r3(edgeBand) },
    regions: regions.slice(0, limit),
    unexplained,
  }
  return capped(result, regions.length)
}

/** The result with regions dropped from the end until its JSON fits `PLAN_RESULT_BYTES_MAX`. */
function capped(r: PlanCompareResult, total: number): PlanCompareResult {
  let shown = r.regions.length
  const withShown = (k: number): PlanCompareResult => {
    const { more: _, ...rest } = r
    return { ...rest, regions: r.regions.slice(0, k), ...(total > k ? { more: total - k } : {}) }
  }
  let out = withShown(shown)
  while (shown > 0 && JSON.stringify(out).length > PLAN_RESULT_BYTES_MAX) out = withShown(--shown)
  return out
}

/**
 * The operation of a region: the toolpath that last cut most of its cells; for a region no
 * toolpath touched (material left beside a cut), the one that cut most cells within a tool
 * radius around it (`maxRadius` of the owners).
 */
function ownerOf(m: Maps, x: RawRegion, owners: readonly CutOwner[]): CutOwner | undefined {
  const count = new Map<number, number>()
  for (const c of x.cells) {
    const b = m.by[c]!
    if (b > 0) count.set(b, (count.get(b) ?? 0) + 1)
  }
  if (count.size === 0) {
    const reach = Math.ceil(Math.max(0, ...owners.map((o) => o.toolRadius)) / m.cell) + 1
    for (let j = Math.max(0, x.j0 - reach); j <= Math.min(m.nv - 1, x.j1 + reach); j++)
      for (let i = Math.max(0, x.i0 - reach); i <= Math.min(m.nu - 1, x.i1 + reach); i++) {
        const b = m.by[j * m.nu + i]!
        if (b > 0) count.set(b, (count.get(b) ?? 0) + 1)
      }
  }
  let best = 0
  let most = 0
  for (const [b, k] of count)
    if (k > most) {
      best = b
      most = k
    }
  return best === 0 ? undefined : owners[best - 1]
}

/**
 * Why a region deviates, when the plan knows (DV-D), first match:
 * - `workholding`: it overlaps material a keep-out leaves (`plan.workholding.unmachined`);
 * - `holeMouth`: material left within `HOLE_MOUTH_REACH` hole diameters of a drilled hole's
 *   centre (a countersink or counterbore the design does not model, or the drill point);
 * - `tab`: material left wholly outside the reference's columns by a profile with tabs;
 * - `toolRadius`: material left within the tool radius of a reference wall (every cell), no wider
 *   than the tool's diameter, beside cells the same operation cut down to the region's
 *   reference: an inside corner or step the tool is too big for.
 */
function causeOf(
  m: Maps,
  x: RawRegion,
  owner: CutOwner | undefined,
  input: PlanCompareInput,
  threshold: number,
): PlanCause | undefined {
  const c = m.cell
  const u0 = x.i0 * c,
    u1 = (x.i1 + 1) * c,
    v0 = x.j0 * c,
    v1 = (x.j1 + 1) * c
  for (const k of input.keepOut ?? []) {
    if (k.direction !== x.direction) continue
    const [a, b] = k.bounds
    if (u0 <= b[0] + c && u1 >= a[0] - c && v0 <= b[1] + c && v1 >= a[1] - c) return 'workholding'
  }
  const centre = (cc: number): Vec2 => {
    const i = cc % m.nu
    return [(i + 0.5) * c, ((cc - i) / m.nu + 0.5) * c]
  }
  const within = (at: Vec2, reach: number) =>
    x.cells.every((cc) => Math.hypot(...sub(centre(cc), at)) <= reach)
  if (x.sign < 0) {
    // the drill's cone where the reference's hole bottom is flatter or shallower
    for (const h of input.holes ?? [])
      if (
        h.direction === x.direction &&
        h.point > 0 &&
        x.maxDev <= h.point + 1e-3 &&
        within(h.at, h.diameter / 2 + c)
      )
        return 'drillPoint'
    return undefined
  }
  for (const h of input.holes ?? [])
    if (h.direction === x.direction && within(h.at, HOLE_MOUTH_REACH * h.diameter + c))
      return 'holeMouth'
  if (x.cells.every((cc) => Number.isNaN(m.ref[cc]!))) {
    // material outside the part held by a tab, cut from this face or the opposite one
    const tabbed = (b: number | undefined) =>
      b !== undefined && b > 0 && input.owners[b - 1]?.tabs === true
    if (
      x.cells.some(
        (cc) =>
          tabbed(m.by[cc]) ||
          (m.byAcross !== undefined && m.across(cc) >= 0 && tabbed(m.byAcross[m.across(cc)])),
      )
    )
      return 'tab'
  }
  if (owner === undefined) return undefined
  const R = owner.toolRadius
  if (R <= 0 || Math.max(u1 - u0, v1 - v0) > 2 * R + c) return undefined
  const reach = Math.ceil(R / c) + 1
  const nearWall = (cc: number): boolean => {
    const i = cc % m.nu
    const j = (cc - i) / m.nu
    const level = m.refAt(cc) + threshold
    for (let jj = Math.max(0, j - reach); jj <= Math.min(m.nv - 1, j + reach); jj++)
      for (let ii = Math.max(0, i - reach); ii <= Math.min(m.nu - 1, i + reach); ii++)
        if (Math.hypot(ii - i, jj - j) * c <= R + c && m.refAt(jj * m.nu + ii) > level) return true
    return false
  }
  if (!x.cells.every(nearWall)) return undefined
  // and the operation cut down to the region's reference beside it: a hole or step the plan
  // never cuts is not the tool's radius
  const floor = Math.min(...x.cells.map((cc) => m.refAt(cc))) + threshold
  const index = input.owners.indexOf(owner) + 1
  for (let j = Math.max(0, x.j0 - reach); j <= Math.min(m.nv - 1, x.j1 + reach); j++)
    for (let i = Math.max(0, x.i0 - reach); i <= Math.min(m.nu - 1, x.i1 + reach); i++) {
      const cc = j * m.nu + i
      if (m.by[cc] === index && m.cut[cc]! <= floor) return 'toolRadius'
    }
  return undefined
}

/** A hole's mouth reaches this many hole diameters from its centre. */
export const HOLE_MOUTH_REACH = 2

const sub = (a: Vec2, b: Vec2): [number, number] => [a[0] - b[0], a[1] - b[1]]

/**
 * The holes a plan drills, in each direction's face frame: every drill cycle's point, and every
 * vertical plunge of a drill (a program read back from G-code has no cycles).
 */
export function cutHoles(input: SimulateInput): CutHole[] {
  const out: CutHole[] = []
  for (const s of input.setups) {
    const wcs = setupWcs(s.direction, s.rotation, input.stock, s.zero)
    const face = (q: Vec2): Vec2 => (wcs === undefined ? [q[0], q[1]] : fromWcs(q, wcs))
    for (const { tool, toolpath } of s.toolpaths)
      for (const pass of toolpath.passes) {
        let at: readonly number[] | undefined
        for (const mv of pass.moves) {
          if (mv.kind === 'drill') {
            out.push({ direction: s.direction, at: face(mv.at), ...holeTool(tool) })
            at = [mv.at[0], mv.at[1], mv.retract]
            continue
          }
          const plunge =
            tool.type === 'drill' &&
            mv.kind === 'line' &&
            at !== undefined &&
            Math.abs(mv.to[0] - at[0]!) < 1e-6 &&
            Math.abs(mv.to[1] - at[1]!) < 1e-6 &&
            mv.to[2] < at[2]! - 1e-6
          if (plunge) {
            const p = face([mv.to[0], mv.to[1]])
            const known = out.some(
              (h) => h.direction === s.direction && Math.hypot(...sub(h.at, p)) < 1e-3,
            )
            if (!known) out.push({ direction: s.direction, at: p, ...holeTool(tool) })
          }
          at = mv.to
        }
      }
  }
  return out
}

/** A drill's diameter and the height of its point cone (mm). */
function holeTool(tool: ToolpathTool): { diameter: number; point: number } {
  const angle = tool.type === 'drill' ? (tool.pointAngle ?? 180) : 180
  const half = (angle * Math.PI) / 360
  const point = half >= Math.PI / 2 - 1e-9 ? 0 : tool.diameter / 2 / Math.tan(half)
  return { diameter: tool.diameter, point }
}
