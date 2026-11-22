// Spike S5 (docs/research/s5-biarc-fitting.md): three ways to turn a source curve into a
// tangent-continuous chain of lines and arcs within a tolerance. Throwaway code, not the app.
//
// A  classic biarc: equal tangent lengths at both ends, split at the parameter midpoint on error;
//    only cusps are split up front.
// B  Riskus/Šír style: split at inflections, cusps and ellipse vertices first, so every piece is
//    C-shaped; join point at the incenter of the tangent triangle; split at the midpoint on error.
// C  greedy arc spline: from the current point and tangent, the longest single tangent arc within
//    the tolerance (bisection), until a closing biarc matches the end point and end tangent.

import {
  add,
  cross,
  dist,
  dot,
  len,
  mul,
  rot,
  sub,
  tangent,
  unit,
  type Curve,
  type Pt,
} from './curves.ts'

/** A line (bulge 0) or arc from a to b; bulge = tan(sweep / 4), positive = counter-clockwise. */
export interface Elem {
  readonly a: Pt
  readonly b: Pt
  readonly bulge: number
}

export type Approach = 'A' | 'B' | 'C'

export interface FitOptions {
  /** Max distance between the curve and the elements (mm). */
  readonly tol: number
  /**
   * Line fallback: an arc becomes a line when its sagitta ≤ `lineSagitta` and its half sweep (the
   * kink it leaves with each neighbour) ≤ `lineTurn` rad. The fit runs at tol − lineSagitta.
   */
  readonly lineSagitta: number
  readonly lineTurn: number
  /** Curve samples per piece for the in-fit error estimate. */
  readonly samples: number
  readonly maxDepth: number
}

export const DEFAULTS: FitOptions = {
  tol: 0.01,
  lineSagitta: 1e-4,
  lineTurn: 1e-4,
  samples: 24,
  maxDepth: 24,
}

/** A tangent-continuous run of elements fitting the curve on [ta, tb]. */
export interface Chain {
  readonly ta: number
  readonly tb: number
  readonly elems: Elem[]
  /**
   * A micro corner: a piece shorter than the tolerance where no biarc exists (the turn of a
   * near-cusp happens inside the tolerance), replaced by one line. G1 is broken only here.
   */
  readonly micro: boolean
}

export interface FitResult {
  /** Consecutive chains meet at a cusp of the curve or a micro corner. */
  readonly chains: Chain[]
  /** Pieces accepted at max depth (A, B) or forced steps (C) without meeting the tolerance. */
  readonly forced: number
}

export const elemsOf = (f: FitResult): Elem[] => f.chains.flatMap((ch) => ch.elems)

// ---------------------------------------------------------------- element geometry

const BULGE_LINE = 1e-12

export function elemTangents(e: Elem): { t0: Pt; t1: Pt } {
  const c = unit(sub(e.b, e.a))
  const half = 2 * Math.atan(e.bulge)
  return { t0: rot(c, -half), t1: rot(c, half) }
}

interface ArcGeom {
  c: Pt
  r: number
  a0: number
  sweep: number
}

function arcGeom(e: Elem): ArcGeom | null {
  const b = e.bulge
  if (Math.abs(b) < BULGE_LINE) return null
  const v = sub(e.b, e.a)
  const chord = len(v)
  if (chord === 0) return null
  const k = (1 - b * b) / (4 * b)
  const c = { x: (e.a.x + e.b.x) / 2 - v.y * k, y: (e.a.y + e.b.y) / 2 + v.x * k }
  return {
    c,
    r: (chord * (1 + b * b)) / (4 * Math.abs(b)),
    a0: Math.atan2(e.a.y - c.y, e.a.x - c.x),
    sweep: 4 * Math.atan(b),
  }
}

export function elemLength(e: Elem): number {
  const g = arcGeom(e)
  return g ? g.r * Math.abs(g.sweep) : dist(e.a, e.b)
}

export function elemRadius(e: Elem): number {
  return arcGeom(e)?.r ?? Infinity
}

