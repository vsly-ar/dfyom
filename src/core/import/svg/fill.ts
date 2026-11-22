/**
 * Closed loops of one imported shape → oriented, non-crossing loops by the elements' fill rules:
 * each element fills by its own rule (`nonzero`: winding ≠ 0, `evenodd`: odd), and the elements
 * of one shape combine even-odd (a point filled by an odd number of them is inside).
 * Loops become outer loops (counter-clockwise, `add`) and holes (clockwise, `subtract`); a loop
 * with the same fill on both sides is dropped. Crossing, self-crossing or overlapping loops are
 * repaired: split at their intersections, the edges between filled and unfilled kept and chained
 * again. Pure TS, no 2D port.
 * Doc: docs/architecture/shapes.md#svg-import
 */
import type { Vec2 } from '../../geometry/model'
import {
  arc,
  chainBounds,
  elementLength,
  line,
  reverseLoop,
  signedArea,
  type Bounds2,
  type Element,
  type Loop,
} from '../../geometry/2d/model'
import { elementPointAt, windingNumber } from '../../geometry/2d/measure'
import { HIT_EPSILON, intersect, type Hit } from './intersect'

export type FillRule = 'nonzero' | 'evenodd'

/** The closed loops of one element (or of one SVG source of fill) with its fill rule. */
export interface FillSource {
  readonly rule: FillRule
  readonly loops: readonly Loop[]
}

export interface FilledLoop {
  readonly loop: Loop
  /** `add`: an outer loop (counter-clockwise); `subtract`: a hole (clockwise). */
  readonly op: 'add' | 'subtract'
}

export interface FillResult {
  /** By decreasing |area|, so a containing loop comes before the loops inside it. */
  readonly loops: FilledLoop[]
  /** Source loops that crossed or overlapped a loop (themselves included) and were rebuilt. */
  readonly repaired: number
  /** Source loops dropped because both sides had the same fill. */
  readonly dropped: number
  /** Edge chains that did not close after the repair (dropped; expected 0). */
  readonly unclosed: number
}

/** Smallest loop area kept (mm²), as the 2D port's lobe rule. */
export const MIN_LOOP_AREA = 1e-8

interface Indexed {
  readonly loop: Loop
  readonly source: number
  readonly bounds: Bounds2
}

/**
 * Whether `p` is inside the shape: each source fills by its own rule, and the sources combine
 * even-odd (a point filled by two elements is outside), so a loop drawn as its own element inside
 * another becomes a hole, as CAM users draw holes.
 */
function filled(all: readonly Indexed[], rules: readonly FillRule[], p: Vec2): boolean {
  const w = new Array<number>(rules.length).fill(0)
  for (const l of all) {
    const b = l.bounds
    if (p[0] < b.min[0] || p[0] > b.max[0] || p[1] < b.min[1] || p[1] > b.max[1]) continue
    w[l.source]! += windingNumber(l.loop, p)
  }
  let inside = false
  rules.forEach((r, i) => {
    if (r === 'nonzero' ? w[i] !== 0 : Math.abs(w[i]!) % 2 === 1) inside = !inside
  })
  return inside
}

/** Fill just left and right of the middle of element `e`. */
function sides(
  all: readonly Indexed[],
  rules: readonly FillRule[],
  e: Element,
): { left: boolean; right: boolean } {
  const { point: m, tangent: t } = elementPointAt(e, 0.5)
  const d = Math.min(1e-5, elementLength(e) / 8)
  const n: Vec2 = [-t[1], t[0]]
  return {
    left: filled(all, rules, [m[0] + n[0] * d, m[1] + n[1] * d]),
    right: filled(all, rules, [m[0] - n[0] * d, m[1] - n[1] * d]),
  }
}

function longest(l: Loop): Element {
  let best = l.elements[0]!
  let bl = -1
  for (const e of l.elements) {
    const len = elementLength(e)
    if (len > bl) {
      bl = len
      best = e
    }
  }
  return best
}

interface Ref {
  readonly loop: number
  readonly element: number
  readonly box: Bounds2
}

interface Hits {
  /** Interior hits per element (keyed `loop:element`). */
  readonly split: Map<string, Hit[]>
  /** Loops with a crossing, a touch inside an element or a coincident element. */
  readonly loops: Set<number>
}

