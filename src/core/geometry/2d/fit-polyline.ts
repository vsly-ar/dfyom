/**
 * Fits a closed polyline whose vertices lie on a curve (a mesh section: the STL's facets cut by a
 * plane) with lines and tangent arcs within a tolerance, keeping real corners as corners and
 * turning faceted fillets back into arcs (DF60 P1). Pure float64 math, no port.
 * Doc: docs/modes/reference-tools.md#fitting
 *
 * 1. Clean: duplicate and collinear vertices go (a section crosses each facet's diagonal on the
 *    chord between its two edge points, which carries no information).
 * 2. Circle: every vertex within the tolerance of one least-squares circle → one circle.
 * 3. Corners: a vertex turning more than `cornerAngle` whose neighbours do not turn the same way
 *    by more than half that (an isolated kink), or turning more than `FACET_MAX_TURN` (a single
 *    vertex that sharp is never a facet of a fillet). Same-way turns in a row are a faceted fillet.
 * 4. Tangents: every vertex inside a run gets the direction of the chord of its two neighbours
 *    (the central difference, which averages out the facets' zig-zag); a run's open ends take the
 *    tangent of the circle through their first three vertices.
 * 5. Runs between corners (or the whole loop, from its longest chord) are fitted greedily from
 *    vertex to vertex: the farthest vertex (doubling, then bisection) that one line (both tangents
 *    within 0.5° of the chord) or one biarc with the two vertex tangents reaches with every
 *    vertex in between within the tolerance. Elements join tangentially inside a run; the only
 *    tangent breaks are the corners. (Spike S8: the cubic detour through the SVG fitter turned
 *    faceted fillets into corners and failed on small radii; see reference-tools.md § Fitting.)
 */
import type { Vec2 } from '../model'
import { arcSweep, type Element } from './model'

export interface PolylineFitOptions {
  /** Max distance of a vertex from the fitted elements (mm). */
  readonly tolerance: number
  /** A vertex turning more than this (radians) may be a corner. */
  readonly cornerAngle: number
}

export interface PolylineFit {
  /** A closed chain in the polyline's direction (first element starts at a corner, if any). */
  readonly elements: readonly Element[]
  /** Corners kept, in order, with their signed turn (radians, positive = left). */
  readonly corners: readonly { readonly at: Vec2; readonly turn: number }[]
  /** Largest distance of a cleaned vertex from its fitted element (mm). */
  readonly maxDeviation: number
  /** Set when the whole loop is one circle (elements: two half arcs). */
  readonly circle?: { readonly centre: Vec2; readonly radius: number }
}

/** A single vertex turning more than this is a corner, whatever its neighbours do. */
export const FACET_MAX_TURN = (45 * Math.PI) / 180
/** Vertices this close are one (mm). */
const SAME_POINT = 1e-7
/** A vertex this close to the chord of its neighbours is dropped (mm; float32 coordinates). */
const COLLINEAR = 2e-5
/** Curvatures below this (1/mm) are lines. */
const LINE_CURVATURE = 1e-7
/** A biarc half sweeping at most this (radians, 1°) becomes a line if the points allow. */
const SNAP_SWEEP = Math.PI / 180
/** An arc sweeps at most this (the deviation test reads distances to the circle). */
const MAX_SWEEP = Math.PI

type P = Vec2

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]]
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]]
const mul = (a: P, s: number): P => [a[0] * s, a[1] * s]
const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1]
const cross = (a: P, b: P): number => a[0] * b[1] - a[1] * b[0]
const len = (a: P): number => Math.hypot(a[0], a[1])
const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const unit = (a: P): P => {
  const l = len(a)
  return l === 0 ? [1, 0] : [a[0] / l, a[1] / l]
}
/** Left normal. */
const left = (a: P): P => [-a[1], a[0]]

/** Signed turn at `b` from direction a→b to b→c (radians, positive = left). */
function turnAt(a: P, b: P, c: P): number {
  const u = sub(b, a)
  const v = sub(c, b)
  return Math.atan2(cross(u, v), dot(u, v))
}

