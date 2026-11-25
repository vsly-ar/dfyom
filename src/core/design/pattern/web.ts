/**
 * The narrowest web of a pattern (`dfm.patternThinWeb`, patterns P2): the cells are copies of one
 * cell, so the web between two cells depends only on their offset. Candidate offsets are the
 * lattice offsets (polar: the real neighbour pairs) whose centres are nearer than the cell's
 * circumscribed diameter plus the limit; the cell grown by the limit is intersected with each
 * moved cell, and the web of the hits is bisected. Inverted, the islands are the cells: their
 * rest material for a disc of half the limit (as edge chamfers' `chamferMeets`), the width
 * bisected. A port failure gives no finding (the harmless side). Pure.
 * Doc: docs/modes/patterns.md#dfm, docs/modes/patterns.md#implementation-p2
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
  /** Its circumscribed diameter about the origin. */
  readonly diameter: number
  /** Nodes of the whole cells (face frame). */
  readonly nodes: readonly Vec2[]
  readonly invert: boolean
  /** Row lattices: the pitches, half-pitch shift of odd rows and angle; undefined = polar. */
  readonly lattice:
    | { readonly a: number; readonly b: number; readonly shifted: boolean; readonly angle: number }
    | undefined
  /** The area's centre: markers go on the real cell nearest to it. */
  readonly centre: Vec2
}

const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1])
const key = (p: Vec2) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`

/** The thin web or island of the pattern; undefined when none is under the limit. */
export function patternWeb(port: Region2dPort, w: WebInput): PatternWeb | undefined {
  if (w.nodes.length === 0) return undefined
  return w.invert ? island(port, w) : web(port, w)
}

function nearestNode(w: WebInput, ok: (n: Vec2) => boolean = () => true): Vec2 | undefined {
  let best: Vec2 | undefined
  for (const n of w.nodes)
    if (ok(n) && (best === undefined || dist(n, w.centre) < dist(best, w.centre))) best = n
  return best
}

function island(port: Region2dPort, w: WebInput): PatternWeb | undefined {
  const rest = (r: number) => findRestMaterial(port, w.cell, r).unwrapOr([])
  const first = rest(PATTERN_WEB_LIMIT / 2 - PRECISION / 2)
  if (first.length === 0) return undefined
  let lo = 0
  let hi = PATTERN_WEB_LIMIT / 2
  while (hi - lo > PRECISION / 4) {
    const mid = (lo + hi) / 2
    if (rest(mid).length === 0) lo = mid
    else hi = mid
  }
  const n = nearestNode(w)!
  const at = first[0]!.at
  return { width: round(2 * lo), at: [n[0] + at[0], n[1] + at[1]], island: true }
}

/** Offsets to measure: lattice offsets in one half plane, or the real neighbour pairs (polar). */
function candidates(w: WebInput): Vec2[] {
  const reach = w.diameter + PATTERN_WEB_LIMIT
  const out: Vec2[] = []
  const l = w.lattice
  if (l !== undefined) {
    const r = (l.angle * Math.PI) / 180
    const [c, s] = [Math.cos(r), Math.sin(r)]
    const nj = Math.ceil(reach / l.b) + 1
    const ni = Math.ceil(reach / l.a) + 1
    for (let j = 0; j <= nj; j++) {
      const shift = l.shifted && j % 2 === 1 ? l.a / 2 : 0
      for (let i = -ni; i <= ni; i++) {
        const dx = i * l.a + shift
        const dy = j * l.b
        if (j === 0 && dx <= 0) continue
        if (Math.hypot(dx, dy) < reach) out.push([c * dx - s * dy, s * dx + c * dy])
      }
    }
  } else {
    const grid = new Map<string, Vec2[]>()
    const cellKey = (p: Vec2, dx = 0, dy = 0) =>
      `${Math.floor(p[0] / reach) + dx},${Math.floor(p[1] / reach) + dy}`
    for (const n of w.nodes) {
      const k = cellKey(n)
      const list = grid.get(k)
      if (list === undefined) grid.set(k, [n])
      else list.push(n)
    }
    const seen = new Set<string>()
    for (const n of w.nodes)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const m of grid.get(cellKey(n, dx, dy)) ?? []) {
            const d: Vec2 = [m[0] - n[0], m[1] - n[1]]
            if (!(d[1] > 1e-9 || (Math.abs(d[1]) <= 1e-9 && d[0] > 1e-9))) continue
            if (Math.hypot(d[0], d[1]) >= reach || seen.has(key(d))) continue
            seen.add(key(d))
            out.push(d)
          }
  }
  return out
    .sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]))
    .slice(0, CANDIDATES_MAX)
}

function web(port: Region2dPort, w: WebInput): PatternWeb | undefined {
  const offsets = candidates(w)
  if (offsets.length === 0) return undefined
  const grown = new Map<number, Region | undefined>()
  const grow = (d: number): Region | undefined => {
    if (!grown.has(d)) {
      const g = port.offset(w.cell, -d)
      grown.set(d, g.isOk() ? g.unwrap() : undefined)
    }
    return grown.get(d)
  }
  const meets = (d: number, off: Vec2): boolean => {
    const g = grow(d)
    if (g === undefined) return false
    const x = port.intersect(g, translateRegion(w.cell, off))
    return x.isOk() && x.unwrap().pieces.length > 0 && regionArea(x.unwrap()) > 1e-12
  }
  // only offsets a real pair of cells has
  const nodes = new Set(w.nodes.map(key))
  const real = (off: Vec2) => nearestNode(w, (n) => nodes.has(key([n[0] + off[0], n[1] + off[1]])))
  let hits = offsets.filter((o) => meets(PATTERN_WEB_LIMIT - PRECISION / 2, o))
  hits = hits.filter((o) => real(o) !== undefined)
  if (hits.length === 0) return undefined
  let lo = 0
  let hi = PATTERN_WEB_LIMIT - PRECISION / 2
  let narrowest = hits[0]!
  while (hi - lo > PRECISION / 2) {
    const mid = (lo + hi) / 2
    const hit = hits.find((o) => meets(mid, o))
    if (hit === undefined) lo = mid
    else {
      hi = mid
      narrowest = hit
    }
  }
  // the marker: between the real pair nearest the centre, at the overlap of the grown cell
  const n = real(narrowest)!
  const g = grow(hi)
  const x = g === undefined ? undefined : port.intersect(g, translateRegion(w.cell, narrowest))
  const b =
    x === undefined || x.isErr()
      ? undefined
      : chainBounds(x.unwrap().pieces.flatMap((p) => p.outer.elements))
  const len = Math.hypot(narrowest[0], narrowest[1])
  const q: Vec2 =
    b === undefined
      ? [narrowest[0] / 2, narrowest[1] / 2]
      : [
          (b.min[0] + b.max[0]) / 2 - (narrowest[0] / len) * (hi / 2),
          (b.min[1] + b.max[1]) / 2 - (narrowest[1] / len) * (hi / 2),
        ]
  return { width: round(lo), at: [n[0] + q[0], n[1] + q[1]], island: false }
}

const round = (x: number) => Math.round(x * 100) / 100