export function elemPoint(e: Elem, s: number): Pt {
  const g = arcGeom(e)
  if (!g) return add(e.a, mul(sub(e.b, e.a), s))
  const ang = g.a0 + g.sweep * s
  return { x: g.c.x + g.r * Math.cos(ang), y: g.c.y + g.r * Math.sin(ang) }
}

const TAU = 2 * Math.PI

export function distToElem(p: Pt, e: Elem): number {
  const g = arcGeom(e)
  if (!g) {
    const v = sub(e.b, e.a)
    const l2 = dot(v, v)
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, e.a), v) / l2))
    return dist(p, add(e.a, mul(v, t)))
  }
  const ang = Math.atan2(p.y - g.c.y, p.x - g.c.x)
  const rel = g.sweep >= 0 ? (((ang - g.a0) % TAU) + TAU) % TAU : (((g.a0 - ang) % TAU) + TAU) % TAU
  if (rel <= Math.abs(g.sweep)) return Math.abs(dist(p, g.c) - g.r)
  return Math.min(dist(p, e.a), dist(p, e.b))
}

/** The arc from a, tangent to t there, through b (a line when b lies on the tangent). */
export function arcFrom(a: Pt, t: Pt, b: Pt): Elem {
  const c = sub(b, a)
  const half = Math.atan2(cross(t, c), dot(t, c))
  const bulge = Math.tan(half / 2)
  return { a, b, bulge: Math.abs(bulge) < BULGE_LINE ? 0 : bulge }
}

// ---------------------------------------------------------------- biarc

export type Join = 'equal' | 'incenter'

/**
 * Biarc from (p0, t0) to (p1, t1). `equal`: equal tangent lengths (handles C and S shapes);
 * `incenter`: join at the incenter of the triangle p0, v, p1 (v = tangent intersection; C shapes
 * only, else `equal`). Null when no proper biarc exists (the caller subdivides).
 */
export function biarc(p0: Pt, t0: Pt, p1: Pt, t1: Pt, join: Join): Elem[] | null {
  const v = sub(p1, p0)
  const vv = dot(v, v)
  if (vv === 0) return null
  let j: Pt | null = null
  if (join === 'incenter') {
    const den = cross(t0, t1)
    if (Math.abs(den) > 1e-12) {
      const s = cross(v, t1) / den
      const u = cross(t0, v) / den
      if (s > 0 && u > 0) {
        const vtx = add(p0, mul(t0, s))
        const a = dist(p1, vtx)
        const b = dist(p0, vtx)
        const c = Math.sqrt(vv)
        j = mul(add(add(mul(p0, a), mul(p1, b)), mul(vtx, c)), 1 / (a + b + c))
      }
    }
  }
  if (!j) {
    const t = add(t0, t1)
    const vt = dot(v, t)
    const k = 4 - dot(t, t)
    let d: number
    if (Math.abs(k) < 1e-12) {
      const vt1 = dot(v, t1)
      if (vt1 <= 0) return null
      d = vv / (4 * vt1)
    } else d = (-vt + Math.sqrt(vt * vt + k * vv)) / k
    if (!(d > 0) || !Number.isFinite(d)) return null
    j = mul(add(add(p0, mul(t0, d)), sub(p1, mul(t1, d))), 0.5)
  }
  const e1 = arcFrom(p0, t0, j)
  const e2 = arcFrom(j, elemTangents(e1).t1, p1)
  // the second arc must arrive along t1, or j was not on the joint circle
  const end = elemTangents(e2).t1
  if (Math.abs(Math.atan2(cross(end, t1), dot(end, t1))) > 1e-7) return null
  return [e1, e2].filter((e) => dist(e.a, e.b) > 0)
}

// ---------------------------------------------------------------- error estimate