/** Drops repeated and collinear vertices of a closed polyline (no closing repeat). */
export function cleanPolyline(points: readonly P[]): P[] {
  const out: P[] = []
  for (const p of points)
    if (out.length === 0 || dist(out[out.length - 1]!, p) > SAME_POINT) out.push(p)
  while (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= SAME_POINT) out.pop()
  // collinear vertices, until none is left (each pass may expose new ones at its seams)
  let changed = true
  while (changed && out.length > 3) {
    changed = false
    for (let i = 0; i < out.length && out.length > 3;) {
      const a = out[(i - 1 + out.length) % out.length]!
      const b = out[i]!
      const c = out[(i + 1) % out.length]!
      const ac = sub(c, a)
      const l = len(ac)
      const off = l === 0 ? dist(a, b) : Math.abs(cross(ac, sub(b, a))) / l
      const along = dot(sub(b, a), ac)
      if (off <= COLLINEAR && along >= 0 && along <= l * l) {
        out.splice(i, 1)
        changed = true
      } else i++
    }
  }
  return out
}

/** Least-squares circle (Kåsa) through points; undefined when they are collinear. */
function lsCircle(pts: readonly P[]): { centre: P; radius: number } | undefined {
  const n = pts.length
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p[0]
    my += p[1]
  }
  mx /= n
  my /= n
  let suu = 0
  let svv = 0
  let suv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const p of pts) {
    const u = p[0] - mx
    const v = p[1] - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-12 * (suu + svv) ** 2) return undefined
  const b1 = (suuu + suvv) / 2
  const b2 = (svvv + svuu) / 2
  const uc = (b1 * svv - b2 * suv) / det
  const vc = (suu * b2 - suv * b1) / det
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  return { centre: [uc + mx, vc + my], radius }
}

/** The arc (or line) from `a` along tangent `t` through `b`. */
function arcThrough(a: P, t: P, b: P): Element {
  const d = sub(b, a)
  const dd = dot(d, d)
  const h = dot(left(t), d)
  const k = dd === 0 ? 0 : (2 * h) / dd
  if (Math.abs(k) < LINE_CURVATURE) return { kind: 'line', a, b }
  return { kind: 'arc', a, b, centre: add(a, mul(left(t), 1 / k)), ccw: k > 0 }
}

/** Unit tangent at the end of an element (direction of travel). */
function endTangent(e: Element): P {
  if (e.kind === 'line') return unit(sub(e.b, e.a))
  const r = sub(e.b, e.centre)
  return unit(e.ccw ? left(r) : mul(left(r), -1))
}

/**
 * Largest distance of `pts` from the element, or Infinity when a point lies outside its span
 * (behind its start or past its end by more than the tolerance) or the arc sweeps too far.
 */
function deviation(e: Element, pts: readonly P[], tol: number): number {
  let worst = 0
  if (e.kind === 'line') {
    const d = sub(e.b, e.a)
    const l = len(d)
    if (l === 0) return pts.length === 0 ? 0 : Infinity
    const t = mul(d, 1 / l)
    for (const p of pts) {
      const s = dot(sub(p, e.a), t)
      if (s < -tol || s > l + tol) return Infinity
      worst = Math.max(worst, Math.abs(cross(t, sub(p, e.a))))
    }
    return worst
  }
  const sweep = arcSweep(e)
  if (Math.abs(sweep) > MAX_SWEEP) return Infinity
  const r = dist(e.a, e.centre)
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const slack = tol / r
  for (const p of pts) {
    const ang = Math.atan2(p[1] - e.centre[1], p[0] - e.centre[0])
    let rel = (ang - a0) * Math.sign(sweep)
    rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    if (rel > Math.PI + Math.abs(sweep) / 2) rel -= 2 * Math.PI
    if (rel < -slack || rel > Math.abs(sweep) + slack) return Infinity
    worst = Math.max(worst, Math.abs(dist(p, e.centre) - r))
  }
  return worst
}

/** Largest distance of `pts` from the nearest of `els` (for a biarc). */
function deviationMany(els: readonly Element[], pts: readonly P[], tol: number): number {
  let worst = 0
  for (const p of pts) {
    let best = Infinity
    for (const e of els) best = Math.min(best, deviation(e, [p], tol))
    worst = Math.max(worst, best)
  }
  return worst
}

