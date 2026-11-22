/**
 * One subpath (segments in mm) → one chain of 2D elements: each segment fitted (lines and circular
 * arcs exact, Béziers and ellipses as biarcs), joined end to start exactly, closed when its ends
 * meet within the chord tolerance, then cleaned up: elements shorter than `MIN_ELEMENT_LENGTH`
 * (micro corners left at near-cusps, tiny source segments) are merged into their neighbours, so
 * the 2D port's `segmentTooShort` never fires for imports.
 * Doc: docs/architecture/shapes.md#arc-fitting
 */
import type { Vec2 } from '../../geometry/model'
import { CHORD_TOLERANCE } from '../../geometry/model'
import { arc, line, MIN_ELEMENT_LENGTH, type Element } from '../../geometry/2d/model'
import { curveOf, dist } from './curves'
import { arcGeom, elemLength, fitCurve, type BElem, type FitOptions, FIT_DEFAULTS } from './fit'
import { segEnd, segStart, type Seg } from './path-data'
import type { Pt } from './transform'

/** Running counts for the import report. */
export interface ChainStats {
  /** Cubic Béziers fitted (quadratics included) and elliptical arcs fitted. */
  beziers: number
  ellipses: number
  /** Largest in-fit error estimate (mm). */
  maxDeviation: number
  /** Corners kept at cusps. */
  cusps: number
  /** Micro corners merged into their neighbours. */
  microCorners: number
  /** Other elements under `MIN_ELEMENT_LENGTH` merged (tiny source segments). */
  tinySegments: number
  /** Open subpaths closed because their ends met within the chord tolerance. */
  gapsClosed: number
  /** Pieces accepted without meeting the tolerance (expected 0). */
  forced: number
  /** Elements produced so far (lines + arcs), for the element limit. */
  elements: number
}

export const emptyStats = (): ChainStats => ({
  beziers: 0,
  ellipses: 0,
  maxDeviation: 0,
  cusps: 0,
  microCorners: 0,
  tinySegments: 0,
  gapsClosed: 0,
  forced: 0,
  elements: 0,
})

export interface Chain {
  readonly closed: boolean
  readonly elements: readonly Element[]
}

const withA = (e: BElem, a: Pt): BElem => ({ ...e, a })
const withB = (e: BElem, b: Pt): BElem => ({ ...e, b })
const mid = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
const tiny = (e: BElem): boolean => elemLength(e) < MIN_ELEMENT_LENGTH

/** Fits the segments into one chain of bulge elements joined exactly end to start. */
function fitSegments(segs: readonly Seg[], stats: ChainStats, o: FitOptions): BElem[] {
  const out: BElem[] = []
  for (const s of segs) {
    const c = curveOf(s)
    const r = fitCurve(c, o)
    if (c.kind === 'cubic') stats.beziers++
    else if (c.kind === 'ellipse') stats.ellipses++
    stats.maxDeviation = Math.max(stats.maxDeviation, r.maxError)
    stats.cusps += r.cusps
    stats.forced += r.forced
    const elems = r.elems
    if (elems.length === 0) continue
    // exact ends: the previous element's end (shared point), the segment's own end point
    const start = out.length > 0 ? out[out.length - 1]!.b : segStart(s)
    elems[0] = withA(elems[0]!, start)
    elems[elems.length - 1] = withB(elems[elems.length - 1]!, segEnd(s))
    out.push(...elems)
  }
  return out
}

/** One pass of the merge of short elements; returns the elements and whether anything merged. */
function mergePass(
  elems: readonly BElem[],
  closed: boolean,
  stats: ChainStats,
): { elems: BElem[]; merged: boolean } {
  let list = [...elems]
  if (closed) {
    // start at an element that stays, so the wrap-around is a plain join
    const first = list.findIndex((e) => !tiny(e))
    if (first < 0) return { elems: [], merged: true }
    list = [...list.slice(first), ...list.slice(0, first)]
  }
  const out: BElem[] = []
  let merged = false
  let pendingA: Pt | undefined
  for (const e0 of list) {
    const e = pendingA ? withA(e0, pendingA) : e0
    pendingA = undefined
    if (!tiny(e)) {
      out.push(e)
      continue
    }
    merged = true
    if (e.micro) stats.microCorners++
    else stats.tinySegments++
    if (out.length === 0) {
      pendingA = e.a // open path start stays
      continue
    }
    const m = mid(e.a, e.b)
    out[out.length - 1] = withB(out[out.length - 1]!, m)
    pendingA = m
  }
  if (out.length === 0) return { elems: [], merged }
  if (pendingA) {
    if (closed) out[0] = withA(out[0]!, pendingA)
    else {
      // a trailing short element: the path end stays
      const last = list[list.length - 1]!
      out[out.length - 1] = withB(out[out.length - 1]!, last.b)
    }
  }
  if (closed) out[out.length - 1] = withB(out[out.length - 1]!, out[0]!.a)
  return { elems: out, merged }
}

/** The bulge elements as 2D model elements sharing their join points exactly. */
function toModel(elems: readonly BElem[], closed: boolean): Element[] {
  const pts: Vec2[] = elems.map((e) => [e.a.x, e.a.y])
  const last = elems[elems.length - 1]
  if (last && !closed) pts.push([last.b.x, last.b.y])
  return elems.map((e, i) => {
    const a = pts[i]!
    const b = closed ? pts[(i + 1) % pts.length]! : pts[i + 1]!
    const g = arcGeom(e)
    return g ? arc(a, b, [g.c.x, g.c.y], e.bulge > 0) : line(a, b)
  })
}

/**
 * Builds the chain of one subpath. Undefined when nothing is left (a closed loop needs ≥ 2
 * elements; the caller reports it).
 */
export function buildChain(
  segs: readonly Seg[],
  closedIn: boolean,
  stats: ChainStats,
  o: FitOptions = FIT_DEFAULTS,
): Chain | undefined {
  let elems = fitSegments(segs, stats, o)
  if (elems.length === 0) return undefined
  let closed = closedIn
  const first = elems[0]!
  const lastE = elems[elems.length - 1]!
  if (closed || dist(lastE.b, first.a) <= CHORD_TOLERANCE) {
    if (!closed && elems.length >= 2) {
      closed = true
      stats.gapsClosed++
    }
    if (closed) elems[elems.length - 1] = withB(lastE, first.a)
  }
  for (let pass = 0; pass < 4; pass++) {
    const r = mergePass(elems, closed, stats)
    elems = r.elems
    if (!r.merged) break
  }
  if (elems.length < (closed ? 2 : 1)) return undefined
  stats.elements += elems.length
  return { closed, elements: toModel(elems, closed) }
}
