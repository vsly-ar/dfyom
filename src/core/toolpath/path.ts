/**
 * Planar path pieces (lines, exact arcs) and the move builder shared by the generators.
 * Doc: docs/modes/plan-v0.1.md#toolpath-generators-task-210
 *
 * Rings come from `offsetContour` + `contourElements` (exact arcs, no flattening).
 */
import { contourElements, offsetContour, type ContourElement } from '../geometry/contour'
import { EPSILON, type Contour, type Vec2, type Vec3 } from '../geometry/model'
import type { Move, Pass, PassKind } from './model'

/** A planar path piece; an arc runs from `start` by `sweep` (counter-clockwise > 0). */
export type Seg =
  | { readonly kind: 'line'; readonly from: Vec2; readonly to: Vec2 }
  | {
      readonly kind: 'arc'
      readonly center: Vec2
      readonly radius: number
      readonly start: number
      readonly sweep: number
    }

/** A piece with Z running linearly from `z0` to `z1` along it. */
export interface Seg3 {
  readonly seg: Seg
  readonly z0: number
  readonly z1: number
}

export function segLength(s: Seg): number {
  return s.kind === 'line'
    ? Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])
    : s.radius * Math.abs(s.sweep)
}

/** Point at fraction `u` (0..1). */
export function segPoint(s: Seg, u: number): Vec2 {
  if (s.kind === 'line')
    return [s.from[0] + (s.to[0] - s.from[0]) * u, s.from[1] + (s.to[1] - s.from[1]) * u]
  const a = s.start + s.sweep * u
  return [s.center[0] + s.radius * Math.cos(a), s.center[1] + s.radius * Math.sin(a)]
}

/** The part of `s` between fractions `u0` and `u1`. */
export function segSlice(s: Seg, u0: number, u1: number): Seg {
  if (s.kind === 'line') return { kind: 'line', from: segPoint(s, u0), to: segPoint(s, u1) }
  return { ...s, start: s.start + s.sweep * u0, sweep: s.sweep * (u1 - u0) }
}

export function segReverse(s: Seg): Seg {
  return s.kind === 'line'
    ? { kind: 'line', from: s.to, to: s.from }
    : { ...s, start: s.start + s.sweep, sweep: -s.sweep }
}

function elementSeg(e: ContourElement, at: Vec2): Seg {
  return e.kind === 'line'
    ? {
        kind: 'line',
        from: [e.from[0] + at[0], e.from[1] + at[1]],
        to: [e.to[0] + at[0], e.to[1] + at[1]],
      }
    : {
        kind: 'arc',
        center: [e.center[0] + at[0], e.center[1] + at[1]],
        radius: e.radius,
        start: e.start,
        sweep: e.sweep,
      }
}

function elementLength(e: ContourElement): number {
  return e.kind === 'line'
    ? Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1])
    : e.radius * e.sweep
}

/**
 * Element index and fraction of arc length `s` on `c` (wraps). Lands on the start of the next
 * element of non-zero length when `s` is exactly at an element end.
 */
export function contourLocate(c: Contour, s: number): { element: number; fraction: number } {
  const els = contourElements(c)
  const lengths = els.map(elementLength)
  const total = lengths.reduce((a, b) => a + b, 0)
  if (total <= EPSILON) return { element: 0, fraction: 0 }
  const u = ((s % total) + total) % total
  let acc = 0
  for (let i = 0; i < els.length; i++) {
    const len = lengths[i]!
    if (len > 0 && u < acc + len - 1e-12) return { element: i, fraction: (u - acc) / len }
    acc += len
  }
  return { element: 0, fraction: 0 }
}

/**
 * The closed ring of `ring` (an offset of the shape `shape`, with the same elements), placed at
 * `at`, starting at the point that corresponds to arc length `s` on the shape: the same element
 * at the same fraction. Counter-clockwise unless `cw`. Zero-length pieces are dropped; a ring
 * collapsed to a point is empty.
 */
export function ringSegs(shape: Contour, ring: Contour, at: Vec2, s: number, cw: boolean): Seg[] {
  const { element, fraction } = contourLocate(shape, s)
  const els = contourElements(ring)
  const out: Seg[] = []
  const push = (seg: Seg) => {
    if (segLength(seg) > EPSILON) out.push(seg)
  }
  const first = elementSeg(els[element]!, at)
  push(segSlice(first, fraction, 1))
  for (let k = 1; k < els.length; k++) push(elementSeg(els[(element + k) % els.length]!, at))
  push(segSlice(first, 0, fraction))
  return cw ? out.reverse().map(segReverse) : out
}

