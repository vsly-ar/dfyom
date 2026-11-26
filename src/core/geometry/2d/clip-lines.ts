/**
 * Clipping lines (open paths and closed loops of lines and arcs) at a region's boundary
 * (engraved-patterns.md § Engraved pattern step 3, E4): a line is split where it crosses the
 * boundary and the pieces inside are kept. Exact (no flattening): the crossings come from the
 * element intersections of crossings.ts, the inside test from `regionContains` once per piece.
 * A bucket grid of the boundary's elements keeps a line far from the boundary to one box test.
 * Doc: docs/modes/engraved-patterns.md#implementation-e4
 */
import type { Vec2 } from '../model'
import { intersect } from './crossings'
import { elementPointAt, regionContains } from './measure'
import {
  arc,
  chainBounds,
  elementLength,
  line,
  regionLoops,
  type Bounds2,
  type Element,
  type Region,
} from './model'

/** Pieces shorter than this (mm) are dropped, and cuts closer than it merged. */
const CLIP_EPS = 1e-6

/** The boundary of a region with its elements bucketed by their boxes. */
export class ClipBoundary {
  readonly region: Region
  private readonly elements: Element[]
  private readonly boxes: Bounds2[]
  private readonly grid = new Map<string, number[]>()
  private readonly size: number
  constructor(region: Region) {
    this.region = region
    this.elements = regionLoops(region).flatMap((l) => [...l.elements])
    this.boxes = this.elements.map((e) => chainBounds([e])!)
    const all = chainBounds(this.elements)
    const span =
      all === undefined ? 1 : Math.max(all.max[0] - all.min[0], all.max[1] - all.min[1], 1)
    this.size = span / Math.max(1, Math.ceil(Math.sqrt(this.elements.length)))
    this.boxes.forEach((bx, i) => {
      for (const k of this.keys(bx)) {
        const list = this.grid.get(k)
        if (list === undefined) this.grid.set(k, [i])
        else list.push(i)
      }
    })
  }
  private *keys(b: Bounds2): Generator<string> {
    const s = this.size
    for (let x = Math.floor(b.min[0] / s); x <= Math.floor(b.max[0] / s); x++)
      for (let y = Math.floor(b.min[1] / s); y <= Math.floor(b.max[1] / s); y++) yield `${x},${y}`
  }
  /** The boundary elements whose boxes meet `b` (each once). */
  near(b: Bounds2): Element[] {
    const eps = 1e-6
    const seen = new Set<number>()
    const out: Element[] = []
    for (const k of this.keys(b))
      for (const i of this.grid.get(k) ?? []) {
        if (seen.has(i)) continue
        seen.add(i)
        const e = this.boxes[i]!
        if (
          e.min[0] <= b.max[0] + eps &&
          e.max[0] >= b.min[0] - eps &&
          e.min[1] <= b.max[1] + eps &&
          e.max[1] >= b.min[1] - eps
        )
          out.push(this.elements[i]!)
      }
    return out
  }
  contains(p: Vec2): boolean {
    return regionContains(this.region, p)
  }
}

/** A kept piece of a line: its elements and where it lies along the line (arc length, mm). */
export interface ClipRun {
  readonly elements: readonly Element[]
  readonly from: number
  readonly to: number
}

/** The line wholly inside, wholly outside, or the pieces inside (open runs). */
export type Clipped = 'inside' | 'outside' | readonly ClipRun[]

/** The part of an element between parameters `t0` < `t1`. */
function subElement(e: Element, t0: number, t1: number): Element {
  const p0 = t0 <= 0 ? e.a : elementPointAt(e, t0).point
  const p1 = t1 >= 1 ? e.b : elementPointAt(e, t1).point
  return e.kind === 'line' ? line(p0, p1) : arc(p0, p1, e.centre, e.ccw)
}

/**
 * A line clipped to the boundary's region: `inside` / `outside` when it does not cross it, else
 * the pieces inside, in order along the line (a loop's pieces are open runs; one passing the
 * loop's start runs on across it). Touching the boundary from inside does not split a piece.
 */
