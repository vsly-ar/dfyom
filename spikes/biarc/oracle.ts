// Spike S5 (docs/research/s5-biarc-fitting.md): independent checks of a fit. Deviation is the
// two-sided sampled distance between the curve (densely flattened, 0.1 µm) and the elements;
// continuity is the kink angle at every join inside a chain and at the chain ends against the
// curve's own tangent (so chains of neighbouring curves are G1 wherever the source is).

import { cross, dist, dot, tangent, type Curve, type Pt } from './curves.ts'
import { distToElem, elemPoint, elemsOf, elemTangents, type Elem, type FitResult } from './fit.ts'

/** Curve points on [0, 1], adaptive until every chord is within `tol` of the curve. */
export function dense(c: Curve, tol = 1e-4): Pt[] {
  const out: Pt[] = [c.p(0)]
  const rec = (ta: number, tb: number, a: Pt, b: Pt, depth: number): void => {
    const tm = (ta + tb) / 2
    const m = c.p(tm)
    const q1 = c.p((ta + tm) / 2)
    const q3 = c.p((tm + tb) / 2)
    const off = Math.max(distToSeg(m, a, b), distToSeg(q1, a, b), distToSeg(q3, a, b))
    if (depth < 22 && (depth < 5 || off > tol)) {
      rec(ta, tm, a, m, depth + 1)
      rec(tm, tb, m, b, depth + 1)
    } else out.push(b)
  }
  rec(0, 1, out[0]!, c.p(1), 0)
  return out
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const l2 = vx * vx + vy * vy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2))
  return Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy)
}

/** Two-sided max distance (mm), `perElem` samples per element. */
export function deviation(c: Curve, fit: FitResult, perElem = 64): number {
  const elems = elemsOf(fit)
  const poly = dense(c, 1e-4)
  let worst = 0
  for (const q of poly) {
    let best = Infinity
    for (const e of elems) best = Math.min(best, distToElem(q, e))
    worst = Math.max(worst, best)
  }
  for (const e of elems)
    for (let k = 0; k <= perElem; k++) {
      const q = elemPoint(e, k / perElem)
      let best = Infinity
      for (let i = 0; i + 1 < poly.length; i++)
        best = Math.min(best, distToSeg(q, poly[i]!, poly[i + 1]!))
      worst = Math.max(worst, best)
    }
  return worst
}

const angle = (u: Pt, v: Pt): number => Math.abs(Math.atan2(cross(u, v), dot(u, v)))

/**
 * Largest tangent kink (rad) inside chains and against the curve at chain ends (except at cusps,
 * where the curve has no tangent, and micro corners); largest position gap; micro corner count.
 */
export function continuity(c: Curve, fit: FitResult): { kink: number; gap: number; micro: number } {
  const isCusp = (t: number): boolean => c.cusps.some((u) => Math.abs(u - t) < 1e-12)
  let kink = 0
  let gap = 0
  let micro = 0
  for (const ch of fit.chains) {
    const first = ch.elems[0]
    const last = ch.elems[ch.elems.length - 1]
    if (!first || !last) continue
    gap = Math.max(gap, dist(first.a, c.p(ch.ta)), dist(last.b, c.p(ch.tb)))
    if (ch.micro) {
      micro++
      continue
    }
    const next = (t: number): boolean =>
      fit.chains.some((o) => o.micro && (o.ta === t || o.tb === t))
    if (c.kind !== 'line') {
      if (!isCusp(ch.ta) && !next(ch.ta))
        kink = Math.max(kink, angle(elemTangents(first).t0, tangent(c, ch.ta, 1)))
      if (!isCusp(ch.tb) && !next(ch.tb))
        kink = Math.max(kink, angle(elemTangents(last).t1, tangent(c, ch.tb, -1)))
    }
    for (let k = 0; k + 1 < ch.elems.length; k++) {
      const e: Elem = ch.elems[k]!
      const f: Elem = ch.elems[k + 1]!
      kink = Math.max(kink, angle(elemTangents(e).t1, elemTangents(f).t0))
      gap = Math.max(gap, dist(e.b, f.a))
    }
  }
  return { kink, gap, micro }
}
