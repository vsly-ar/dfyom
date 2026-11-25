/**
 * The narrowest web of a pattern (`dfm.patternThinWeb`, patterns P2): the cells are copies of one
 * cell, so the web between two cells depends only on their offset. Candidate offsets are the
 * lattice offsets (polar: the real neighbour pairs) whose centres are nearer than the cell's
 * circumscribed diameter plus the limit; the cell grown by the limit is intersected with each
 * moved cell, and the web of the hits is bisected. Inverted, the islands are the cells: their
 * rest material for a disc of half the limit (as edge chamfers' `chamferMeets`), the width
 * bisected. With `alternate: flip` (P5) each pair carries both cells' orientations. A port failure
 * gives no finding (the harmless side). Pure.
 * Doc: docs/modes/patterns.md#dfm, docs/modes/patterns.md#implementation-p2,
 * docs/modes/patterns.md#implementation-p5
 */
import type { Vec2 } from '../../geometry/model'
import { chainBounds, regionArea, type Region } from '../../geometry/2d/model'
import { translateRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import { findRestMaterial } from '../../geometry/2d/rest-material'

/** A web (or island) narrower than this (mm) is thin (patterns.md § Decided here: 1 mm). */
export const PATTERN_WEB_LIMIT = 1
/** The web is bisected to this (mm). */
const PRECISION = 0.01
/** Offsets measured at most. */
const CANDIDATES_MAX = 64

/** The narrowest web (or island width, `island`) under the limit, with a marker (face frame). */
export interface PatternWeb {
  /** mm. */
  readonly width: number
  readonly at: Vec2
  readonly island: boolean
}

export interface WebInput {
  /** The cell as placed at every node, its box centred on the origin. */
  readonly cell: Region
  /** P5 (`alternate: flip`): the cell turned 180°, placed at the nodes `flips` marks. */
  readonly flipped?: Region | undefined
  /** Parallel to `nodes`: true where the flipped cell sits (absent = none). */
  readonly flips?: readonly boolean[] | undefined
  /** Its circumscribed diameter about the origin. */
  readonly diameter: number
  /** Nodes of the whole cells (face frame). */
  readonly nodes: readonly Vec2[]
  readonly invert: boolean
  /** Row lattices: the pitches, half-pitch shift of odd rows and angle; undefined = polar. */
  readonly lattice: RowLattice | undefined
  /** The area's centre: markers go on the real cell nearest to it. */
  readonly centre: Vec2
}

/** A row lattice (square, staggered, hex): pitches, the odd rows' half-pitch shift, its angle. */
export interface RowLattice {
  readonly a: number
  readonly b: number
  readonly shifted: boolean
  readonly angle: number
  /** P5: every other cell (i + j odd) flipped. */
  readonly flip?: boolean | undefined
}

/** Two cells `off` apart: the first's orientation (`from`, 1 = flipped) and the second's (`to`). */
export interface LatticePair {
  readonly from: 0 | 1
  readonly to: 0 | 1
  readonly off: Vec2
}

const parity = (n: number): 0 | 1 => (((n % 2) + 2) % 2) as 0 | 1

/**
 * The offsets between cells of a row lattice within `nj` rows and `ni` columns, turned by its
 * angle, kept when `keep(dx, dy)` (unturned) holds. Without flip: from one node to the nodes of
 * one half plane (each pair once). With flip (P5) the neighbourhood depends on the parity of the
 * node's column and row, so from each of the four nodes (0|1, 0|1), with the orientations of
 * both cells; a pair and its reverse count once.
 */
export function latticePairs(
  l: RowLattice,
  ni: number,
  nj: number,
  keep: (dx: number, dy: number) => boolean,
): LatticePair[] {
  const r = (l.angle * Math.PI) / 180
  const [c, s] = [Math.cos(r), Math.sin(r)]
  const turn = (dx: number, dy: number): Vec2 => [c * dx - s * dy, s * dx + c * dy]
  const shift = (j: number) => (l.shifted && parity(j) === 1 ? l.a / 2 : 0)
  const out: LatticePair[] = []
  if (l.flip !== true) {
    for (let j = 0; j <= nj; j++)
      for (let i = -ni; i <= ni; i++) {
        const dx = i * l.a + shift(j)
        const dy = j * l.b
        if (j === 0 && dx <= 0) continue
        if (keep(dx, dy)) out.push({ from: 0, to: 0, off: turn(dx, dy) })
      }
    return out
  }
  const seen = new Set<string>()
  for (const j0 of [0, 1])
    for (const i0 of [0, 1])
      for (let dj = -nj; dj <= nj; dj++)
        for (let di = -ni; di <= ni; di++) {
          if (di === 0 && dj === 0) continue
          const dx = di * l.a + shift(j0 + dj) - shift(j0)
          const dy = dj * l.b
          if (!keep(dx, dy)) continue
          let from = parity(i0 + j0)
          let to = parity(i0 + di + j0 + dj)
          let [ux, uy] = [dx, dy]
          // a pair and its reverse are the same two cells
          if (uy < 0 || (uy === 0 && ux < 0)) [from, to, ux, uy] = [to, from, -ux, -uy]
          const k = `${from}${to}${key([ux, uy])}`
          if (seen.has(k)) continue
          seen.add(k)
          out.push({ from, to, off: turn(ux, uy) })
        }
  return out
}

const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1])
const key = (p: Vec2) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`

/**
 * The thin web or island of the pattern; undefined when none is under `limit` (mm; P3: twice a
 * chamfer's width, where the bevels of two cells, or of an island's sides, meet).
 */
export function patternWeb(
  port: Region2dPort,
  w: WebInput,
  limit = PATTERN_WEB_LIMIT,
): PatternWeb | undefined {
  if (w.nodes.length === 0) return undefined
  return w.invert ? island(port, w, limit) : web(port, w, limit)
}

function nearestNode(w: WebInput, ok: (n: Vec2) => boolean = () => true): Vec2 | undefined {
  let best: Vec2 | undefined
  for (const n of w.nodes)
    if (ok(n) && (best === undefined || dist(n, w.centre) < dist(best, w.centre))) best = n
  return best
}

function island(port: Region2dPort, w: WebInput, limit: number): PatternWeb | undefined {
  const rest = (r: number) => findRestMaterial(port, w.cell, r).unwrapOr([])
  const first = rest(limit / 2 - PRECISION / 2)
  if (first.length === 0) return undefined
  let lo = 0
  let hi = limit / 2
  while (hi - lo > PRECISION / 4) {
    const mid = (lo + hi) / 2
    if (rest(mid).length === 0) lo = mid
    else hi = mid
  }
  const n = nearestNode(w)!
  const at = first[0]!.at
  return { width: round(2 * lo), at: [n[0] + at[0], n[1] + at[1]], island: true }
}

/**
 * Pairs to measure: lattice pairs (both cells' orientations with flip), or the real neighbour
 * pairs (polar).
 */
function candidates(w: WebInput, limit: number): LatticePair[] {
  const reach = w.diameter + limit
  let out: LatticePair[] = []
  const l = w.lattice
  if (l !== undefined) {
    const nj = Math.ceil(reach / l.b) + 1
    const ni = Math.ceil(reach / l.a) + 1
    out = latticePairs(l, ni, nj, (dx, dy) => Math.hypot(dx, dy) < reach)
  } else {
    const grid = new Map<string, number[]>()
    const cellKey = (p: Vec2, dx = 0, dy = 0) =>
      `${Math.floor(p[0] / reach) + dx},${Math.floor(p[1] / reach) + dy}`
    w.nodes.forEach((n, i) => {
      const k = cellKey(n)
      const list = grid.get(k)
      if (list === undefined) grid.set(k, [i])
      else list.push(i)
    })
    const seen = new Set<string>()
    w.nodes.forEach((n, ni) => {
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const mi of grid.get(cellKey(n, dx, dy)) ?? []) {
            const m = w.nodes[mi]!
            const d: Vec2 = [m[0] - n[0], m[1] - n[1]]
            if (!(d[1] > 1e-9 || (Math.abs(d[1]) <= 1e-9 && d[0] > 1e-9))) continue
            const from = flipOf(w, ni)
            const to = flipOf(w, mi)
            const k = `${from}${to}${key(d)}`
            if (Math.hypot(d[0], d[1]) >= reach || seen.has(k)) continue
            seen.add(k)
            out.push({ from, to, off: d })
          }
    })
  }
  return out
    .sort((p, q) => Math.hypot(p.off[0], p.off[1]) - Math.hypot(q.off[0], q.off[1]))
    .slice(0, CANDIDATES_MAX)
}

const flipOf = (w: WebInput, i: number): 0 | 1 => (w.flips?.[i] === true ? 1 : 0)
const cellOf = (w: WebInput, o: 0 | 1): Region => (o === 1 ? (w.flipped ?? w.cell) : w.cell)

function web(port: Region2dPort, w: WebInput, limit: number): PatternWeb | undefined {
  const pairs = candidates(w, limit)
  if (pairs.length === 0) return undefined
  const grown = new Map<string, Region | undefined>()
  const grow = (d: number, o: 0 | 1): Region | undefined => {
    const k = `${o}:${d}`
    if (!grown.has(k)) {
      const g = port.offset(cellOf(w, o), -d)
      grown.set(k, g.isOk() ? g.unwrap() : undefined)
    }
    return grown.get(k)
  }
  const meets = (d: number, p: LatticePair): boolean => {
    const g = grow(d, p.from)
    if (g === undefined) return false
    const x = port.intersect(g, translateRegion(cellOf(w, p.to), p.off))
    return x.isOk() && x.unwrap().pieces.length > 0 && regionArea(x.unwrap()) > 1e-12
  }
  // only pairs a real pair of cells has
  const nodes = new Set(w.nodes.map((n, i) => `${flipOf(w, i)}${key(n)}`))
  const flips = new Map(w.nodes.map((n, i) => [n, flipOf(w, i)] as const))
  const real = (p: LatticePair) =>
    nearestNode(
      w,
      (n) =>
        flips.get(n) === p.from && nodes.has(`${p.to}${key([n[0] + p.off[0], n[1] + p.off[1]])}`),
    )
  let hits = pairs.filter((p) => meets(limit - PRECISION / 2, p))
  hits = hits.filter((p) => real(p) !== undefined)
  if (hits.length === 0) return undefined
  let lo = 0
  let hi = limit - PRECISION / 2
  let narrowest = hits[0]!
  while (hi - lo > PRECISION / 2) {
    const mid = (lo + hi) / 2
    const hit = hits.find((p) => meets(mid, p))
    if (hit === undefined) lo = mid
    else {
      hi = mid
      narrowest = hit
    }
  }
  // the marker: between the real pair nearest the centre, at the overlap of the grown cell
  const n = real(narrowest)!
  const off = narrowest.off
  const g = grow(hi, narrowest.from)
  const x =
    g === undefined ? undefined : port.intersect(g, translateRegion(cellOf(w, narrowest.to), off))
  const b =
    x === undefined || x.isErr()
      ? undefined
      : chainBounds(x.unwrap().pieces.flatMap((p) => p.outer.elements))
  const len = Math.hypot(off[0], off[1])
  const q: Vec2 =
    b === undefined
      ? [off[0] / 2, off[1] / 2]
      : [
          (b.min[0] + b.max[0]) / 2 - (off[0] / len) * (hi / 2),
          (b.min[1] + b.max[1]) / 2 - (off[1] / len) * (hi / 2),
        ]
  return { width: round(lo), at: [n[0] + q[0], n[1] + q[1]], island: false }
}

const round = (x: number) => Math.round(x * 100) / 100