/**
 * Where elements meet other than end to end: hits inside an element split it; elements that
 * coincide (same ends, same course) need no split but still the repair, which merges them.
 */
function findHits(all: readonly Indexed[]): Hits {
  const refs: Ref[] = []
  all.forEach((l, li) =>
    l.loop.elements.forEach((e, ei) =>
      refs.push({ loop: li, element: ei, box: chainBounds([e])! }),
    ),
  )
  refs.sort((a, b) => a.box.min[0] - b.box.min[0])
  const hits = new Map<string, Hit[]>()
  const loops = new Set<number>()
  const push = (key: string, h: Hit): void => {
    const list = hits.get(key)
    if (list) list.push(h)
    else hits.set(key, [h])
  }
  const isEnd = (u: number): boolean => u <= 1e-12 || u >= 1 - 1e-12
  const active: Ref[] = []
  for (const r of refs) {
    for (let k = active.length - 1; k >= 0; k--)
      if (active[k]!.box.max[0] < r.box.min[0] - HIT_EPSILON) active.splice(k, 1)
    for (const q of active) {
      if (q.box.max[1] < r.box.min[1] - HIT_EPSILON || r.box.max[1] < q.box.min[1] - HIT_EPSILON)
        continue
      const e = all[q.loop]!.loop.elements[q.element]!
      const f = all[r.loop]!.loop.elements[r.element]!
      const found = intersect(e, f)
      if (found.length >= 2 && coincide(e, f)) {
        loops.add(q.loop)
        loops.add(r.loop)
      }
      for (const h of found) {
        const endE = isEnd(h.s) || near(h.p, e.a) || near(h.p, e.b)
        const endF = isEnd(h.t) || near(h.p, f.a) || near(h.p, f.b)
        if (endE && endF) continue
        loops.add(q.loop)
        loops.add(r.loop)
        // the point is shared by both elements, so both split at the same coordinates
        if (!endE) push(`${q.loop}:${q.element}`, { p: h.p, s: h.s, t: h.s })
        if (!endF) push(`${r.loop}:${r.element}`, { p: h.p, s: h.t, t: h.t })
      }
    }
    active.push(r)
  }
  return { split: hits, loops }
}

/** Same end points (either way) and the same middle point: one element drawn twice. */
function coincide(e: Element, f: Element): boolean {
  const ends = (near(e.a, f.a) && near(e.b, f.b)) || (near(e.a, f.b) && near(e.b, f.a))
  return ends && near(elementPointAt(e, 0.5).point, elementPointAt(f, 0.5).point)
}

const near = (p: Vec2, q: Vec2): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= HIT_EPSILON

/** Element `e` split at the hit points (sorted along it). */
function split(e: Element, hs: readonly Hit[]): Element[] {
  const pts = [...hs].sort((x, y) => x.s - y.s).map((h) => h.p)
  const out: Element[] = []
  let prev = e.a
  for (const p of [...pts, e.b]) {
    if (near(prev, p)) continue
    out.push(e.kind === 'line' ? line(prev, p) : arc(prev, p, e.centre, e.ccw))
    prev = p
  }
  if (out.length === 0) return [e]
  // keep the exact end point
  const last = out[out.length - 1]!
  if (last.b !== e.b)
    out[out.length - 1] =
      last.kind === 'line' ? line(last.a, e.b) : arc(last.a, e.b, last.centre, last.ccw)
  return out
}

/** Snaps points closer than `HIT_EPSILON` to one vertex id. */
class Vertices {
  private readonly cells = new Map<string, number[]>()
  readonly points: Vec2[] = []
  id(p: Vec2): number {
    const cx = Math.floor(p[0] / (HIT_EPSILON * 4))
    const cy = Math.floor(p[1] / (HIT_EPSILON * 4))
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const id of this.cells.get(`${cx + i},${cy + j}`) ?? [])
          if (near(this.points[id]!, p)) return id
    const id = this.points.length
    this.points.push(p)
    const key = `${cx},${cy}`
    const list = this.cells.get(key)
    if (list) list.push(id)
    else this.cells.set(key, [id])
    return id
  }
}

