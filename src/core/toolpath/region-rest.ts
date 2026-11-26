/**
 * Rest clipping (hardening DF122, slice R3): the pieces of a clearing ring whose tool disc is not
 * wholly in what an earlier roughing pocket cleared, as open runs, and the straight-link test
 * between them. Exact: ring pieces (lines, arcs) are cut where they cross the boundary of the
 * roughed tool-centre region (`restInside`), each stretch classified by its midpoint.
 * Doc: docs/modes/roughing.md#implementation-r3
 */
import type { Vec2 } from '../geometry/model'
import { chainBounds, regionLoops, type Bounds2, type Region } from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { segLength, segPoint, segSlice, segsLength, type Seg } from './path'
import { loopRing, segClosest, segmentHits } from './region-rings'

/** Runs shorter than this (mm) are dropped: 2D-library noise where a ring grazes the boundary. */
export const MIN_RUN = 1e-3

/** The roughed tool-centre region split by piece, with boxes and rings for the hit tests. */
export interface RestArea {
  readonly region: Region
  readonly pieces: readonly {
    readonly region: Region
    readonly box: Bounds2 | undefined
    readonly rings: readonly (readonly Seg[])[]
  }[]
}

export function restArea(inside: Region): RestArea {
  return {
    region: inside,
    pieces: inside.pieces.map((piece) => {
      const region: Region = { pieces: [piece] }
      return {
        region,
        box: chainBounds(piece.outer.elements),
        rings: regionLoops(region).map((l) => loopRing(l)),
      }
    }),
  }
}

/** One kept stretch of a ring: an open path cut in the ring's direction. */
export interface Run {
  readonly segs: readonly Seg[]
  /** A point of the run outside the roughed area (its first stretch's middle). */
  readonly probe: Vec2
}

/** How a ring is cut after a roughing: whole (nothing clipped), as runs, or not at all. */
export type Clipped =
  { readonly kind: 'whole' } | { readonly kind: 'runs'; readonly runs: readonly Run[] }

/** Fraction along arc `s` of a point on its circle, or undefined when off the arc. */
function arcFraction(s: Extract<Seg, { kind: 'arc' }>, p: Vec2): number | undefined {
  const u = segClosest(s, p)
  const q = segPoint(s, u)
  return Math.hypot(q[0] - p[0], q[1] - p[1]) <= 1e-7 ? u : undefined
}

/** Fractions u ∈ (0, 1) along `s` where it meets the piece `t`. */
export function segHits(s: Seg, t: Seg): number[] {
  if (s.kind === 'line') return segmentHits(s.from, s.to, t)
  const out: number[] = []
  const push = (p: Vec2) => {
    const u = arcFraction(s, p)
    if (u !== undefined && u > 0 && u < 1) out.push(u)
  }
  if (t.kind === 'line') {
    const dx = t.to[0] - t.from[0]
    const dy = t.to[1] - t.from[1]
    // ends included: a hit at a piece's end still splits the arc
    for (const v of [0, ...segmentHits(t.from, t.to, s), 1]) {
      const p: Vec2 = [t.from[0] + dx * v, t.from[1] + dy * v]
      const d = Math.hypot(p[0] - s.center[0], p[1] - s.center[1])
      if (Math.abs(d - s.radius) <= 1e-7) push(p)
    }
    return out
  }
  const dx = t.center[0] - s.center[0]
  const dy = t.center[1] - s.center[1]
  const d = Math.hypot(dx, dy)
  if (d <= 1e-9) {
    // concentric: only the same circle meets, at the other arc's ends
    if (Math.abs(t.radius - s.radius) <= 1e-9) {
      push(segPoint(t, 0))
      push(segPoint(t, 1))
    }
    return out
  }
  const a = (s.radius * s.radius - t.radius * t.radius + d * d) / (2 * d)
  const h2 = s.radius * s.radius - a * a
  if (h2 < -1e-9 * s.radius * s.radius) return out
  const h = Math.sqrt(Math.max(0, h2))
  const mx = s.center[0] + (a * dx) / d
  const my = s.center[1] + (a * dy) / d
  for (const sign of h === 0 ? [0] : [-1, 1]) {
    const p: Vec2 = [mx - (sign * h * dy) / d, my + (sign * h * dx) / d]
    if (arcFraction(t, p) !== undefined) push(p)
  }
  return out
}

/** A box of a piece (an arc's whole circle: a bound). */
function segBox(s: Seg): Bounds2 {
  if (s.kind === 'line')
    return {
      min: [Math.min(s.from[0], s.to[0]), Math.min(s.from[1], s.to[1])],
      max: [Math.max(s.from[0], s.to[0]), Math.max(s.from[1], s.to[1])],
    }
  return {
    min: [s.center[0] - s.radius, s.center[1] - s.radius],
    max: [s.center[0] + s.radius, s.center[1] + s.radius],
  }
}

const overlaps = (a: Bounds2 | undefined, b: Bounds2, slack = 1e-6) =>
  a !== undefined &&
  a.min[0] <= b.max[0] + slack &&
  b.min[0] <= a.max[0] + slack &&
  a.min[1] <= b.max[1] + slack &&
  b.min[1] <= a.max[1] + slack

