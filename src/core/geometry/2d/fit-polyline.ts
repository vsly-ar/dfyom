/**
 * Fits a closed polyline whose vertices lie on a curve (a mesh section: the STL's facets cut by a
 * plane) with lines and tangent arcs within a tolerance, keeping real corners as corners and
 * turning faceted fillets back into arcs (DF60 P1). Pure float64 math, no port.
 * Doc: docs/modes/reference-tools.md#fitting
 *
 * 1. Clean: duplicate and collinear vertices go (a section crosses each facet's diagonal on the
 *    chord between its two edge points, which carries no information).
 * 2. Circle: every vertex within the tolerance of one least-squares circle, and no chord spanning
 *    more than 46° of it (a flat whose ends lie on the circle) → one circle.
 * 3. Corners: a vertex turning more than `cornerAngle` whose neighbours do not turn the same way
 *    by more than half that (an isolated kink), or turning more than `FACET_MAX_TURN` (a single
 *    vertex that sharp is never a facet of a fillet). Same-way turns in a row are a faceted fillet.
 * 4. Tangents: every vertex inside a run gets the tangent of the circle through it and its two
 *    neighbours (the central chord for even chords; with uneven ones the central chord would lean
 *    to the longer chord); next to a chord three times longer that goes on into short chords (a
 *    straight side meeting a fillet's fan) the long chord's direction comes first and the circle
 *    tangent is the alternative a stretch may end on. A run's open ends take the tangent of the
 *    circle through their first three vertices.
 * 5. Runs between corners (or the whole loop, from its longest chord) are fitted greedily from
 *    vertex to vertex: the farthest vertex (doubling, then bisection) that one line (both tangents
 *    within 0.5° of the chord) or one biarc with the two vertex tangents reaches with every
 *    vertex in between within the tolerance. Elements join tangentially inside a run; the only
 *    tangent breaks are the corners. (Spike S8: the cubic detour through the SVG fitter turned
 *    faceted fillets into corners and failed on small radii; see reference-tools.md § Fitting.)
 * 6. Slivers: a stretch holding an element under `MIN_ELEMENT` (0.05 mm) is refitted as one line
 *    or arc over its vertices (or with a neighbour's), within the tolerance, leaving at most a
 *    small tangent break (`mergeSlivers`).
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
/** A circle's chord spans at most this (radians, 46°: eight chords and some slack). */
const CIRCLE_MAX_CHORD = (46 * Math.PI) / 180
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

/** Tangent candidates per vertex: `primary` first; `alt` where another reading exists. */
interface RunTangents {
  readonly primary: P[]
  readonly alt: (P | undefined)[]
}

/**
 * Unit tangents at the run's vertices: inside, the tangent of the circle through the vertex and
 * its two neighbours (the central chord for evenly sampled arcs); along a long chord next to
 * short ones (a straight side meeting a fillet) the long chord's direction first and the circle's
 * as the alternative (a slanted strip of facets gives the same pattern on a smooth curve, see
 * `fitRun`); at an open run's ends the tangent of the circle through the first (last) three
 * vertices.
 */
function runTangents(q: readonly P[], closed: boolean): RunTangents {
  const m = q.length - 1
  const t: P[] = []
  const alt: (P | undefined)[] = []
  /** Vertex `i + k` (wrapping on a closed run; undefined past an open run's ends). */
  const at = (i: number, k: number): P | undefined => {
    const j = i + k
    if (closed) return q[(((j % m) + m) % m) as number]
    return j < 0 || j > m ? undefined : q[j]
  }
  /**
   * The circle tangent; next to a chord `LONG_CHORD` times longer, when the short side goes on
   * with another short chord (a fillet's fan of chords), the long chord's direction first. Long
   * and short chords taking turns (a strip of facets cut at a slant) keep the circle tangent only.
   */
  const inner = (i: number): void => {
    const a = at(i, -1)!
    const p = at(i, 0)!
    const b = at(i, 1)!
    const la = dist(a, p)
    const lb = dist(p, b)
    const shortOn = (c: P | undefined, d: P, l: number) =>
      c === undefined || dist(c, d) * LONG_CHORD < l
    // the tangent of the circle through a, p, b (the central chord when la = lb; with uneven
    // chords the central chord leans to the longer one by curvature × (la − lb) / 2)
    const circle = rotate(unit(sub(p, a)), (turnAt(a, p, b) * la) / (la + lb))
    let side: P | undefined
    if (la > LONG_CHORD * lb && shortOn(at(i, 2), b, la)) side = unit(sub(p, a))
    else if (lb > LONG_CHORD * la && shortOn(at(i, -2), a, lb)) side = unit(sub(b, p))
    t.push(side ?? circle)
    alt.push(side === undefined ? undefined : circle)
  }
  for (let i = 0; i <= m; i++) {
    if (closed) {
      inner(i === m ? 0 : i)
    } else if (i === 0 || i === m) {
      alt.push(undefined)
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
    } else inner(i)
  }
  return { primary: t, alt }
}