/** Biarc from (p0, t0) to (p1, t1), joined at the incentre of the tangent triangle (S5). */
function biarc(p0: P, t0: P, p1: P, t1: P): Element[] | undefined {
  const v = sub(p1, p0)
  const vv = dot(v, v)
  if (vv === 0) return undefined
  let j: P | undefined
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
  if (j === undefined) {
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
  const e1 = arcThrough(p0, t0, j)
  const e2 = arcThrough(j, endTangent(e1), p1)
  const end = endTangent(e2)
  if (Math.abs(Math.atan2(cross(end, t1), dot(end, t1))) > 1e-6) return undefined
  return [e1, e2].filter((e) => dist(e.a, e.b) > SAME_POINT)
}

interface RunFit {
  readonly elements: Element[]
  readonly maxDeviation: number
}

/** `a` turned by `angle` (radians, positive = left). */
function rotate(a: P, angle: number): P {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]
}

/**
 * Unit tangents at the run's vertices: the central chord inside (exact for evenly sampled arcs;
 * along a long straight chord next to short fillet chords it stays with the straight one), and at
 * an open run's ends the tangent of the circle through the first (last) three vertices.
 */
function runTangents(q: readonly P[], closed: boolean): P[] {
  const m = q.length - 1
  const t: P[] = []
  /** Central chord; next to a chord `LONG_CHORD` times longer (a side meeting a fillet), its direction. */
  const inner = (a: P, p: P, b: P): P => {
    const la = dist(a, p)
    const lb = dist(p, b)
    if (la > LONG_CHORD * lb) return unit(sub(p, a))
    if (lb > LONG_CHORD * la) return unit(sub(b, p))
    return unit(sub(b, a))
  }
  for (let i = 0; i <= m; i++) {
    if (closed) {
      const a = q[i === 0 ? m - 1 : i - 1]!
      const b = q[i === m ? 1 : i + 1]!
      t.push(inner(a, q[i]!, b))
    } else if (i === 0 || i === m) {
      if (m < 2) {
        t.push(unit(sub(q[m]!, q[0]!)))
        continue
      }
      const [p0, p1, p2] = i === 0 ? [q[0]!, q[1]!, q[2]!] : [q[m - 2]!, q[m - 1]!, q[m]!]
      const l1 = dist(p0, p1)
      const l2 = dist(p1, p2)
      const turn = turnAt(p0, p1, p2)
      // the inscribed angle: the chord p0p1 subtends turn · l1 / (l1 + l2) of the arc
      t.push(
        i === 0
          ? rotate(unit(sub(p1, p0)), -(turn * l1) / (l1 + l2) / 2)
          : rotate(unit(sub(p2, p1)), (turn * l2) / (l1 + l2) / 2),
      )
    } else t.push(inner(q[i - 1]!, q[i]!, q[i + 1]!))
  }
  return t
}

/** A chord this many times longer than its neighbour is a straight side (`runTangents`). */
const LONG_CHORD = 3
/** Directions within this (radians) count as one for a line between two vertices. */
const LINE_TANGENT = (0.5 * Math.PI) / 180

/**
 * Fits run vertices `q[0..m]` with biarcs between chosen vertices (their tangents shared, so the
 * chain is tangent-continuous) or lines where the tangents agree with the chord: greedily the
 * longest stretch that holds every vertex in between within `tol`. A closed run has
 * `q[m]` = `q[0]`.
 */
function fitRun(q: readonly P[], closed: boolean, tol: number): RunFit {
  const m = q.length - 1
  const tan = runTangents(q, closed)
  const out: Element[] = []
  let worst = 0
  let i = 0
  const attempt = (j: number): { els: Element[]; dev: number } | undefined => {
    const inner = q.slice(i + 1, j)
    const chord = unit(sub(q[j]!, q[i]!))
    const along = (t: P) => Math.abs(Math.atan2(cross(t, chord), dot(t, chord))) <= LINE_TANGENT
    if (along(tan[i]!) && along(tan[j]!)) {
      const ln: Element = { kind: 'line', a: q[i]!, b: q[j]! }
      const dev = deviation(ln, inner, tol)
      if (dev <= tol) return { els: [ln], dev }
    }
    const bi = biarc(q[i]!, tan[i]!, q[j]!, tan[j]!)
    if (bi === undefined) return undefined
    // a nearly straight half (a side meeting a fillet) as a line when the points allow: the
    // tangent break is under SNAP_SWEEP / 2, far below a corner
    if (bi.some((e) => e.kind === 'arc' && Math.abs(arcSweep(e)) <= SNAP_SWEEP)) {
      const snapped = bi.map((e): Element =>
        e.kind === 'arc' && Math.abs(arcSweep(e)) <= SNAP_SWEEP
          ? { kind: 'line', a: e.a, b: e.b }
          : e,
      )
      const dev = deviationMany(snapped, inner, tol)
      if (dev <= tol) return { els: snapped, dev }
    }
    const dev = deviationMany(bi, inner, tol)
    return dev <= tol ? { els: bi, dev } : undefined
  }
  while (i < m) {
    let good = i + 1
    let best = attempt(good)
    if (best === undefined) {
      // no biarc reaches the next vertex with these tangents: a line to it (a small tangent break)
      best = { els: [{ kind: 'line', a: q[i]!, b: q[i + 1]! }], dev: 0 }
    } else {
      let step = 1
      let bad = -1
      while (good < m) {
        const j = Math.min(m, good + step)
        const r = attempt(j)
        if (r === undefined) {
          bad = j
          break
        }
        good = j
        best = r
        step *= 2
      }
      if (bad !== -1)
        while (bad - good > 1) {
          const mid = (good + bad) >> 1
          const r = attempt(mid)
          if (r === undefined) bad = mid
          else {
            good = mid
            best = r
          }
        }
    }
    out.push(...best.els)
    worst = Math.max(worst, best.dev)
    i = good
  }
  return { elements: out, maxDeviation: worst }
}

