/**
 * Automatic arrangement of four toe clamps (v0.4-llm-first W6, `plan.workholding.set { auto:
 * 'toeClamps' }`): two clamps on each of two opposite stock edges, in the waste, clear of every
 * move of the setup's toolpaths and of the setup's other items.
 * Doc: docs/modes/workholding.md#automatic-arrangement-w6
 *
 * Pure and headless; mm in the setup frame (the items' frame: toolpaths in the WCS are shifted
 * back by the work zero before they come here, `checkOperations`). The search is conservative:
 * the clamp's keep-out is taken as its rectangle grown by a square (not a round) of the tool
 * radius plus the margin, so a placement it accepts passes the exact `checkWorkholding`.
 */
import type { Vec2 } from '../../geometry/model'
import type { Move, Vec3 } from '../../toolpath/model'
import { arcSweep, expandDrill, PECK_CLEARANCE } from '../../toolpath/stats'
import type { CheckOperation } from './check'
import { acrossEdge, edgeLength, type Edge, type SetupStock } from './items'
import { footprintBounds, type Prism } from './obstacles'

/** The clamp every automatic placement uses (mm). */
export interface ClampSize {
  readonly width: number
  readonly grip: number
  readonly reach: number
  readonly top: number
}

export interface ArrangeInput {
  readonly stock: SetupStock
  /** The setup's toolpaths in machining order (setup frame). */
  readonly operations: readonly CheckOperation[]
  /** The program's clearance height now: rapids at it are links, which rise with the clamps. */
  readonly clearanceZ: number
  readonly margin: number
  readonly clamp: ClampSize
  /** The setup's items that stay (screws, blocks): a clamp keeps the margin from them. */
  readonly others: readonly Prism[]
  /**
   * Whether the clamp's grip (its rectangle over the stock, setup frame `[min, max]`) lies in the
   * waste with the margin; absent = no through outline on this face, every spot is allowed.
   */
  readonly inWaste?: (grip: readonly [Vec2, Vec2]) => boolean
  /** Positions are multiples of this (mm): 1 mm, or 1/16″ in an inch project. */
  readonly step: number
}

export interface PlacedClamp {
  readonly edge: Edge
  /** Centre along the edge (the item's `at`, mm). */
  readonly at: number
}

/** What one edge has room for. */
export interface EdgeRoom {
  readonly edge: Edge
  /** Clamps placed on it (0–2). */
  readonly fits: number
  /** Ranges of clamp centres clear of the toolpaths, the items and the part (mm, `at`). */
  readonly free: readonly (readonly [number, number])[]
}

/** Four clamps, or every edge's room (front, back, left, right) when no pair takes two each. */
export type Arrangement =
  { readonly clamps: readonly PlacedClamp[] } | { readonly edges: readonly EdgeRoom[] }

/** Chord sagitta for arcs (mm); added to the clearance. */
const ARC_CHORD = 0.05
const EPS = 1e-6

interface Segment {
  readonly a: Vec3
  readonly b: Vec3
  /** Tool radius + sagitta + the margin it keeps (one margin for cuts, two for rapids). */
  readonly keep: number
}

/** XY chords of an arc, each at the arc's lowest Z (as the check). */
function arcChords(from: Vec3, m: Extract<Move, { kind: 'arc' }>): { pts: Vec3[]; slack: number } {
  const sweep = arcSweep(from, m)
  const r = Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
  const step = r <= ARC_CHORD ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - ARC_CHORD / r))
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step))
  const a0 = Math.atan2(from[1] - m.center[1], from[0] - m.center[0])
  const z = Math.min(from[2], m.to[2])
  const pts: Vec3[] = []
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n
    pts.push(
      k === n
        ? [m.to[0], m.to[1], z]
        : [m.center[0] + r * Math.cos(a), m.center[1] + r * Math.sin(a), z],
    )
  }
  return { pts, slack: r * (1 - Math.cos(Math.abs(sweep) / n / 2)) }
}

/**
 * Every move part that a clamp of `top` could meet: below its top + margin, not a link at the
 * clearance height (links rise above the clamps with the clearance they raise, WH-C).
 */
