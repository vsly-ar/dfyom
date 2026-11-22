/**
 * Tabs of profiles on general loops (task T2): the nominal tab bands across the slot as exact
 * line/arc loops, and the tool-disk test the tab lift uses (`liftOverTabs` of tabs.ts).
 * Doc: docs/modes/plan-v0.3.md#profile-on-general-loops, bands:
 * docs/architecture/shapes.md#geometry-for-shape-operations
 *
 * A tab's stretch is [position − width/2, position + width/2] along the loop (arc length from the
 * loop's first point, in its direction). Its band is built per element of the stretch: the element
 * offset across the slot (a quad for a line, an annular sector for an arc) with end faces along
 * the loop normal, plus a sector at each vertex where the normals of two elements diverge (the
 * outer side of a corner). Not bent on the medial axis: near a concave corner closer than the
 * slot width the band reaches past it (geometry builds the same band in G1).
 */
import type { Vec2 } from '../geometry/model'
import {
  arc,
  arcRadius,
  arcSweep,
  chainBounds,
  elementLength,
  line,
  type Bounds2,
  type Element,
  type Loop,
} from '../geometry/2d/model'
import { closestOnChains, elementPointAt, regionContains } from '../geometry/2d/measure'

/** One convex-ish piece of a band: a closed loop and its bounds. */
export interface TabBandPiece {
  readonly loop: Loop
  readonly bounds: Bounds2
}

/** The band of one tab: the union of its pieces. */
export type GeneralTabBand = readonly TabBandPiece[]

const TAU = 2 * Math.PI

/** Element `e` between fractions `t0` and `t1` (0..1). */
function sliceElement(e: Element, t0: number, t1: number): Element {
  const a = elementPointAt(e, t0).point
  const b = elementPointAt(e, t1).point
  return e.kind === 'line' ? line(a, b) : arc(a, b, e.centre, e.ccw)
}

/**
 * The elements of `chain` from arc length `s0` to `s1` (`s0` < `s1`; a closed chain wraps, so
 * `s1` may pass its length once). Zero-length pieces are dropped.
 */
export function sliceChain(chain: Loop, s0: number, s1: number): Element[] {
  const lengths = chain.elements.map(elementLength)
  const total = lengths.reduce((x, y) => x + y, 0)
  const out: Element[] = []
  if (total <= 0) return out
  let base = Math.floor(s0 / total) * total
  for (let lap = 0; lap < 3 && base < s1; lap++, base += total) {
    let acc = base
    chain.elements.forEach((e, i) => {
      const len = lengths[i]!
      const a = Math.max(s0, acc)
      const b = Math.min(s1, acc + len)
      if (len > 0 && b - a > 1e-9) out.push(sliceElement(e, (a - acc) / len, (b - acc) / len))
      acc += len
    })
  }
  return out
}

const add = (p: Vec2, v: Vec2, k: number): Vec2 => [p[0] + v[0] * k, p[1] + v[1] * k]
const leftNormal = (t: Vec2): Vec2 => [-t[1], t[0]]

function piece(elements: Element[]): TabBandPiece {
  return { loop: { elements }, bounds: chainBounds(elements)! }
}

/** A sector of radius `r` round `v` from direction `u0` counter-clockwise by `sweep` (< 2π). */
function sector(v: Vec2, r: number, u0: Vec2, sweep: number): TabBandPiece {
  const ang = Math.atan2(u0[1], u0[0]) + sweep
  const p0 = add(v, u0, r)
  const p1: Vec2 = [v[0] + r * Math.cos(ang), v[1] + r * Math.sin(ang)]
  return piece([line(v, p0), arc(p0, p1, v, true), line(p1, v)])
}

/**
 * Band of the stretch `elements` across signed offsets [lo, hi] along the chain's left normal
 * (lo < hi; e.g. an outside slot of a counter-clockwise loop is [−slotWidth, 0]).
 */
export function stretchBand(elements: readonly Element[], lo: number, hi: number): TabBandPiece[] {
  const out: TabBandPiece[] = []
  elements.forEach((e, i) => {
    if (e.kind === 'line') {
      const n = leftNormal(elementPointAt(e, 0).tangent)
      out.push(
        piece([
          line(add(e.a, n, lo), add(e.b, n, lo)),
          line(add(e.b, n, lo), add(e.b, n, hi)),
          line(add(e.b, n, hi), add(e.a, n, hi)),
          line(add(e.a, n, hi), add(e.a, n, lo)),
        ]),
      )
    } else {
      // offset t along the left normal: radius r − t on a counter-clockwise arc, r + t clockwise
      const r = arcRadius(e)
      const k = e.ccw ? -1 : 1
      const r0 = Math.max(0, Math.min(r + k * lo, r + k * hi))
      const r1 = Math.max(r + k * lo, r + k * hi)
      if (r1 > 1e-9) {
        const sweep = arcSweep(e)
        // the sector counter-clockwise from the start angle
        const from = e.ccw ? e.a : e.b
        const s = Math.abs(sweep)
        const u0: Vec2 = [(from[0] - e.centre[0]) / r, (from[1] - e.centre[1]) / r]
        const ang = Math.atan2(u0[1], u0[0]) + s
        const u1: Vec2 = [Math.cos(ang), Math.sin(ang)]
        if (r0 <= 1e-9) out.push(sector(e.centre, r1, u0, Math.min(s, TAU - 1e-9)))
        else {
          const c = e.centre
          out.push(
            piece([
              line(add(c, u0, r0), add(c, u0, r1)),
              arc(add(c, u0, r1), add(c, u1, r1), c, true),
              line(add(c, u1, r1), add(c, u1, r0)),
              arc(add(c, u1, r0), add(c, u0, r0), c, false),
            ]),
          )
        }
      }
    }
    // the corner to the next element: a sector on the side where the normals diverge
    const next = elements[i + 1]
    if (next === undefined) return
    const t1 = elementPointAt(e, 1).tangent
    const t2 = elementPointAt(next, 0).tangent
    const turn = Math.atan2(t1[0] * t2[1] - t1[1] * t2[0], t1[0] * t2[0] + t1[1] * t2[1])
    if (Math.abs(turn) < 1e-9) return
    const v = e.b
    if (turn > 0 && lo < 0) out.push(sector(v, -lo, [t1[1], -t1[0]], turn))
    else if (turn < 0 && hi > 0) out.push(sector(v, hi, leftNormal(t2), -turn))
  })
  return out
}

/**
 * The bands of tabs centred at `positions` (arc length along the closed `chain`) of `width`,
 * across signed offsets [lo, hi] along the chain's left normal.
 */
export function generalTabBands(
  chain: Loop,
  positions: readonly number[],
  width: number,
  lo: number,
  hi: number,
): GeneralTabBand[] {
  return positions.map((c) => stretchBand(sliceChain(chain, c - width / 2, c + width / 2), lo, hi))
}

/** Does a tool of `radius` at `p` cut into a band? Touching (distance = radius) does not. */
export function diskHitsGeneralBands(
  p: Vec2,
  radius: number,
  bands: readonly GeneralTabBand[],
): boolean {
  for (const band of bands)
    for (const pc of band) {
      const b = pc.bounds
      if (
        p[0] < b.min[0] - radius ||
        p[0] > b.max[0] + radius ||
        p[1] < b.min[1] - radius ||
        p[1] > b.max[1] + radius
      )
        continue
      if (regionContains({ pieces: [{ outer: pc.loop, holes: [] }] }, p)) return true
      const c = closestOnChains([pc.loop], p)
      if (c !== undefined && c.distance < radius - 1e-7) return true
    }
  return false
}