/** Fits a closed polyline (see the file comment). At least three distinct vertices. */
export function fitClosedPolyline(points: readonly P[], o: PolylineFitOptions): PolylineFit {
  const pts = cleanPolyline(points)
  const n = pts.length
  if (n < 3) return { elements: [], corners: [], maxDeviation: 0 }
  const tol = o.tolerance
  // a circle?
  if (n >= 8) {
    const c = lsCircle(pts)
    if (c !== undefined) {
      let dev = 0
      for (const p of pts) dev = Math.max(dev, Math.abs(dist(p, c.centre) - c.radius))
      if (dev <= tol && ccwArea(pts) !== 0) {
        const ccw = ccwArea(pts) > 0
        const a: P = [c.centre[0] + c.radius, c.centre[1]]
        const b: P = [c.centre[0] - c.radius, c.centre[1]]
        return {
          elements: [
            { kind: 'arc', a, b, centre: c.centre, ccw },
            { kind: 'arc', a: b, b: a, centre: c.centre, ccw },
          ],
          corners: [],
          maxDeviation: dev,
          circle: c,
        }
      }
    }
  }
  const turns = pts.map((p, i) => turnAt(pts[(i - 1 + n) % n]!, p, pts[(i + 1) % n]!))
  const big = (i: number) => Math.abs(turns[(i + n) % n]!) > o.cornerAngle
  const sameWay = (i: number, j: number) =>
    Math.sign(turns[(i + n) % n]!) === Math.sign(turns[(j + n) % n]!) &&
    Math.abs(turns[(j + n) % n]!) > o.cornerAngle / 2
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    if (!big(i)) continue
    if (Math.abs(turns[i]!) > Math.max(FACET_MAX_TURN, o.cornerAngle)) corners.push(i)
    else if (!sameWay(i, i - 1) && !sameWay(i, i + 1)) corners.push(i)
  }
  const elements: Element[] = []
  let maxDeviation = 0
  if (corners.length === 0) {
    // start at the longest chord (on a flat stretch where there is one)
    let start = 0
    let longest = -1
    for (let i = 0; i < n; i++) {
      const l = dist(pts[i]!, pts[(i + 1) % n]!)
      if (l > longest) {
        longest = l
        start = i
      }
    }
    const q = Array.from({ length: n + 1 }, (_, k) => pts[(start + k) % n]!)
    const r = fitRun(q, true, tol)
    elements.push(...r.elements)
    maxDeviation = r.maxDeviation
  } else {
    for (let k = 0; k < corners.length; k++) {
      const from = corners[k]!
      const to = corners[(k + 1) % corners.length]!
      const count = (to - from + n) % n || n
      const q = Array.from({ length: count + 1 }, (_, s) => pts[(from + s) % n]!)
      const r = fitRun(q, false, tol)
      elements.push(...r.elements)
      maxDeviation = Math.max(maxDeviation, r.maxDeviation)
    }
  }
  return {
    elements,
    corners: corners.map((i) => ({ at: pts[i]!, turn: turns[i]! })),
    maxDeviation,
  }
}

/** Twice the signed area of a polygon (counter-clockwise positive). */
function ccwArea(pts: readonly P[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) s += cross(pts[i]!, pts[(i + 1) % pts.length]!)
  return s
}