/** A chord this many times longer than its neighbour is a straight side (`runTangents`). */
const LONG_CHORD = 3
/** Directions within this (radians) count as one for a line between two vertices. */
const LINE_TANGENT = (0.5 * Math.PI) / 180

/**
 * Fits run vertices `q[0..m]` with biarcs between chosen vertices (their tangents shared, so the
 * chain is tangent-continuous) or lines where the tangents agree with the chord: greedily the
 * longest stretch that holds every vertex in between within `tol`. A closed run has
 * `q[m]` = `q[0]`. A vertex with an alternative tangent (`runTangents`) takes it when the primary
 * one does not reach it, and the next stretch goes on from the tangent used, so a smooth curve
 * cut through a slanted strip of facets is not broken up into a sliver at every short chord.
 */
function fitRun(q: readonly P[], closed: boolean, tol: number, maxLeft: number): RunFit {
  const m = q.length - 1
  const tans = runTangents(q, closed)
  const out: Element[] = []
  const stretches: Stretch[] = []
  let worst = 0
  let i = 0
  let ti = tans.primary[0]!
  type Try = { els: Element[]; dev: number; tj: P }
  const attempt = (j: number): Try | undefined => {
    const first = attemptWith(j, tans.primary[j]!)
    const other = closed && j === m ? undefined : tans.alt[j]
    return first ?? (other === undefined ? undefined : attemptWith(j, other))
  }
  const attemptWith = (j: number, tj: P): Try | undefined => {
    const r = attemptTangents(j, tj)
    return r === undefined ? undefined : { ...r, tj }
  }
  const attemptTangents = (j: number, tj: P): { els: Element[]; dev: number } | undefined => {
    const inner = q.slice(i + 1, j)
    const chord = unit(sub(q[j]!, q[i]!))
    const along = (t: P) => Math.abs(Math.atan2(cross(t, chord), dot(t, chord))) <= LINE_TANGENT
    if (along(ti) && along(tj)) {
      const ln: Element = { kind: 'line', a: q[i]!, b: q[j]! }
      const dev = deviation(ln, inner, tol)
      if (dev <= tol) return { els: [ln], dev }
    }
    const bi = biarc(q[i]!, ti, q[j]!, tj)
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
      best = {
        els: [{ kind: 'line', a: q[i]!, b: q[i + 1]! }],
        dev: 0,
        tj: tans.primary[i + 1]!,
      }
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
    stretches.push({ i, j: good, els: best.els, dev: best.dev })
    i = good
    ti = best.tj
  }
  mergeSlivers(q, stretches, tol, maxLeft)
  for (const st of stretches) {
    out.push(...st.els)
    worst = Math.max(worst, st.dev)
  }
  return { elements: out, maxDeviation: worst }
}

/** Fitted elements over the vertices `q[i..j]`. */
interface Stretch {
  i: number
  j: number
  els: Element[]
  dev: number
}