/** Max distance from `samples` interior curve points on [ta, tb] to the elements. */
export function fitError(
  c: Curve,
  ta: number,
  tb: number,
  elems: readonly Elem[],
  samples: number,
  lengthCheck = true,
): number {
  let worst = 0
  let poly = 0
  let prev = c.p(ta)
  for (let k = 1; k <= samples; k++) {
    const q = c.p(ta + ((tb - ta) * k) / samples)
    poly += dist(prev, q)
    prev = q
    if (k === samples) break
    let best = Infinity
    for (const e of elems) best = Math.min(best, distToElem(q, e))
    worst = Math.max(worst, best)
  }
  // a looping biarc can pass near every sample: reject element chains much longer than the curve
  const total = elems.reduce((s, e) => s + elemLength(e), 0)
  if (lengthCheck && total > 1.1 * poly + 1e-6) return Infinity
  return worst
}

// ---------------------------------------------------------------- fitters

interface Ctx {
  readonly c: Curve
  readonly o: FitOptions
  readonly tolFit: number
  forced: number
  readonly chains: Chain[]
  /** Start parameter and elements of the chain being built. */
  start: number
  cur: Elem[]
}

/** Ends the current chain at t, pushes a micro-corner line over [t, tb], starts a new chain. */
function micro(x: Ctx, t: number, tb: number, p0: Pt, p1: Pt): void {
  x.chains.push({ ta: x.start, tb: t, elems: x.cur, micro: false })
  x.chains.push({ ta: t, tb, elems: [{ a: p0, b: p1, bulge: 0 }], micro: true })
  x.start = tb
  x.cur = []
}

function isMicro(x: Ctx, ta: number, tb: number, p0: Pt, p1: Pt): boolean {
  const line = [{ a: p0, b: p1, bulge: 0 }]
  return dist(p0, p1) <= x.o.tol && fitError(x.c, ta, tb, line, x.o.samples, false) <= x.tolFit
}

function subdivide(x: Ctx, ta: number, tb: number, join: Join, depth: number): void {
  const { c, o } = x
  const out = x.cur
  const p0 = c.p(ta)
  const p1 = c.p(tb)
  const bi = biarc(p0, tangent(c, ta, 1), p1, tangent(c, tb, -1), join)
  const ok = bi !== null && fitError(c, ta, tb, bi, o.samples) <= x.tolFit
  if (!ok && isMicro(x, ta, tb, p0, p1)) {
    micro(x, ta, tb, p0, p1)
    return
  }
  if (ok || depth >= o.maxDepth) {
    if (!ok) x.forced++
    out.push(...(bi ?? [{ a: p0, b: p1, bulge: 0 }]))
    return
  }
  const tm = (ta + tb) / 2
  subdivide(x, ta, tm, join, depth + 1)
  subdivide(x, tm, tb, join, depth + 1)
}

function greedy(x: Ctx, ta: number, tb: number): void {
  const { c, o } = x
  const p1 = c.p(tb)
  const t1 = tangent(c, tb, -1)
  let t = ta
  let p = c.p(ta)
  let tan = tangent(c, ta, 1)
  for (let guard = 0; guard < 100_000; guard++) {
    if (tb - t <= (tb - ta) * 1e-9) return
    const bi = biarc(p, tan, p1, t1, 'incenter') ?? biarc(p, tan, p1, t1, 'equal')
    if (bi && fitError(c, t, tb, bi, o.samples) <= x.tolFit) {
      x.cur.push(...bi)
      return
    }
    // longest single tangent arc; 5 % margin, since bisection lands right on the estimate, which
    // misses up to ~2 % between the samples
    let lo = t
    let hi = tb
    while (hi - lo > 1e-12 * Math.max(1, tb - ta)) {
      const m = (lo + hi) / 2
      if (fitError(c, t, m, [arcFrom(p, tan, c.p(m))], o.samples) <= 0.95 * x.tolFit) lo = m
      else hi = m
      if (hi - lo < (tb - ta) * 1e-6) break
    }
    if (lo - t < (tb - ta) * 1e-6) {
      // stuck (the chain's tangent is too far off a fast-turning curve, e.g. next to a cusp): a
      // biarc back onto the curve's own tangent at the farthest point that fits, else a micro corner
      let m = tb
      const bridge = (u: number): Elem[] | null => {
        const q = c.p(u)
        const tq = tangent(c, u, -1)
        const b = biarc(p, tan, q, tq, 'incenter') ?? biarc(p, tan, q, tq, 'equal')
        return b && fitError(c, t, u, b, o.samples) <= x.tolFit ? b : null
      }
      let b = bridge(m)
      while (!b && m - t > (tb - ta) * 1e-9) b = bridge((m = (t + m) / 2))
      if (b) {
        x.cur.push(...b)
        p = c.p(m)
        tan = tangent(c, m, 1)
        t = m
        continue
      }
      m = tb
      while (m - t > (tb - ta) * 1e-9 && !isMicro(x, t, m, p, c.p(m))) m = (t + m) / 2
      if (m - t > (tb - ta) * 1e-9) {
        micro(x, t, m, p, c.p(m))
        p = c.p(m)
        tan = tangent(c, m, 1)
        t = m
        continue
      }
      x.forced++
      lo = t + (tb - t) * 1e-3
    }
    const arc = arcFrom(p, tan, c.p(lo))
    x.cur.push(arc)
    p = arc.b
    tan = elemTangents(arc).t1
    t = lo
  }
  x.forced++
}