function sweptSegments(input: ArrangeInput): Segment[] {
  const { margin, clearanceZ } = input
  const zTop = input.clamp.top + margin
  const out: Segment[] = []
  let pos: Vec3 | undefined
  for (const op of input.operations) {
    const R = Math.max(op.tool.diameter, op.tool.shankDiameter ?? 0) / 2
    for (const raw of op.moves) {
      const moves: Exclude<Move, { kind: 'drill' }>[] =
        raw.kind === 'drill'
          ? [
              { kind: 'rapid', to: [raw.at[0], raw.at[1], raw.retract] },
              ...expandDrill(raw, PECK_CLEARANCE),
            ]
          : [raw]
      for (const m of moves) {
        const start: Vec3 = pos ?? m.to
        pos = m.to
        const cut = m.kind !== 'rapid'
        if (!cut && start[2] >= clearanceZ - EPS && m.to[2] >= clearanceZ - EPS) continue
        const keep = R + (cut ? margin : 2 * margin)
        if (m.kind === 'arc') {
          const { pts, slack } = arcChords(start, m)
          for (let k = 0; k + 1 < pts.length; k++)
            push(out, pts[k]!, pts[k + 1]!, keep + slack, zTop)
        } else push(out, start, m.to, keep, zTop)
      }
    }
  }
  return out
}

/** The part of ab below `z`, if any. */
function push(out: Segment[], a: Vec3, b: Vec3, keep: number, z: number): void {
  if (a[2] >= z && b[2] >= z) return
  if (a[2] < z && b[2] < z) {
    out.push({ a, b, keep })
    return
  }
  const t = (z - a[2]) / (b[2] - a[2])
  const m: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), z]
  out.push(a[2] < z ? { a, b: m, keep } : { a: m, b, keep })
}

/** Setup-frame point → (along the edge = the clamp's `at` axis, inward from the edge line). */
function local(edge: Edge, s: SetupStock): (p: readonly [number, number]) => Vec2 {
  switch (edge) {
    case 'vMin':
      return (p) => [p[0], p[1]]
    case 'vMax':
      return (p) => [p[0], s.width - p[1]]
    case 'uMin':
      return (p) => [p[1], p[0]]
    case 'uMax':
      return (p) => [p[1], s.length - p[0]]
  }
}

/** The grip rectangle of a clamp at `at` (setup frame). */
export function gripRect(
  edge: Edge,
  at: number,
  clamp: ClampSize,
  s: SetupStock,
): readonly [Vec2, Vec2] {
  const a = at - clamp.width / 2
  const b = at + clamp.width / 2
  const g = Math.min(clamp.grip, acrossEdge(edge, s))
  switch (edge) {
    case 'vMin':
      return [
        [a, 0],
        [b, g],
      ]
    case 'vMax':
      return [
        [a, s.width - g],
        [b, s.width],
      ]
    case 'uMin':
      return [
        [0, a],
        [g, b],
      ]
    case 'uMax':
      return [
        [s.length - g, a],
        [s.length, b],
      ]
  }
}

/**
 * The clamp centres an edge blocks: open intervals along the edge where a clamp (its rectangle
 * from `reach` outside to `grip` inside) would come within a segment's keep or an item's margin.
 */
function blocked(
  edge: Edge,
  input: ArrangeInput,
  segments: readonly Segment[],
): [number, number][] {
  const { stock, clamp, margin } = input
  const to = local(edge, stock)
  const half = clamp.width / 2
  const nLo = -clamp.reach
  const nHi = Math.min(clamp.grip, acrossEdge(edge, stock))
  const out: [number, number][] = []
  for (const seg of segments) {
    const d = seg.keep
    const a = to([seg.a[0], seg.a[1]])
    const b = to([seg.b[0], seg.b[1]])
    // clip to the band nLo − d ≤ n ≤ nHi + d
    let t0 = 0
    let t1 = 1
    const dn = b[1] - a[1]
    if (Math.abs(dn) < EPS) {
      if (a[1] <= nLo - d || a[1] >= nHi + d) continue
    } else {
      const u0 = (nLo - d - a[1]) / dn
      const u1 = (nHi + d - a[1]) / dn
      t0 = Math.max(t0, Math.min(u0, u1))
      t1 = Math.min(t1, Math.max(u0, u1))
      if (t0 > t1) continue
    }
    const s0 = a[0] + t0 * (b[0] - a[0])
    const s1 = a[0] + t1 * (b[0] - a[0])
    out.push([Math.min(s0, s1) - d - half, Math.max(s0, s1) + d + half])
  }
  for (const p of input.others) {
    const [min, max] = footprintBounds(p.footprint)
    const c = [to(min), to(max), to([min[0], max[1]]), to([max[0], min[1]])]
    const n0 = Math.min(...c.map((q) => q[1]))
    const n1 = Math.max(...c.map((q) => q[1]))
    if (n1 <= nLo - margin || n0 >= nHi + margin) continue
    const s0 = Math.min(...c.map((q) => q[0]))
    const s1 = Math.max(...c.map((q) => q[0]))
    out.push([s0 - margin - half, s1 + margin + half])
  }
  return out
}