/** Elements shorter than this (mm) are slivers, merged into their neighbours where the points allow. */
export const MIN_ELEMENT = 0.05
/**
 * A merged sliver may leave a tangent break: a right turn under the sharp-corner limit of the
 * inside-corner check (`CORNER_MIN_TURN`, 5°), so a merge never makes a sharp inside corner where
 * the material is on the left (as `fitSection` orients its loops), and a left turn up to half the
 * corner angle (a turn the corner rule already reads as smooth).
 */
const MERGE_RIGHT = (4.5 * Math.PI) / 180 // under CORNER_MIN_TURN in shape-measure.ts

const elementLength = (e: Element): number =>
  e.kind === 'line' ? dist(e.a, e.b) : Math.abs(arcSweep(e)) * dist(e.a, e.centre)

/** Unit tangent at the start of an element. */
function startTangent(e: Element): P {
  if (e.kind === 'line') return unit(sub(e.b, e.a))
  const r = sub(e.a, e.centre)
  return unit(e.ccw ? left(r) : mul(left(r), -1))
}

/** Signed angle from direction a to b (radians, positive = left). */
const angleBetween = (a: P, b: P): number => Math.atan2(cross(a, b), dot(a, b))

/** The element reversed (same points, opposite travel). */
function reversed(e: Element): Element {
  return e.kind === 'line'
    ? { kind: 'line', a: e.b, b: e.a }
    : { kind: 'arc', a: e.b, b: e.a, centre: e.centre, ccw: !e.ccw }
}

/** The arc (or line) through three points; undefined when they are collinear and b is not between. */
function arcThrough3(a: P, b: P, c: P): Element | undefined {
  const d = 2 * cross(sub(b, a), sub(c, a))
  if (Math.abs(d) < 1e-12) return { kind: 'line', a, b: c }
  const aa = dot(a, a)
  const bb = dot(b, b)
  const cc = dot(c, c)
  const centre: P = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
  ]
  return { kind: 'arc', a, b: c, centre, ccw: d > 0 }
}

/**
 * Replaces stretches holding a sliver (an element under `MIN_ELEMENT`) by one line or arc over
 * the same vertices (alone, or joined with a neighbouring stretch when the stretch is itself that
 * short), keeping every vertex within `tol` and the tangent breaks it leaves at both ends under
 * the merge limits (`MERGE_RIGHT`, `maxLeft`); of the candidates the one with the smallest break wins. Feature-rich sections
 * (spike S8) otherwise keep short facets between nearly tangent runs as their own elements.
 */
function mergeSlivers(q: readonly P[], st: Stretch[], tol: number, maxLeft: number): void {
  const breakOk = (t: number) => (t >= 0 ? t <= maxLeft : -t < MERGE_RIGHT)
  const hasSliver = (s: Stretch) => s.els.some((e) => elementLength(e) < MIN_ELEMENT)
  const candidates = (i: number, j: number, tIn: P | undefined, tOut: P | undefined) => {
    const out: Element[] = [{ kind: 'line', a: q[i]!, b: q[j]! }]
    if (tIn !== undefined) out.push(arcThrough(q[i]!, tIn, q[j]!))
    if (tOut !== undefined) out.push(reversed(arcThrough(q[j]!, mul(tOut, -1), q[i]!)))
    if (j - i >= 2) {
      const mid = arcThrough3(q[i]!, q[(i + j) >> 1]!, q[j]!)
      if (mid !== undefined) out.push(mid)
    }
    return out
  }
  /** Best single element over q[i..j] between the neighbours' end and start tangents. */
  const single = (i: number, j: number, tIn: P | undefined, tOut: P | undefined) => {
    let best: { e: Element; dev: number; brk: number } | undefined
    for (const e of candidates(i, j, tIn, tOut)) {
      if (elementLength(e) < MIN_ELEMENT && dist(q[i]!, q[j]!) >= MIN_ELEMENT) continue
      const dev = deviation(e, q.slice(i + 1, j), tol)
      if (!(dev <= tol)) continue
      const b0 = tIn === undefined ? 0 : angleBetween(tIn, startTangent(e))
      const b1 = tOut === undefined ? 0 : angleBetween(endTangent(e), tOut)
      if (!breakOk(b0) || !breakOk(b1)) continue
      const brk = Math.max(Math.abs(b0), Math.abs(b1))
      if (best === undefined || brk < best.brk) best = { e, dev, brk }
    }
    return best
  }
  const tangentIn = (k: number) => (k > 0 ? endTangent(st[k - 1]!.els.at(-1)!) : undefined)
  const tangentOut = (k: number) =>
    k + 1 < st.length ? startTangent(st[k + 1]!.els[0]!) : undefined
  for (let k = 0; k < st.length; k++) {
    const s = st[k]!
    if (!hasSliver(s)) continue
    const alone = single(s.i, s.j, tangentIn(k), tangentOut(k))
    if (alone !== undefined) {
      st[k] = { i: s.i, j: s.j, els: [alone.e], dev: alone.dev }
      continue
    }
    // a short stretch: one element with the next or the previous stretch
    if (k + 1 < st.length) {
      const n = st[k + 1]!
      const both = single(s.i, n.j, tangentIn(k), tangentOut(k + 1))
      if (both !== undefined) {
        st.splice(k, 2, { i: s.i, j: n.j, els: [both.e], dev: both.dev })
        continue
      }
    }
    if (k > 0) {
      const p = st[k - 1]!
      const both = single(p.i, s.j, tangentIn(k - 1), tangentOut(k))
      if (both !== undefined) st.splice(k - 1, 2, { i: p.i, j: s.j, els: [both.e], dev: both.dev })
    }
  }
}