interface Edge {
  readonly from: number
  readonly to: number
  readonly e: Element
}

const angle = (u: Vec2, v: Vec2): number =>
  Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])

/** Rebuilds crossing loops: split, keep the fill boundary, chain again (filled side on the left). */
function repair(
  all: readonly Indexed[],
  rules: readonly FillRule[],
  hits: ReadonlyMap<string, readonly Hit[]>,
): { loops: Loop[]; unclosed: number } {
  const verts = new Vertices()
  const seen = new Set<string>()
  const edges: Edge[] = []
  all.forEach((l, li) =>
    l.loop.elements.forEach((e0, ei) => {
      const hs = hits.get(`${li}:${ei}`)
      for (const e of hs ? split(e0, hs) : [e0]) {
        const from = verts.id(e.a)
        const to = verts.id(e.b)
        if (from === to && elementLength(e) < HIT_EPSILON * 10) continue
        const mid = elementPointAt(e, 0.5).point
        const key = `${Math.min(from, to)},${Math.max(from, to)},${Math.round(mid[0] / 1e-6)},${Math.round(mid[1] / 1e-6)}`
        if (seen.has(key)) continue
        seen.add(key)
        const s = sides(all, rules, e)
        if (s.left === s.right) continue
        const a = verts.points[from]!
        const b = verts.points[to]!
        const snapped = e.kind === 'line' ? line(a, b) : arc(a, b, e.centre, e.ccw)
        if (s.left) edges.push({ from, to, e: snapped })
        else
          edges.push({
            from: to,
            to: from,
            e: snapped.kind === 'line' ? line(b, a) : arc(b, a, snapped.centre, !snapped.ccw),
          })
      }
    }),
  )
  const outgoing = new Map<number, number[]>()
  edges.forEach((ed, i) => {
    const list = outgoing.get(ed.from)
    if (list) list.push(i)
    else outgoing.set(ed.from, [i])
  })
  const used = new Array<boolean>(edges.length).fill(false)
  const loops: Loop[] = []
  let unclosed = 0
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue
    used[s] = true
    const chain: Element[] = [edges[s]!.e]
    const start = edges[s]!.from
    let at = edges[s]!.to
    let ok = true
    while (at !== start) {
      const prev = chain[chain.length - 1]!
      const tin = elementPointAt(prev, 1).tangent
      let best = -1
      let bestTurn = -Infinity
      for (const i of outgoing.get(at) ?? []) {
        if (used[i]) continue
        const turn = angle(tin, elementPointAt(edges[i]!.e, 0).tangent)
        if (turn > bestTurn) {
          bestTurn = turn
          best = i
        }
      }
      if (best < 0) {
        ok = false
        break
      }
      used[best] = true
      chain.push(edges[best]!.e)
      at = edges[best]!.to
    }
    if (ok) loops.push({ elements: chain })
    else unclosed++
  }
  return { loops, unclosed }
}

/** Classifies (and if needed repairs) the closed loops of one shape. */
export function fillLoops(sources: readonly FillSource[]): FillResult {
  const rules = sources.map((s) => s.rule)
  const all: Indexed[] = []
  sources.forEach((s, si) =>
    s.loops.forEach((loop) => {
      if (loop.elements.length > 0)
        all.push({ loop, source: si, bounds: chainBounds(loop.elements)! })
    }),
  )
  const hits = findHits(all)
  let out: Loop[] = []
  let repaired = 0
  let dropped = 0
  let unclosed = 0
  if (hits.loops.size > 0) {
    repaired = hits.loops.size
    const r = repair(all, rules, hits.split)
    out = r.loops
    unclosed = r.unclosed
  } else {
    for (const l of all) {
      const s = sides(all, rules, longest(l.loop))
      if (s.left === s.right) dropped++
      else out.push(s.left ? l.loop : reverseLoop(l.loop))
    }
  }
  const loops = out
    .map((loop) => ({ loop, area: signedArea(loop) }))
    .filter((l) => Math.abs(l.area) > MIN_LOOP_AREA && l.loop.elements.length >= 2)
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area))
    .map((l): FilledLoop => ({ loop: l.loop, op: l.area > 0 ? 'add' : 'subtract' }))
  return { loops, repaired, dropped, unclosed }
}
