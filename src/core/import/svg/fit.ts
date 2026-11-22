/**
 * Biarc fitting of Béziers and elliptical arcs (spike S5, approach B; ported from
 * spikes/biarc/fit.ts): split at cusps (true corners), then at inflections and ellipse vertices
 * (G1 joins); fit each C-shaped piece with a biarc joined at the incenter of its tangent triangle;
 * subdivide at the parameter midpoint while the 24-sample estimate (with a 10 % length guard)
 * exceeds the tolerance. Lines only for degenerate arcs (sagitta ≤ 0.1 µm and half sweep
 * ≤ 0.1 mrad), arcs over 180° split in two, collinear lines merged.
 * Doc: docs/architecture/shapes.md#arc-fitting
 */
import { CHORD_TOLERANCE } from '../../geometry/model'
import { add, cross, dist, dot, len, mul, rot, sub, tangent, unit, type Curve } from './curves'
import type { Pt } from './transform'

/**
 * A line (bulge 0) or arc from a to b; bulge = tan(sweep / 4), positive counter-clockwise.
 * `micro`: a micro corner (a line over a piece shorter than the tolerance where no biarc exists,
 * left at near-cusps); the clean-up merges it away.
 */
export interface BElem {
  readonly a: Pt
  readonly b: Pt
  readonly bulge: number
  readonly micro?: true
}

export interface FitOptions {
  /** Max distance between the curve and the elements (mm). */
  readonly tol: number
  /** Line fallback thresholds: sagitta (mm) and half sweep (rad); the fit runs at tol − sagitta. */
  readonly lineSagitta: number
  readonly lineTurn: number
  /** Curve samples per piece for the in-fit error estimate. */
  readonly samples: number
  readonly maxDepth: number
}

export const FIT_DEFAULTS: FitOptions = {
  tol: CHORD_TOLERANCE,
  lineSagitta: 1e-4,
  lineTurn: 1e-4,
  samples: 24,
  maxDepth: 24,
}

export interface FitResult {
  /** Tangent-continuous except at cusps and micro corners. */
  readonly elems: BElem[]
  /** Largest in-fit error estimate of an accepted piece (mm); 0 for exact lines and arcs. */
  readonly maxError: number
  /** Cusps of the curve (corners kept). */
  readonly cusps: number
  /** Micro corners left (merged later by the clean-up). */
  readonly micro: number
  /** Pieces accepted at max depth without meeting the tolerance (expected 0). */
  readonly forced: number
}

const BULGE_LINE = 1e-12
const TAU = 2 * Math.PI