/**
 * The circle a cleaned closed polyline is (step 2 of the file comment): at least 8 vertices, every
 * one within `tolerance` of the least-squares circle and no chord spanning more than 46° of it;
 * undefined otherwise. Shared with the hole finder (reference-tools.md § Features (holes)).
 */
export function circleOf(
  pts: readonly P[],
  tolerance: number,
): { circle: { centre: P; radius: number }; deviation: number } | undefined {
  const n = pts.length
  if (n < 8 || ccwArea(pts) === 0) return undefined
  const c = lsCircle(pts)
  if (c === undefined) return undefined
  let dev = 0
  for (const p of pts) dev = Math.max(dev, Math.abs(dist(p, c.centre) - c.radius))
  if (dev > tolerance) return undefined
  // no chord spans more than a faceted circle's (8 chords at least): a straight side whose
  // ends lie on the circle (a D-shaped hole's flat) has no vertex along it to tell
  const maxChord = 2 * c.radius * Math.sin(CIRCLE_MAX_CHORD / 2)
  if (!pts.every((p, i) => dist(p, pts[(i + 1) % n]!) <= maxChord)) return undefined
  return { circle: c, deviation: dev }
}

/** Fits a closed polyline (see the file comment). At least three distinct vertices. */
export function fitClosedPolyline(points: readonly P[], o: PolylineFitOptions): PolylineFit {
  const pts = cleanPolyline(points)
  const n = pts.length
  if (n < 3) return { elements: [], corners: [], maxDeviation: 0 }
  const tol = o.tolerance
  // a circle?
  const found = circleOf(pts, tol)
  if (found !== undefined) {
    const { circle: c, deviation } = found
    const ccw = ccwArea(pts) > 0
    const a: P = [c.centre[0] + c.radius, c.centre[1]]
    const b: P = [c.centre[0] - c.radius, c.centre[1]]
    return {
      elements: [
        { kind: 'arc', a, b, centre: c.centre, ccw },
        { kind: 'arc', a: b, b: a, centre: c.centre, ccw },
      ],
      corners: [],
      maxDeviation: deviation,
      circle: c,
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
    const r = fitRun(q, true, tol, o.cornerAngle / 2)
    elements.push(...r.elements)
    maxDeviation = r.maxDeviation
  } else {
    for (let k = 0; k < corners.length; k++) {
      const from = corners[k]!
      const to = corners[(k + 1) % corners.length]!
      const count = (to - from + n) % n || n
      const q = Array.from({ length: count + 1 }, (_, s) => pts[(from + s) % n]!)
      const r = fitRun(q, false, tol, o.cornerAngle / 2)
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