function boxOf(segs: readonly Seg[]): Bounds2 {
  const bs = segs.map(segBox)
  return {
    min: [Math.min(...bs.map((b) => b.min[0])), Math.min(...bs.map((b) => b.min[1]))],
    max: [Math.max(...bs.map((b) => b.max[0])), Math.max(...bs.map((b) => b.max[1]))],
  }
}

/**
 * The closed `ring` clipped to where the tool disc is not wholly roughed: the stretches whose
 * midpoint lies outside `area`, joined across roughed gaps shorter than `bridge` (the tool runs on
 * along the ring through that air instead of linking), each kept run starting where the ring
 * leaves the roughed area. Runs shorter than `MIN_RUN` are dropped.
 */
export function clipRing(
  port: Region2dPort,
  ring: readonly Seg[],
  area: RestArea,
  bridge: number,
): Clipped {
  if (ring.length === 0) return { kind: 'runs', runs: [] }
  const box = boxOf(ring)
  const near = area.pieces.filter((p) => overlaps(p.box, box))
  if (near.length === 0) return { kind: 'whole' }
  const nearRegion: Region = { pieces: near.flatMap((p) => p.region.pieces) }
  const boundary = near.flatMap((p) => p.rings.flat())
  // stretches in ring order: [piece, u0, u1, roughed]
  interface Stretch {
    readonly seg: number
    readonly u0: number
    readonly u1: number
    readonly air: boolean
  }
  const stretches: Stretch[] = []
  for (const [i, s] of ring.entries()) {
    const sb = segBox(s)
    const us = [0, 1]
    for (const t of boundary) if (overlaps(segBox(t), sb)) us.push(...segHits(s, t))
    us.sort((x, y) => x - y)
    const len = segLength(s)
    for (let k = 1; k < us.length; k++) {
      const u0 = us[k - 1]!
      const u1 = us[k]!
      if ((u1 - u0) * len < 1e-9) continue
      const air = port.contains(nearRegion, segPoint(s, (u0 + u1) / 2))
      const last = stretches.at(-1)
      if (last !== undefined && last.seg === i && last.air === air)
        stretches[stretches.length - 1] = { ...last, u1 }
      else stretches.push({ seg: i, u0, u1, air })
    }
  }
  if (stretches.every((s) => !s.air)) return { kind: 'whole' }
  if (stretches.every((s) => s.air)) return { kind: 'runs', runs: [] }
  // start at a stretch that leaves the roughed area
  const first = stretches.findIndex((s, k) => !s.air && stretches.at(k - 1)!.air)
  const order = [...stretches.slice(first), ...stretches.slice(0, first)]
  const piece = (s: Stretch): Seg => segSlice(ring[s.seg]!, s.u0, s.u1)
  // groups of consecutive stretches with the same class, in order
  const groups: { air: boolean; segs: Seg[] }[] = []
  for (const s of order) {
    const g = groups.at(-1)
    if (g !== undefined && g.air === s.air) g.segs.push(piece(s))
    else groups.push({ air: s.air, segs: [piece(s)] })
  }
  const runs: { segs: Seg[]; probe: Vec2 }[] = []
  for (const [k, g] of groups.entries()) {
    if (g.air) continue
    const mid = g.segs[Math.floor(g.segs.length / 2)]!
    const probe = segPoint(mid, g.segs.length % 2 === 1 ? 0.5 : 0)
    const prev = runs.at(-1)
    const gap = groups[k - 1]
    // bridge a short roughed gap (never the closing one: the ring starts after a gap)
    if (prev !== undefined && gap !== undefined && gap.air && segsLength(gap.segs) < bridge)
      prev.segs.push(...gap.segs, ...g.segs)
    else runs.push({ segs: [...g.segs], probe })
  }
  return {
    kind: 'runs',
    runs: runs.filter((r) => segsLength(r.segs) >= MIN_RUN),
  }
}

/**
 * Whether the straight link `p`–`q` keeps the tool where it cuts at most a ring's engagement:
 * each stretch between boundary hits lies in the roughed `area` (air), or in every region of
 * `cut` (the level's tool-centre positions already cut round, as `linkInside`'s parent region).
 */
export function restLinkClear(
  port: Region2dPort,
  area: RestArea,
  cut: readonly RestArea[],
  p: Vec2,
  q: Vec2,
): boolean {
  const box = segBox({ kind: 'line', from: p, to: q })
  const air = nearOf(area, box)
  const cuts = cut.map((c) => nearOf(c, box))
  const ts = [0, 1]
  for (const n of [air, ...cuts]) for (const t of n.boundary) ts.push(...segmentHits(p, q, t))
  ts.sort((x, y) => x - y)
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1]!
    const t1 = ts[i]!
    if (t1 - t0 < 1e-9) continue
    const t = (t0 + t1) / 2
    const m: Vec2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    if (port.contains(air.region, m)) continue
    if (cuts.length > 0 && cuts.every((c) => port.contains(c.region, m))) continue
    return false
  }
  return true
}

/** The pieces of `area` near a box, as one region, and their boundary pieces. */
function nearOf(area: RestArea, box: Bounds2): { region: Region; boundary: Seg[] } {
  const near = area.pieces.filter((x) => overlaps(x.box, box))
  return {
    region: { pieces: near.flatMap((x) => x.region.pieces) },
    boundary: near.flatMap((x) => x.rings.flat()),
  }
}
