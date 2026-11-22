// Spike S4 (docs/research/s4-offset-clearing.md): turning the ring tree into one level of moves
// (src/core/toolpath/model.ts types, so the toolpath heightmap oracle can sweep it), two ways:
// - `rings`: plain ring by ring, deepest first, every ring entered from the retract plane;
// - `linked`: post-order tree traversal (each branch from its innermost ring outwards), feed links
//   between rings inside the parent's region, a retract only to start another leaf.

import type { Candidate } from '../2d/candidates.ts'
import { arcOf, segments, type Loop, type Pt } from '../2d/geom.ts'
import type { Move, Toolpath, Vec3 } from '../../src/core/toolpath/model.ts'
import { toolpathStats } from '../../src/core/toolpath/stats.ts'
import {
  closest,
  components,
  distToLoops,
  inComponent,
  loopLength,
  loopsOf,
  startAt,
  type Component,
} from './loops.ts'
import type { RingNode } from './tree.ts'

export interface CutParams {
  readonly toolRadius: number
  /** Floor of this level (negative, mm). */
  readonly z: number
  /** Top of this level (the previous floor or the stock top). */
  readonly top: number
  readonly retractZ: number
  readonly feed: number
  readonly plungeFeed: number
  readonly helixDiameter: number
  /** Degrees; also the helix pitch angle. */
  readonly rampAngle: number
}

export type Order = 'rings' | 'linked'

export interface Counts {
  /** Lifts to the retract plane between cuts (the first approach not counted). */
  retracts: number
  feedLinks: number
  helix: number
  ramp: number
  plunge: number
}

const ENTRY_CLEAR = 0.5 // start entries this far above the level top

class Writer {
  readonly moves: Move[] = []
  pos: Vec3
  readonly counts: Counts = { retracts: 0, feedLinks: 0, helix: 0, ramp: 0, plunge: 0 }
  constructor(readonly p: CutParams) {
    this.pos = [0, 0, p.retractZ]
  }
  get xy(): Pt {
    return { x: this.pos[0], y: this.pos[1] }
  }
  private push(m: Exclude<Move, { kind: 'drill' }>): void {
    this.moves.push(m)
    this.pos = m.to
  }
  rapid(x: number, y: number, z: number): void {
    this.push({ kind: 'rapid', to: [x, y, z] })
  }
  line(x: number, y: number, z: number, feed = this.p.feed): void {
    this.push({ kind: 'line', to: [x, y, z], feed })
  }
  arc(x: number, y: number, z: number, cx: number, cy: number, cw: boolean): void {
    this.push({ kind: 'arc', to: [x, y, z], center: [cx, cy], cw, feed: this.p.feed })
  }
  /** Retract (if down), rapid over to `p` and down to just above the level. */
  goTo(p: Pt): void {
    if (this.moves.length > 0) {
      if (this.pos[2] < this.p.retractZ) {
        this.counts.retracts++
        this.rapid(this.pos[0], this.pos[1], this.p.retractZ)
      }
    }
    this.rapid(p.x, p.y, this.p.retractZ)
    this.rapid(p.x, p.y, this.p.top + ENTRY_CLEAR)
  }
  /** A closed loop from its first vertex, Z from z0 to z1 linearly by length (z0 = z1: flat). */
  loop(l: Loop, z0 = this.p.z, z1 = z0): void {
    const total = loopLength(l)
    let run = 0
    for (const [a, b] of segments(l)) {
      const arc = arcOf(a, b)
      run += arc ? arc.r * Math.abs(arc.sweep) : Math.hypot(b[0] - a[0], b[1] - a[1])
      const z = z0 + (z1 - z0) * (total > 0 ? run / total : 1)
      if (arc) this.arc(b[0], b[1], z, arc.c.x, arc.c.y, arc.sweep < 0)
      else this.line(b[0], b[1], z)
    }
  }
}