export function elemTangents(e: BElem): { t0: Pt; t1: Pt } {
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

/** Centre, radius, start angle and signed sweep of an arc element; undefined for a line. */
export function arcGeom(e: BElem): ArcGeom | undefined {
  const b = e.bulge
  if (Math.abs(b) < BULGE_LINE) return undefined
  const v = sub(e.b, e.a)
  const chord = len(v)
  if (chord === 0) return undefined
  const k = (1 - b * b) / (4 * b)
  const c = { x: (e.a.x + e.b.x) / 2 - v.y * k, y: (e.a.y + e.b.y) / 2 + v.x * k }
  return {
    c,
    r: (chord * (1 + b * b)) / (4 * Math.abs(b)),
    a0: Math.atan2(e.a.y - c.y, e.a.x - c.x),
    sweep: 4 * Math.atan(b),
  }
}

export function elemLength(e: BElem): number {
  const g = arcGeom(e)
  return g ? g.r * Math.abs(g.sweep) : dist(e.a, e.b)
}

export function elemPoint(e: BElem, s: number): Pt {
  const g = arcGeom(e)
  if (!g) return add(e.a, mul(sub(e.b, e.a), s))
  const ang = g.a0 + g.sweep * s
  return { x: g.c.x + g.r * Math.cos(ang), y: g.c.y + g.r * Math.sin(ang) }
}

export function distToElem(p: Pt, e: BElem): number {
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
function arcFrom(a: Pt, t: Pt, b: Pt): BElem {
  const c = sub(b, a)
  const half = Math.atan2(cross(t, c), dot(t, c))
  const bulge = Math.tan(half / 2)
  return { a, b, bulge: Math.abs(bulge) < BULGE_LINE ? 0 : bulge }
}

/**
 * Biarc from (p0, t0) to (p1, t1), joined at the incenter of the triangle p0, v, p1 (v = tangent
 * intersection) for a C-shaped piece, else at equal tangent lengths. Undefined when no proper
 * biarc exists (the caller subdivides).
 */
export function biarc(p0: Pt, t0: Pt, p1: Pt, t1: Pt): BElem[] | undefined {
  const v = sub(p1, p0)
  const vv = dot(v, v)
  if (vv === 0) return undefined
  let j: Pt | undefined
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
  if (!j) {
    const t = add(t0, t1)
    const vt = dot(v, t)
    const k = 4 - dot(t, t)
    let d: number
    if (Math.abs(k) < 1e-12) {
      const vt1 = dot(v, t1)
      if (vt1 <= 0) return undefined
      d = vv / (4 * vt1)
    } else d = (-vt + Math.sqrt(vt * vt + k * vv)) / k
    if (!(d > 0) || !Number.isFinite(d)) return undefined
    j = mul(add(add(p0, mul(t0, d)), sub(p1, mul(t1, d))), 0.5)
  }
  const e1 = arcFrom(p0, t0, j)
  const e2 = arcFrom(j, elemTangents(e1).t1, p1)
  // the second arc must arrive along t1, or j was not on the joint circle
  const end = elemTangents(e2).t1
  if (Math.abs(Math.atan2(cross(end, t1), dot(end, t1))) > 1e-7) return undefined
  return [e1, e2].filter((e) => dist(e.a, e.b) > 0)
}

/** Max distance from `samples` interior curve points on [ta, tb] to the elements. */
export function fitError(
  c: Curve,
  ta: number,
  tb: number,
  elems: readonly BElem[],
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
  if (lengthCheck) {
    let total = 0
    for (const e of elems) total += elemLength(e)
    if (total > 1.1 * poly + 1e-6) return Infinity
  }
  return worst
}

interface Ctx {
  readonly c: Curve
  readonly o: FitOptions
  readonly tolFit: number
  readonly out: BElem[]
  /** Index in `out` where the current tangent-continuous run starts (finish() runs per run). */
  runStart: number
  forced: number
  micro: number
  maxError: number
}

/** Ends the current run, appends a micro-corner line, starts a new run. */
function pushMicro(x: Ctx, p0: Pt, p1: Pt): void {
  endRun(x)
  x.out.push({ a: p0, b: p1, bulge: 0, micro: true })
  x.micro++
  x.runStart = x.out.length
}

function endRun(x: Ctx): void {
  const run = x.out.splice(x.runStart)
  x.out.push(...finish(run, x.o))
  x.runStart = x.out.length
}

function subdivide(x: Ctx, ta: number, tb: number, depth: number): void {
  const { c, o } = x
  const p0 = c.p(ta)
  const p1 = c.p(tb)
  const bi = biarc(p0, tangent(c, ta, 1), p1, tangent(c, tb, -1))
  const err = bi === undefined ? Infinity : fitError(c, ta, tb, bi, o.samples)
  const ok = err <= x.tolFit
  if (!ok) {
    const line = [{ a: p0, b: p1, bulge: 0 }]
    if (dist(p0, p1) <= o.tol && fitError(c, ta, tb, line, o.samples, false) <= x.tolFit) {
      pushMicro(x, p0, p1)
      return
    }
  }
  if (ok || depth >= o.maxDepth) {
    if (!ok) x.forced++
    else x.maxError = Math.max(x.maxError, err)
    x.out.push(...(bi ?? [{ a: p0, b: p1, bulge: 0 }]))
    return
  }
  const tm = (ta + tb) / 2
  subdivide(x, ta, tm, depth + 1)
  subdivide(x, tm, tb, depth + 1)
}

/** Split arcs over 180° (bulge ≤ 1), line fallback, merge collinear lines. */
export function finish(chain: readonly BElem[], o: FitOptions = FIT_DEFAULTS): BElem[] {
  const out: BElem[] = []
  for (const e of chain) {
    let parts: BElem[] = [e]
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
      const q = p.bulge !== 0 && sag <= o.lineSagitta && half <= o.lineTurn ? { ...p, bulge: 0 } : p
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

/**
 * Fits one curve. Lines and circular arcs come back exact (an arc over 180° as two); cubics and
 * ellipses as biarc chains within `o.tol`. The first and last points are the curve's p(0), p(1).
 */
export function fitCurve(c: Curve, o: FitOptions = FIT_DEFAULTS): FitResult {
  const exact = (bulge: number): FitResult => ({
    elems: finish([{ a: c.p(0), b: c.p(1), bulge }], o),
    maxError: 0,
    cusps: 0,
    micro: 0,
    forced: 0,
  })
  if (c.kind === 'line') return exact(0)
  if (c.kind === 'arc') return exact(c.bulge ?? 0)
  const x: Ctx = {
    c,
    o,
    tolFit: o.tol - o.lineSagitta,
    out: [],
    runStart: 0,
    forced: 0,
    micro: 0,
    maxError: 0,
  }
  const cuts = [0, ...c.cusps, 1]
  for (let i = 0; i + 1 < cuts.length; i++) {
    const ta = cuts[i]!
    const tb = cuts[i + 1]!
    const ts = [ta, ...c.breaks.filter((t) => t > ta && t < tb), tb]
    for (let k = 0; k + 1 < ts.length; k++) subdivide(x, ts[k]!, ts[k + 1]!, 0)
    endRun(x)
  }
  return {
    elems: x.out,
    maxError: x.maxError,
    cusps: c.cusps.length,
    micro: x.micro,
    forced: x.forced,
  }
}
