/**
 * Half laps on split lines (split parts 4d): per pair of pieces across a line in a band, the
 * male (lower) piece keeps the bottom half over a lap of length ℓ centred on the line, the female
 * the top half. The outline regions grow over the lap (the male's ℓ/2 past the line, the
 * female's ℓ/2 − clearance back), and generated pockets take the halves off: the male's from its
 * top, the female's from its bottom (a flip). The lap must be clear of every removal. Pure.
 * Doc: docs/modes/split-parts.md#implementation-4d
 */
import type { Bounds2 } from '../../geometry/2d/model'
import { STOCK_FACE } from '../../geometry/face'
import type { OperationDTO, SplitDTO } from '../part.dto'
import { EPS, type Cell, type Layout, type Rect } from './layout'
import { keyClearance, KEY_NECK_MIN, type KeyIssue } from './keys'
import { materialAt, type Removal } from './removals'

/** One half lap between two pieces of a band, on the line `axis` = `at`. */
export interface Lap {
  readonly axis: 'x' | 'y'
  readonly at: number
  /** The lower piece along the axis: keeps the bottom half, cut from its top. */
  readonly male: Cell
  /** The upper piece: keeps the top half, cut from its bottom (a flip). */
  readonly female: Cell
  /** ℓ: the overlap across the line (mm), centred on it. */
  readonly length: number
  readonly clearance: number
  /** The lap plane (part-frame z): the middle of the band between the facings. */
  readonly plane: number
  /** The pieces' extent along the line (mm): the pockets run out past both ends. */
  readonly lo: number
  readonly hi: number
  /** The outline's tool Ø (mm): sizes the lap and the pockets' run-out. */
  readonly tool: number
}

/** Sampling steps (mm) along the line and across it. */
const STEP_U = 1
const STEP_W = 1

/** ℓ for a band of `height` between the facings: max(10 mm, 3 × tool Ø, 2 × height), 0.5 mm up. */
export const lapLength = (tool: number, height: number): number =>
  Math.ceil(Math.max(KEY_NECK_MIN, 3 * tool, 2 * height) * 2 - 1e-9) / 2

/**
 * A lap pocket's run-out past the lap's far end and the pieces' ends (mm): more than its corner
 * radius (tool radius + 0.5 mm), so the rounded corners stay outside the piece.
 */
const runOut = (tool: number) => tool / 2 + 1

const toPart = (axis: 'x' | 'y', at: number, u: number, w: number): [number, number] =>
  axis === 'x' ? [at + w, u] : [u, at + w]

const inRect = (r: Rect, p: readonly [number, number]) =>
  p[0] >= r.x0 - EPS && p[0] <= r.x1 + EPS && p[1] >= r.y0 - EPS && p[1] <= r.y1 + EPS

/**
 * The half laps of a split whose lines are `halfLap`: per line, per pair of pieces across it in
 * a band (between the part's facings `top` and `bottom`), clear of every removal over the lap and
 * a tool Ø around it; else a `near` issue and a butt joint there.
 */
export function planLaps(
  layout: Layout,
  split: SplitDTO,
  rs: readonly Removal[],
  W: number,
  tool: number,
  top: number,
  bottom: number,
): { readonly laps: Lap[]; readonly issues: KeyIssue[] } {
  if (split.joint.kind !== 'halfLap') return { laps: [], issues: [] }
  const c = keyClearance(split)
  const fp = layout.footprint.region
  const laps: Lap[] = []
  const issues: KeyIssue[] = []
  const seen = new Set<string>()
  for (const l of split.lines) {
    const axis = l.axis
    const at = Number(BigInt(l.at.exact.num)) / Number(BigInt(l.at.exact.den))
    if (seen.has(`${axis}:${at}`)) continue
    seen.add(`${axis}:${at}`)
    for (const male of layout.cells) {
      if (Math.abs((axis === 'x' ? male.rect.x1 : male.rect.y1) - at) > EPS) continue
      const female = layout.cells.find(
        (f) =>
          f.iz === male.iz &&
          (axis === 'x'
            ? f.iy === male.iy && Math.abs(f.rect.x0 - at) <= EPS
            : f.ix === male.ix && Math.abs(f.rect.y0 - at) <= EPS),
      )
      if (female === undefined) continue
      const zb = Math.max(male.band.zb, bottom)
      const zt = Math.min(male.band.zt, top)
      if (zt - zb <= EPS) continue
      const height = zt - zb
      const length = lapLength(tool, height)
      const k = (b: Bounds2) => (axis === 'x' ? [b.min[1], b.max[1]] : [b.min[0], b.max[0]])
      const [lo, hi] = [
        Math.min(k(male.bounds)[0]!, k(female.bounds)[0]!),
        Math.max(k(male.bounds)[1]!, k(female.bounds)[1]!),
      ] as [number, number]
      const zBreaks = [zb, ...new Set(rs.flatMap((r) => [r.zlo, r.zhi]))]
        .filter((z) => z >= zb - EPS && z <= zt + EPS)
        .concat([zt])
        .sort((p, q) => p - q)
      const zs = zBreaks
        .slice(1)
        .flatMap((z, i) => (z - zBreaks[i]! > EPS ? [(z + zBreaks[i]!) / 2] : []))
      // the lap and a tool Ø around it: inside the two cells and solid through the band
      const reach = length / 2 + c + tool
      let clear = true
      for (let u = lo; u <= hi + EPS && clear; u += STEP_U)
        for (let w = -reach; w <= reach + EPS; w += STEP_W) {
          const p = toPart(axis, at, Math.min(u, hi), w)
          if (!materialAt(fp, [], 0, p[0], p[1], 0)) continue
          if (
            !inRect(w < 0 ? male.rect : female.rect, p) ||
            !zs.every((z) => materialAt(fp, rs, W, p[0], p[1], z))
          ) {
            clear = false
            break
          }
        }
      if (!clear) {
        issues.push({ axis, at, male, female, run: [lo, hi], reason: 'near', tool, height })
        continue
      }
      laps.push({
        axis,
        at,
        male,
        female,
        length,
        clearance: c,
        plane: (zt + zb) / 2,
        lo,
        hi,
        tool,
      })
    }
  }
  return { laps, issues }
}

