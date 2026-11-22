/**
 * Independent checks of an SVG import (spike S5's oracle, spikes/biarc/oracle.ts): the two-sided
 * sampled deviation between the source curves (flattened to 0.1 µm) and the imported elements,
 * and the tangent kinks inside a chain. Test-only (D29: production keeps the in-fit estimate).
 */
import type { Vec2 } from '../../../geometry/model'
import { elementClosest, elementPointAt } from '../../../geometry/2d/measure'
import type { Element } from '../../../geometry/2d/model'
import { curveOf, type Curve } from '../curves'
import type { Seg } from '../path-data'

/** Curve points on [0, 1], adaptive until every chord is within `tol` of the curve. */
export function dense(c: Curve, tol = 1e-4): Vec2[] {
  const p = (t: number): Vec2 => {
    const q = c.p(t)
    return [q.x, q.y]
  }
  const out: Vec2[] = [p(0)]
  const rec = (ta: number, tb: number, a: Vec2, b: Vec2, depth: number): void => {
    const tm = (ta + tb) / 2
    const off = Math.max(
      distToSeg(p(tm), a, b),
      distToSeg(p((ta + tm) / 2), a, b),
      distToSeg(p((tm + tb) / 2), a, b),
    )
    if (depth < 22 && (depth < 5 || off > tol)) {
      const m = p(tm)
      rec(ta, tm, a, m, depth + 1)
      rec(tm, tb, m, b, depth + 1)
    } else out.push(b)
  }
  rec(0, 1, out[0]!, p(1), 0)
  return out
}

export function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2))
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy)
}

/** Two-sided max distance (mm) between source segments (mm) and elements. */
export function deviation(
  segs: readonly Seg[],
  elements: readonly Element[],
  perElem = 64,
): number {
  const poly = segs.map((s) => dense(curveOf(s)))
  let worst = 0
  for (const line of poly)
    for (const q of line) {
      let best = Infinity
      for (const e of elements) {
        const c = elementClosest(e, q)
        best = Math.min(best, Math.hypot(q[0] - c[0], q[1] - c[1]))
      }
      worst = Math.max(worst, best)
    }
  for (const e of elements)
    for (let k = 0; k <= perElem; k++) {
      const q = elementPointAt(e, k / perElem).point
      let best = Infinity
      for (const line of poly)
        for (let i = 0; i + 1 < line.length; i++)
          best = Math.min(best, distToSeg(q, line[i]!, line[i + 1]!))
      worst = Math.max(worst, best)
    }
  return worst
}

/** Tangent kinks (rad) at every join of a chain, the closing join of a loop included. */
export function kinks(elements: readonly Element[], closed: boolean): number[] {
  const out: number[] = []
  const n = elements.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const t1 = elementPointAt(elements[i]!, 1).tangent
    const t0 = elementPointAt(elements[(i + 1) % n]!, 0).tangent
    out.push(Math.abs(Math.atan2(t1[0] * t0[1] - t1[1] * t0[0], t1[0] * t0[0] + t1[1] * t0[1])))
  }
  return out
}
