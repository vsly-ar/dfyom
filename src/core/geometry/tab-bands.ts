/**
 * Tabs of profiles on general loops (tasks T2, G1): the nominal tab bands across the slot as exact
 * line/arc loops (toolpaths and G1's solid tabs build the same band), and the tool-disk test the tab lift uses (`liftOverTabs` of tabs.ts).
 * Doc: docs/modes/plan-v0.3.md#profile-on-general-loops, bands:
 * docs/architecture/shapes.md#geometry-for-shape-operations
 *
 * A tab's stretch is [position − width/2, position + width/2] along the loop (arc length from the
 * loop's first point, in its direction). Its band is the stretch offset across the slot with end
 * faces along the loop normal, built as pieces: one loop per run of the stretch whose joins turn
 * by at most `SMOOTH_TURN` (both sides offset element by element; at a join an arc round the
 * vertex where the offsets part, trimmed where they overlap), and a sector at each sharper vertex
 * on the side where the normals diverge (the outer side of a corner). An arc whose offset would
 * vanish (radius < `MIN_OFFSET_RADIUS`) is a piece of its own, its sector from the centre. Not
 * bent on the medial axis: near a concave corner closer than the slot width the band reaches
 * past it (geometry builds the same band in G1).
 *
 * Runs keep nearly coincident faces away from the 2D port: the fitted arcs of an imported outline
 * meet at turns of ≈ 1e-7 … 1e-4 rad, and per-element pieces with end faces and corner sectors
 * there failed the port's union (`degenerate`) or left a band in two pieces (v0.3 known issue,
 * tabs ≥ 2 on the enclosure outline). Likewise a stretch end within `MIN_ELEMENT_LENGTH` of a
 * vertex moves onto it, a corner whose sector would close a gap narrower than `TANGENT_GAP` gets
 * none, and a sector shorter than `MIN_SECTOR_ARC` sweeps that far, centred on the gap (the union
 * is the same within 1e-4 mm).
 */
import type { Vec2 } from './model'
import {
  arc,
  arcRadius,
  arcSweep,
  chainBounds,
  elementLength,
  line,
  MIN_ELEMENT_LENGTH,
  POSITION_EPSILON,
  type Bounds2,
  type Element,
  type Loop,
} from './2d/model'
import { closestOnChains, elementPointAt, regionContains } from './2d/measure'

/** One convex-ish piece of a band: a closed loop and its bounds. */
export interface TabBandPiece {
  readonly loop: Loop
  readonly bounds: Bounds2
}

/** The band of one tab: the union of its pieces. */
export type GeneralTabBand = readonly TabBandPiece[]

const TAU = 2 * Math.PI

/**
 * A join whose corner sector would close a gap narrower than this (mm, at the band's far side)
 * is tangent: the port sees the pieces' end faces as one line there (`POSITION_EPSILON` / 10).
 */
const TANGENT_GAP = POSITION_EPSILON / 10
/** The shortest arc of a corner sector (mm): twice the port's smallest element. */
const MIN_SECTOR_ARC = 2 * MIN_ELEMENT_LENGTH
/** Joins turning by at most this (rad, ≈ 0.6°) are inside a run: one loop across them. */
const SMOOTH_TURN = 0.01
/** An arc whose offset radius on either side is below this (mm) is a piece of its own. */
const MIN_OFFSET_RADIUS = 10 * MIN_ELEMENT_LENGTH
/**
 * Offsets that overlap at a join by at most this (mm) but do not cross on both elements meet at
 * the midpoint projected onto each (off by ≈ gap² / radius): nearly tangent offsets cross where
 * the crossing is ill-conditioned, or not at all.
 */
const SNAP_GAP = 1e-3

/** Element `e` between fractions `t0` and `t1` (0..1). */
function sliceElement(e: Element, t0: number, t1: number): Element {
  const a = elementPointAt(e, t0).point
  const b = elementPointAt(e, t1).point
  return e.kind === 'line' ? line(a, b) : arc(a, b, e.centre, e.ccw)
}