/** The cell's rectangle grown over its laps: the male's ℓ/2 past the line, the female's back. */
export function lapRect(cell: Cell, laps: readonly Lap[]): Rect {
  let { x0, x1, y0, y1 } = cell.rect
  for (const l of laps) {
    if (l.male === cell) {
      if (l.axis === 'x') x1 = l.at + l.length / 2
      else y1 = l.at + l.length / 2
    }
    if (l.female === cell) {
      if (l.axis === 'x') x0 = l.at - l.length / 2 + l.clearance
      else y0 = l.at - l.length / 2 + l.clearance
    }
  }
  return { x0, x1, y0, y1 }
}

/** The cell's bounds grown over its laps, within `limit` (the footprint's bounds). */
export function lapBounds(cell: Cell, laps: readonly Lap[], limit: Bounds2): Bounds2 {
  const r = lapRect(cell, laps)
  const b = cell.bounds
  return {
    min: [
      r.x0 < cell.rect.x0 ? Math.max(r.x0, limit.min[0]) : b.min[0],
      r.y0 < cell.rect.y0 ? Math.max(r.y0, limit.min[1]) : b.min[1],
    ],
    max: [
      r.x1 > cell.rect.x1 ? Math.min(r.x1, limit.max[0]) : b.max[0],
      r.y1 > cell.rect.y1 ? Math.min(r.y1, limit.max[1]) : b.max[1],
    ],
  }
}

/**
 * The lap pockets of a piece (`<splitId>_lap<k>`, "Half lap k"): on the male from its top down
 * to the lap plane over the lap plus a run-out past its far end, on the female from its bottom
 * up to the plane over the lap, the clearance and a run-out back; both run out past the pieces'
 * ends along the line, so the shoulders go edge to edge.
 */
export function lapOperations(
  laps: readonly Lap[],
  cell: Cell,
  splitId: string,
  offset: readonly [number, number, number],
  blankWidth: number,
  length: (mm: number) => Extract<OperationDTO, { kind: 'pocket' }>['depth'],
  /** Blank thickness above the piece (4c): a pocket from the top goes that much deeper. */
  surplus = 0,
): OperationDTO[] {
  const out: OperationDTO[] = []
  for (const l of laps) {
    const male = l.male === cell
    if (!male && l.female !== cell) continue
    const e = runOut(l.tool)
    const h = l.length / 2
    const [w0, w1] = male ? [-h, h + e] : [-h - e, h + l.clearance]
    const [u0, u1] = [l.lo - e, l.hi + e]
    const a = toPart(l.axis, l.at, u0, w0)
    const b = toPart(l.axis, l.at, u1, w1)
    const x0 = Math.min(a[0], b[0]) + offset[0]
    const x1 = Math.max(a[0], b[0]) + offset[0]
    const y0 = Math.min(a[1], b[1]) + offset[1]
    const y1 = Math.max(a[1], b[1]) + offset[1]
    const cy = male ? (y0 + y1) / 2 : blankWidth - (y0 + y1) / 2
    const k = out.length + 1
    out.push({
      kind: 'pocket',
      id: `${splitId}_lap${k}`,
      name: `Half lap ${k}`,
      on: STOCK_FACE[male ? '+z' : '-z'],
      shape: {
        kind: 'rectangle',
        center: [length((x0 + x1) / 2), length(cy)],
        length: length(x1 - x0),
        width: length(y1 - y0),
        // the corners lie outside the piece (within the run-out): round them for the tool
        cornerRadius: length(l.tool / 2 + 0.5),
      },
      depth: length(male ? cell.band.zt - l.plane + surplus : l.plane - cell.band.zb),
      floorRadius: length(0),
    })
  }
  return out
}