/** Grid positions on the edge (the whole clamp width on the stock) not in a blocked interval. */
function freePositions(length: number, half: number, step: number, cuts: [number, number][]) {
  const first = Math.ceil((half - EPS) / step)
  const last = Math.floor((length - half + EPS) / step)
  const sorted = [...cuts].sort((p, q) => p[0] - q[0])
  const out: number[] = []
  let k = 0
  let reach = -Infinity
  for (let i = first; i <= last; i++) {
    const c = i * step
    // every interval starting before c: the furthest end
    while (k < sorted.length && sorted[k]![0] < c) reach = Math.max(reach, sorted[k++]![1])
    if (c < reach) continue
    out.push(c)
  }
  return out
}

/** Runs of consecutive grid positions as ranges. */
function runs(positions: readonly number[], step: number): [number, number][] {
  const out: [number, number][] = []
  for (const p of positions) {
    const last = out.at(-1)
    if (last !== undefined && p - last[1] <= step + EPS) last[1] = p
    else out.push([p, p])
  }
  return out
}

const ORDER: readonly Edge[] = ['vMin', 'vMax', 'uMin', 'uMax']

/**
 * Four toe clamps of `clamp`'s size: two on each of two opposite edges, the longer pair first.
 * On an edge the two go as near as they can to 1.5 clamp widths in from each end (a quarter of
 * the edge on a short one), each on its own half, at least a third of the edge and the clamp
 * width plus two margins apart.
 */
export function arrangeToeClamps(input: ArrangeInput): Arrangement {
  const { stock, clamp, step, margin } = input
  const segments = sweptSegments(input)
  const half = clamp.width / 2
  const room = new Map<Edge, { fits: number; free: () => number[]; pick?: [number, number] }>()
  for (const edge of ORDER) {
    const L = edgeLength(edge, stock)
    const free = freePositions(L, half, step, blocked(edge, input, segments))
    const waste = new Map<number, boolean>()
    const ok = (c: number) => {
      if (input.inWaste === undefined) return true
      let v = waste.get(c)
      if (v === undefined) waste.set(c, (v = input.inWaste(gripRect(edge, c, clamp, stock))))
      return v
    }
    const t1 = Math.min(1.5 * clamp.width, L / 4)
    // ties go towards the nearer end, so the pair is symmetric
    const nearest = (target: number, lo: number, hi: number, outward: number) =>
      free
        .filter((c) => c >= lo - EPS && c <= hi + EPS)
        .sort((p, q) => Math.abs(p - target) - Math.abs(q - target) || outward * (p - q))
        .find(ok)
    const a = nearest(t1, 0, L / 2, 1)
    const b = nearest(L - t1, L / 2, L, -1)
    const spread = Math.max(clamp.width + 2 * margin, L / 3)
    const both = a !== undefined && b !== undefined && b - a >= spread - EPS
    room.set(edge, {
      fits: both ? 2 : a !== undefined || b !== undefined ? 1 : 0,
      // the waste of every free spot only for the refusal message
      free: () => free.filter(ok),
      ...(both ? { pick: [a, b] } : {}),
    })
  }
  const pairs: [Edge, Edge][] =
    stock.length >= stock.width
      ? [
          ['vMin', 'vMax'],
          ['uMin', 'uMax'],
        ]
      : [
          ['uMin', 'uMax'],
          ['vMin', 'vMax'],
        ]
  for (const pair of pairs) {
    const picks = pair.map((e) => room.get(e)!.pick)
    if (picks.every((p) => p !== undefined))
      return { clamps: pair.flatMap((edge, k) => picks[k]!.map((at) => ({ edge, at }))) }
  }
  return {
    edges: ORDER.map((edge) => {
      const r = room.get(edge)!
      return { edge, fits: r.fits, free: runs(r.free(), step) }
    }),
  }
}