export function clipLine(
  elements: readonly Element[],
  closed: boolean,
  boundary: ClipBoundary,
): Clipped {
  const n = elements.length
  if (n === 0) return 'outside'
  const starts: number[] = []
  const lens: number[] = []
  let L = 0
  for (const e of elements) {
    starts.push(L)
    const len = elementLength(e)
    lens.push(len)
    L += len
  }
  const cuts: number[] = []
  elements.forEach((e, i) => {
    const near = boundary.near(chainBounds([e])!)
    for (const f of near) {
      const hits = intersect(e, f)
      if (hits === 'overlap') continue
      for (const h of hits) cuts.push(starts[i]! + h.s * lens[i]!)
    }
  })
  const at = (s: number): Vec2 => {
    const x = closed ? ((s % L) + L) % L : Math.min(L, Math.max(0, s))
    let i = 0
    while (i < n - 1 && starts[i + 1]! <= x) i++
    return elementPointAt(elements[i]!, lens[i]! > 0 ? (x - starts[i]!) / lens[i]! : 0).point
  }
  cuts.sort((a, b) => a - b)
  const uniq: number[] = []
  for (const c of cuts) {
    if (!closed && (c <= CLIP_EPS || c >= L - CLIP_EPS)) continue
    if (uniq.length === 0 || c - uniq.at(-1)! > CLIP_EPS) uniq.push(c)
  }
  if (closed && uniq.length > 1 && uniq[0]! + L - uniq.at(-1)! <= CLIP_EPS) uniq.pop()
  if (uniq.length === 0) return boundary.contains(at(L / 2)) ? 'inside' : 'outside'
  // intervals between cuts (a loop's last one wraps to the first cut)
  const bounds: [number, number][] = []
  if (closed) {
    for (let k = 0; k < uniq.length; k++)
      bounds.push([uniq[k]!, k + 1 < uniq.length ? uniq[k + 1]! : uniq[0]! + L])
  } else {
    let prev = 0
    for (const c of uniq) {
      bounds.push([prev, c])
      prev = c
    }
    bounds.push([prev, L])
  }
  // touching pieces kept on both sides go on as one
  const kept: [number, number][] = []
  let allIn = true
  for (const [a, b] of bounds) {
    if (b - a <= CLIP_EPS) continue
    if (!boundary.contains(at((a + b) / 2))) {
      allIn = false
      continue
    }
    const last = kept.at(-1)
    if (last !== undefined && Math.abs(last[1] - a) <= CLIP_EPS) last[1] = b
    else kept.push([a, b])
  }
  if (allIn) return 'inside'
  if (closed && kept.length > 1) {
    const first = kept[0]!
    const last = kept.at(-1)!
    if (Math.abs(last[1] - (first[0] + L)) <= CLIP_EPS) {
      last[1] = first[1] + L
      kept.shift()
    }
  }
  return kept.map(([a, b]) => ({
    elements: slice(elements, starts, lens, L, a, b),
    from: a,
    to: b,
  }))
}

/** The elements between arc lengths `a` < `b` (a loop's `b` may pass L: it wraps once). */
function slice(
  elements: readonly Element[],
  starts: readonly number[],
  lens: readonly number[],
  L: number,
  a: number,
  b: number,
): Element[] {
  const out: Element[] = []
  const n = elements.length
  const span = (lo: number, hi: number) => {
    for (let i = 0; i < n; i++) {
      const s0 = starts[i]!
      const s1 = s0 + lens[i]!
      if (s1 <= lo + CLIP_EPS || s0 >= hi - CLIP_EPS) continue
      const t0 = lens[i]! > 0 ? Math.max(0, (lo - s0) / lens[i]!) : 0
      const t1 = lens[i]! > 0 ? Math.min(1, (hi - s0) / lens[i]!) : 1
      out.push(t0 <= 0 && t1 >= 1 ? elements[i]! : subElement(elements[i]!, t0, t1))
    }
  }
  if (b <= L + CLIP_EPS) span(a, Math.min(b, L))
  else {
    span(a, L)
    span(0, b - L)
  }
  return out
}