/** `ringSegs` of the shape offset by `offset` (> 0 inward); empty if the offset passes the axis. */
export function offsetRing(
  shape: Contour,
  offset: number,
  at: Vec2,
  s: number,
  cw: boolean,
): Seg[] {
  return offsetContour(shape, offset)
    .map((ring) => ringSegs(shape, ring, at, s, cw))
    .unwrapOr([])
}

/**
 * The first `length` mm along the closed `ring` from its start, going round as often as
 * needed (`walked`), and one full lap from where that ends back to the same point (`lap`).
 */
export function walkRing(ring: readonly Seg[], length: number): { walked: Seg[]; lap: Seg[] } {
  const walked: Seg[] = []
  if (ring.length === 0) return { walked, lap: [] }
  let left = length
  for (;;) {
    for (let i = 0; i < ring.length; i++) {
      const s = ring[i]!
      const len = segLength(s)
      if (left <= len + 1e-9) {
        const u = Math.min(1, left / len)
        const head = u > 1e-12 ? [segSlice(s, 0, u)] : []
        const tail = u < 1 - 1e-12 ? [segSlice(s, u, 1)] : []
        walked.push(...head)
        return { walked, lap: [...tail, ...ring.slice(i + 1), ...ring.slice(0, i), ...head] }
      }
      walked.push(s)
      left -= len
    }
  }
}

export function segsLength(segs: readonly Seg[]): number {
  return segs.reduce((a, s) => a + segLength(s), 0)
}

/** Pieces with Z falling linearly over their total length from `z0` to `z1`. */
export function slope(segs: readonly Seg[], z0: number, z1: number): Seg3[] {
  const total = segsLength(segs)
  let acc = 0
  return segs.map((seg) => {
    const a = acc
    acc += segLength(seg)
    return {
      seg,
      z0: z0 + ((z1 - z0) * a) / total,
      z1: z0 + ((z1 - z0) * acc) / total,
    }
  })
}

export const flat = (segs: readonly Seg[], z: number): Seg3[] =>
  segs.map((seg) => ({ seg, z0: z, z1: z }))

const same = (a: Vec3, b: Vec3) =>
  Math.abs(a[0] - b[0]) <= EPSILON &&
  Math.abs(a[1] - b[1]) <= EPSILON &&
  Math.abs(a[2] - b[2]) <= EPSILON

/**
 * Collects passes of moves and tracks the position, so every move starts where the previous
 * one ended. Arcs are split into pieces of at most 180° (unambiguous for G2/G3 and previews).
 */
export class MoveBuilder {
  private readonly passes: { kind: PassKind; moves: Move[] }[] = []
  private current: Vec3 | undefined

  get position(): Vec3 | undefined {
    return this.current
  }

  pass(kind: PassKind): void {
    this.passes.push({ kind, moves: [] })
  }

  private push(m: Move, to: Vec3): void {
    const p = this.passes.at(-1)
    if (p === undefined) throw new Error('MoveBuilder: no pass') // bug
    p.moves.push(m)
    this.current = to
  }

  rapid(to: Vec3): void {
    if (this.current !== undefined && same(this.current, to)) return
    this.push({ kind: 'rapid', to }, to)
  }

  line(to: Vec3, feed: number): void {
    if (this.current !== undefined && same(this.current, to)) return
    this.push({ kind: 'line', to, feed }, to)
  }

  /** Move along `s` (assumed to start at the current XY) with Z from `z0` to `z1`. */
  seg(s: Seg3, feed: number): void {
    const { seg, z0, z1 } = s
    if (seg.kind === 'line') {
      this.line([seg.to[0], seg.to[1], z1], feed)
      return
    }
    const n = Math.max(1, Math.ceil(Math.abs(seg.sweep) / Math.PI - 1e-9))
    for (let k = 1; k <= n; k++) {
      const [x, y] = segPoint(seg, k / n)
      const to: Vec3 = [x, y, z0 + ((z1 - z0) * k) / n]
      this.push({ kind: 'arc', to, center: seg.center, cw: seg.sweep < 0, feed }, to)
    }
  }

  drill(m: Extract<Move, { kind: 'drill' }>): void {
    this.push(m, [m.at[0], m.at[1], m.retract])
  }

  /** Passes with at least one move. */
  build(): Pass[] {
    return this.passes.filter((p) => p.moves.length > 0)
  }
}