/** Centre of (approximately) the largest circle inside a component: offset until empty. */
export function deepestPoint(cc: Candidate, c: Component): { p: Pt; r: number } {
  let lo = 0
  let hi = 1
  while (cc.offset(loopsOf(c), hi).length > 0) hi *= 2
  let last: Loop[] = loopsOf(c)
  for (let k = 0; k < 30 && hi - lo > 1e-4; k++) {
    const mid = (lo + hi) / 2
    const res = cc.offset(loopsOf(c), mid)
    if (res.length > 0) {
      lo = mid
      last = res
    } else hi = mid
  }
  const comp = components(last)[0]
  const vs = (comp ?? { outer: last[0]! }).outer.verts
  const p = {
    x: vs.reduce((s, v) => s + v[0], 0) / vs.length,
    y: vs.reduce((s, v) => s + v[1], 0) / vs.length,
  }
  return { p, r: lo }
}

/**
 * Enter a leaf: `helix` at the leaf's deepest point if the helix (radius min(helixDiameter, D)/2)
 * stays inside the root's tool-centre region; else `ramp` along the leaf's ring, lapping it; else
 * (ring shorter than D) `plunge`. Leaves the tool at the level floor on the leaf ring's start.
 */
function enterLeaf(
  w: Writer,
  cc: Candidate,
  leaf: Component,
  root: Component,
  ring: () => Loop,
): Loop {
  const p = w.p
  const R = p.toolRadius
  const rh = Math.min(p.helixDiameter, 2 * R) / 2
  const z0 = p.top + ENTRY_CLEAR
  const tan = Math.tan((p.rampAngle * Math.PI) / 180)
  const { p: c } = deepestPoint(cc, leaf)
  const fits =
    inComponent(root, c) && distToLoops(loopsOf(root), c) >= rh - 1e-9 && inComponent(leaf, c)
  if (fits) {
    w.counts.helix++
    w.goTo({ x: c.x + rh, y: c.y })
    const perHalf = Math.PI * rh * tan
    const n = Math.max(1, Math.ceil((z0 - p.z) / perHalf))
    for (let k = 1; k <= n; k++) {
      const z = z0 - ((z0 - p.z) * k) / n
      const sx = k % 2 === 1 ? c.x - rh : c.x + rh
      w.arc(sx, c.y, z, c.x, c.y, false)
    }
    // one flat circle at the floor
    const end = n % 2 === 1 ? c.x - rh : c.x + rh
    w.arc(2 * c.x - end, c.y, p.z, c.x, c.y, false)
    w.arc(end, c.y, p.z, c.x, c.y, false)
    const l = ring()
    const cl = closest(l, w.xy)
    const s = startAt(l, cl.seg, cl.t)
    w.line(s.verts[0]![0], s.verts[0]![1], p.z)
    return s
  }
  const l = ring()
  const cl = closest(l, w.xy)
  const s = startAt(l, cl.seg, cl.t)
  const len = loopLength(s)
  w.goTo({ x: s.verts[0]![0], y: s.verts[0]![1] })
  if (len >= 2 * R) {
    w.counts.ramp++
    const need = (z0 - p.z) / tan
    const laps = Math.max(1, Math.ceil(need / len))
    for (let k = 0; k < laps; k++)
      w.loop(s, z0 - ((z0 - p.z) * k) / laps, z0 - ((z0 - p.z) * (k + 1)) / laps)
  } else {
    w.counts.plunge++
    w.line(s.verts[0]![0], s.verts[0]![1], p.z, p.plungeFeed)
  }
  return s
}

/** Straight feed from the tool to `to` if every point of it lies in `c` (1 µm slack). */
function linkSafe(c: Component, from: Pt, to: Pt): boolean {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  const n = Math.max(1, Math.ceil(len / 0.1))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    if (!inComponent(c, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, 1e-3))
      return false
  }
  return true
}

/** Cut a node's rings (outer and islands), then its gap rings, nearest first, feed-linked where safe. */
function cutRings(w: Writer, node: RingNode, first?: Loop): void {
  const todo = loopsOf(node.comp)
  if (first) {
    // the entry already chose the start of one of them; cut it first
    const f = { x: first.verts[0]![0], y: first.verts[0]![1] }
    const i = todo.findIndex((l) => closest(l, f).d < 1e-6)
    if (i >= 0) todo.splice(i, 1)
    w.loop(first)
  }
  cutLoops(w, node.comp, todo)
  cutLoops(w, node.comp, [...node.gaps])
}