/** Split arcs over 180° (CavalierContours bulge ≤ 1), line fallback, merge collinear lines. */
function finish(chain: Elem[], o: FitOptions): Elem[] {
  const out: Elem[] = []
  for (const e of chain) {
    let parts: Elem[] = [e]
    if (Math.abs(e.bulge) > 1) {
      const m = elemPoint(e, 0.5)
      const b = Math.tan(Math.atan(e.bulge) / 2)
      parts = [
        { a: e.a, b: m, bulge: b },
        { a: m, b: e.b, bulge: b },
      ]
    }
    for (const p of parts) {
      const sag = (dist(p.a, p.b) * Math.abs(p.bulge)) / 2
      const half = 2 * Math.atan(Math.abs(p.bulge))
      const q = sag <= o.lineSagitta && half <= o.lineTurn ? { ...p, bulge: 0 } : p
      const last = out[out.length - 1]
      if (
        last &&
        last.bulge === 0 &&
        q.bulge === 0 &&
        Math.abs(cross(unit(sub(last.b, last.a)), unit(sub(q.b, q.a)))) < 1e-12 &&
        dot(sub(last.b, last.a), sub(q.b, q.a)) > 0
      )
        out[out.length - 1] = { a: last.a, b: q.b, bulge: 0 }
      else out.push(q)
    }
  }
  return out
}

export function fitCurve(c: Curve, approach: Approach, opts: Partial<FitOptions> = {}): FitResult {
  const o = { ...DEFAULTS, ...opts }
  const one = (bulge: number): FitResult => ({
    chains: [{ ta: 0, tb: 1, elems: finish([{ a: c.p(0), b: c.p(1), bulge }], o), micro: false }],
    forced: 0,
  })
  if (c.kind === 'line') return one(0)
  if (c.kind === 'arc') return one(c.bulge ?? 0)
  const x: Ctx = { c, o, tolFit: o.tol - o.lineSagitta, forced: 0, chains: [], start: 0, cur: [] }
  const cuts = [0, ...c.cusps, 1]
  for (let i = 0; i + 1 < cuts.length; i++) {
    const ta = cuts[i]!
    const tb = cuts[i + 1]!
    x.start = ta
    x.cur = []
    if (approach === 'A') subdivide(x, ta, tb, 'equal', 0)
    else if (approach === 'B') {
      const ts = [ta, ...c.breaks.filter((t) => t > ta && t < tb), tb]
      for (let k = 0; k + 1 < ts.length; k++) subdivide(x, ts[k]!, ts[k + 1]!, 'incenter', 0)
    } else greedy(x, ta, tb)
    x.chains.push({ ta: x.start, tb, elems: x.cur, micro: false })
  }
  const chains = x.chains
    .filter((ch) => ch.elems.length > 0)
    .map((ch) => ({ ...ch, elems: ch.micro ? ch.elems : finish(ch.elems, o) }))
  return { chains, forced: x.forced }
}