/**
 * The elements of `chain` from arc length `s0` to `s1` (`s0` < `s1`; a closed chain wraps, so
 * `s1` may pass its length once). An end within `MIN_ELEMENT_LENGTH` of a vertex moves onto it,
 * so no piece is shorter than the 2D port's smallest element (zero-length pieces are dropped).
 */
export function sliceChain(chain: Loop, s0: number, s1: number): Element[] {
  const lengths = chain.elements.map(elementLength)
  const total = lengths.reduce((x, y) => x + y, 0)
  const out: Element[] = []
  if (total <= 0) return out
  const vertices = [0]
  for (const len of lengths) vertices.push(vertices[vertices.length - 1]! + len)
  const snap = (s: number): number => {
    const lap = Math.floor(s / total) * total
    const v = vertices.find((x) => Math.abs(s - lap - x) < MIN_ELEMENT_LENGTH)
    return v === undefined ? s : lap + v
  }
  s0 = snap(s0)
  s1 = snap(s1)
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

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const withStart = (e: Element, a: Vec2): Element =>
  e.kind === 'line' ? line(a, e.b) : arc(a, e.b, e.centre, e.ccw)
const withEnd = (e: Element, b: Vec2): Element =>
  e.kind === 'line' ? line(e.a, b) : arc(e.a, b, e.centre, e.ccw)
const reversed = (e: Element): Element =>
  e.kind === 'line' ? line(e.b, e.a) : arc(e.b, e.a, e.centre, !e.ccw)

/** Signed turn (rad, positive left) from the end of `e` to the start of `next`. */
function turnAt(e: Element, next: Element): number {
  const t1 = elementPointAt(e, 1).tangent
  const t2 = elementPointAt(next, 0).tangent
  return Math.atan2(cross(t1, t2), t1[0] * t2[0] + t1[1] * t2[1])
}

/** `e` offset by `d` along its left normal; undefined when an arc's offset radius vanishes. */
function offsetElement(e: Element, d: number): Element | undefined {
  if (d === 0) return e
  if (e.kind === 'line') {
    const n = leftNormal(elementPointAt(e, 0).tangent)
    return line(add(e.a, n, d), add(e.b, n, d))
  }
  // offset t along the left normal: radius r − t on a counter-clockwise arc, r + t clockwise
  const r = arcRadius(e)
  const r2 = r + (e.ccw ? -d : d)
  if (r2 < MIN_OFFSET_RADIUS) return undefined
  const c = e.centre
  const at = (p: Vec2): Vec2 => [c[0] + ((p[0] - c[0]) * r2) / r, c[1] + ((p[1] - c[1]) * r2) / r]
  return arc(at(e.a), at(e.b), c, e.ccw)
}

/** Fraction (0..1 on the element) of the point of `e`'s line or circle at or nearest to `p`. */
function fractionOn(e: Element, p: Vec2): number {
  if (e.kind === 'line') {
    const u: Vec2 = [e.b[0] - e.a[0], e.b[1] - e.a[1]]
    const uu = u[0] * u[0] + u[1] * u[1]
    return uu > 0 ? ((p[0] - e.a[0]) * u[0] + (p[1] - e.a[1]) * u[1]) / uu : -1
  }
  const sweep = Math.abs(arcSweep(e))
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const ang = Math.atan2(p[1] - e.centre[1], p[0] - e.centre[0])
  const along = (((e.ccw ? ang - a0 : a0 - ang) % TAU) + TAU) % TAU
  // just before the start reads as negative, not as almost a full turn
  return (along > sweep && along - sweep > Math.PI ? along - TAU : along) / sweep
}

/** Where the line or circle of `p` crosses that of `q` (lines endless, arcs full circles). */
function crossPoints(p: Element, q: Element): Vec2[] {
  if (p.kind === 'line' && q.kind === 'line') {
    const u: Vec2 = [p.b[0] - p.a[0], p.b[1] - p.a[1]]
    const w: Vec2 = [q.b[0] - q.a[0], q.b[1] - q.a[1]]
    const den = cross(u, w)
    if (Math.abs(den) < 1e-18) return []
    return [add(p.a, u, cross([q.a[0] - p.a[0], q.a[1] - p.a[1]], w) / den)]
  }
  if (p.kind === 'arc' && q.kind === 'arc') {
    const r1 = arcRadius(p)
    const r2 = arcRadius(q)
    const d = dist(p.centre, q.centre)
    if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return []
    const a = (d * d + r1 * r1 - r2 * r2) / (2 * d)
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a))
    const u: Vec2 = [(q.centre[0] - p.centre[0]) / d, (q.centre[1] - p.centre[1]) / d]
    const m = add(p.centre, u, a)
    return [add(m, leftNormal(u), h), add(m, leftNormal(u), -h)]
  }
  const l = p.kind === 'line' ? p : q
  const c = p.kind === 'arc' ? p : q
  if (c.kind !== 'arc') return []
  const u: Vec2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]]
  const f: Vec2 = [l.a[0] - c.centre[0], l.a[1] - c.centre[1]]
  const r = arcRadius(c)
  const A = u[0] * u[0] + u[1] * u[1]
  const B = 2 * (f[0] * u[0] + f[1] * u[1])
  const disc = B * B - 4 * A * (f[0] * f[0] + f[1] * f[1] - r * r)
  if (A === 0 || disc < 0) return []
  const sq = Math.sqrt(disc)
  return [add(l.a, u, (-B - sq) / (2 * A)), add(l.a, u, (-B + sq) / (2 * A))]
}