function cutLoops(w: Writer, comp: Component, todo: Loop[]): void {
  while (todo.length > 0) {
    // the nearest loop a straight feed link reaches inside the node's region; else the nearest
    const cands = todo.map((l, i) => ({ i, c: closest(l, w.xy) })).sort((a, b) => a.c.d - b.c.d)
    const down = w.pos[2] <= w.p.z + 1e-9
    const safe = down ? cands.find(({ c }) => linkSafe(comp, w.xy, c.p)) : undefined
    const pick = safe ?? cands[0]!
    const l = startAt(todo[pick.i]!, pick.c.seg, pick.c.t)
    todo.splice(pick.i, 1)
    const s = { x: l.verts[0]![0], y: l.verts[0]![1] }
    if (safe) {
      w.counts.feedLinks++
      w.line(s.x, s.y, w.p.z)
    } else {
      w.goTo(s)
      w.counts.plunge++
      w.line(s.x, s.y, w.p.z, w.p.plungeFeed)
    }
    w.loop(l)
  }
}

function distToComp(c: Component, p: Pt): number {
  return inComponent(c, p) ? 0 : distToLoops(loopsOf(c), p)
}

function linked(w: Writer, cc: Candidate, node: RingNode, root: Component): void {
  if (node.children.length === 0) {
    const first = enterLeaf(w, cc, node.comp, root, () => node.comp.outer)
    cutRings(w, node, first)
    return
  }
  const left = [...node.children]
  while (left.length > 0) {
    let bi = 0
    for (let i = 1; i < left.length; i++)
      if (distToComp(left[i]!.comp, w.xy) < distToComp(left[bi]!.comp, w.xy)) bi = i
    const child = left.splice(bi, 1)[0]!
    linked(w, cc, child, root)
  }
  cutRings(w, node)
}

function ringByRing(w: Writer, cc: Candidate, roots: readonly RingNode[]): void {
  const all: { node: RingNode; level: number; root: Component }[] = []
  const visit = (n: RingNode, level: number, root: Component) => {
    all.push({ node: n, level, root })
    for (const c of n.children) visit(c, level + 1, root)
  }
  for (const r of roots) visit(r, 0, r.comp)
  all.sort((a, b) => b.level - a.level)
  for (const { node, root } of all) {
    if (node.children.length === 0) {
      const first = enterLeaf(w, cc, node.comp, root, () => node.comp.outer)
      w.loop(first)
      for (const h of node.comp.holes) plungeLoop(w, h)
    } else for (const l of loopsOf(node.comp)) plungeLoop(w, l)
    for (const g of node.gaps) plungeLoop(w, g)
  }
}

function plungeLoop(w: Writer, l0: Loop): void {
  const c = closest(l0, w.xy)
  const l = startAt(l0, c.seg, c.t)
  const s = { x: l.verts[0]![0], y: l.verts[0]![1] }
  w.goTo(s)
  w.counts.plunge++
  w.line(s.x, s.y, w.p.z, w.p.plungeFeed)
  w.loop(l)
}

export const MAX_FEED: Vec3 = [5000, 5000, 2000] // rapid rates (mm/min) for the time estimate

export function clearing(
  cc: Candidate,
  roots: readonly RingNode[],
  p: CutParams,
  order: Order,
): { toolpath: Toolpath; counts: Counts } {
  const w = new Writer(p)
  if (order === 'rings') ringByRing(w, cc, roots)
  else {
    const left = [...roots]
    while (left.length > 0) {
      let bi = 0
      for (let i = 1; i < left.length; i++)
        if (distToComp(left[i]!.comp, w.xy) < distToComp(left[bi]!.comp, w.xy)) bi = i
      const r = left.splice(bi, 1)[0]!
      linked(w, cc, r, r.comp)
    }
  }
  w.rapid(w.pos[0], w.pos[1], p.retractZ)
  const passes = [{ kind: 'rough' as const, moves: w.moves }]
  return {
    toolpath: {
      planOperationId: 'spike',
      tool: 'D6',
      spindleSpeed: 18000,
      passes,
      stats: toolpathStats(passes, MAX_FEED),
    },
    counts: w.counts,
  }
}