/** The point of `e`'s line or circle nearest to `p`. */
function project(e: Element, p: Vec2): Vec2 {
  if (e.kind === 'line') return elementPointAt(e, fractionOn(e, p)).point
  const d = dist(p, e.centre)
  if (d === 0) return e.a
  return add(e.centre, [(p[0] - e.centre[0]) / d, (p[1] - e.centre[1]) / d], arcRadius(e))
}

const strictlyOn = (e: Element, x: Vec2): boolean => {
  const t = fractionOn(e, x)
  return t > 0 && t < 1
}

/**
 * The offsets `p` (ending at a join) and `q` (starting there) on the side at offset `d` of the
 * join's vertex `v`, joined: an arc round `v` where they part, trimmed where they overlap.
 * Undefined when an overlap cannot be trimmed on both (the run ends there).
 */
function joinOffsets(
  p: Element,
  q: Element,
  v: Vec2,
  d: number,
  turn: number,
): { p: Element; mid: Element[]; q: Element } | undefined {
  const gap = dist(p.b, q.a)
  if (gap <= TANGENT_GAP) return { p, mid: [], q: withStart(q, p.b) }
  // the offsets part on the right (d < 0) of a left turn and on the left of a right turn
  if (turn * d < 0) return { p, mid: [arc(p.b, q.a, v, turn > 0)], q }
  const m: Vec2 = [(p.b[0] + q.a[0]) / 2, (p.b[1] + q.a[1]) / 2]
  const x = crossPoints(p, q)
    .filter((c) => strictlyOn(p, c) && strictlyOn(q, c))
    .sort((a, b) => dist(a, m) - dist(b, m))[0]
  if (x !== undefined) return { p: withEnd(p, x), mid: [], q: withStart(q, x) }
  if (gap > SNAP_GAP) return undefined
  const xp = project(p, m)
  const xq = project(q, m)
  if (!strictlyOn(p, xp) || !strictlyOn(q, xq)) return undefined
  if (dist(xp, xq) <= TANGENT_GAP) return { p: withEnd(p, xp), mid: [], q: withStart(q, xp) }
  return { p: withEnd(p, xp), mid: [line(xp, xq)], q: withStart(q, xq) }
}

/** An arc whose offset vanishes on a side, across [lo, hi]: its sector from the centre. */
function arcPiece(e: Element & { kind: 'arc' }, lo: number, hi: number): TabBandPiece[] {
  const r = arcRadius(e)
  const k = e.ccw ? -1 : 1
  const r0 = Math.max(0, Math.min(r + k * lo, r + k * hi))
  const r1 = Math.max(r + k * lo, r + k * hi)
  if (r1 <= 1e-9) return []
  // the sector counter-clockwise from the start angle
  const from = e.ccw ? e.a : e.b
  const s = Math.abs(arcSweep(e))
  const u0: Vec2 = [(from[0] - e.centre[0]) / r, (from[1] - e.centre[1]) / r]
  const ang = Math.atan2(u0[1], u0[0]) + s
  const u1: Vec2 = [Math.cos(ang), Math.sin(ang)]
  if (r0 <= 1e-9) return [sector(e.centre, r1, u0, Math.min(s, TAU - 1e-9))]
  const c = e.centre
  return [
    piece([
      line(add(c, u0, r0), add(c, u0, r1)),
      arc(add(c, u0, r1), add(c, u1, r1), c, true),
      line(add(c, u1, r1), add(c, u1, r0)),
      arc(add(c, u1, r0), add(c, u0, r0), c, false),
    ]),
  ]
}

/** The sector at the vertex from `e` to `next`, on the side where the normals diverge. */
function cornerSector(e: Element, next: Element, lo: number, hi: number): TabBandPiece[] {
  const turn = turnAt(e, next)
  const t1 = elementPointAt(e, 1).tangent
  const t2 = elementPointAt(next, 0).tangent
  // the gap opens on the right (offset −lo) for a left turn, on the left (hi) for a right turn
  const r = turn > 0 ? -lo : hi
  const sweep = Math.abs(turn)
  if (r <= 0 || r * sweep < TANGENT_GAP) return []
  // from the normal of the side the gap opens on, counter-clockwise; a short arc sweeps
  // further, centred on the gap, into both neighbours' pieces
  const from = turn > 0 ? ([t1[1], -t1[0]] as Vec2) : leftNormal(t2)
  const wide = Math.max(sweep, MIN_SECTOR_ARC / r)
  const a0 = Math.atan2(from[1], from[0]) - (wide - sweep) / 2
  return [sector(e.b, r, [Math.cos(a0), Math.sin(a0)], wide)]
}

/**
 * Band of the stretch `elements` across signed offsets [lo, hi] along the chain's left normal
 * (lo < hi; e.g. an outside slot of a counter-clockwise loop is [−slotWidth, 0]).
 */
export function stretchBand(elements: readonly Element[], lo: number, hi: number): TabBandPiece[] {
  const out: TabBandPiece[] = []
  const n = elements.length
  let i = 0
  while (i < n) {
    const e = elements[i]!
    const eLo = offsetElement(e, lo)
    const eHi = offsetElement(e, hi)
    let j = i
    if (eLo === undefined || eHi === undefined) {
      if (e.kind === 'arc') out.push(...arcPiece(e, lo, hi))
    } else {
      // a run: both sides offset element by element, joined while the joins are smooth and trim
      const lows: Element[] = [eLo]
      const highs: Element[] = [eHi]
      while (j + 1 < n) {
        const next = elements[j + 1]!
        const turn = turnAt(elements[j]!, next)
        const nLo = offsetElement(next, lo)
        const nHi = offsetElement(next, hi)
        if (Math.abs(turn) > SMOOTH_TURN || nLo === undefined || nHi === undefined) break
        const v = elements[j]!.b
        const jl = joinOffsets(lows[lows.length - 1]!, nLo, v, lo, turn)
        const jh = joinOffsets(highs[highs.length - 1]!, nHi, v, hi, turn)
        if (jl === undefined || jh === undefined) break
        lows.splice(lows.length - 1, 1, jl.p, ...jl.mid, jl.q)
        highs.splice(highs.length - 1, 1, jh.p, ...jh.mid, jh.q)
        j++
      }
      const back = highs.reverse().map(reversed)
      out.push(
        piece([
          ...lows,
          line(lows[lows.length - 1]!.b, back[0]!.a),
          ...back,
          line(back[back.length - 1]!.b, lows[0]!.a),
        ]),
      )
    }
    if (j + 1 < n) out.push(...cornerSector(elements[j]!, elements[j + 1]!, lo, hi))
    i = j + 1
  }
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
