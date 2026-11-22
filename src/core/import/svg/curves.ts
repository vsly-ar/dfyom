/**
 * Source curves for arc fitting: a segment (in mm) as a parametric curve on t ∈ [0, 1] with first
 * and second derivatives, its cusps (no tangent: the fit leaves a true corner) and its break points
 * (inflections, ellipse vertices: G1 joins). Ported from spike S5 (spikes/biarc/curves.ts).
 * Doc: docs/architecture/shapes.md#arc-fitting
 */
import type { Seg } from './path-data'
import type { Pt } from './transform'

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x
export const len = (a: Pt): number => Math.hypot(a.x, a.y)
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
export const unit = (a: Pt): Pt => {
  const l = len(a)
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 }
}
export const rot = (a: Pt, ang: number): Pt => {
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

/**
 * A segment ready to fit. `line` and `arc` (circular, exact `bulge`) are not fitted; `cubic` and
 * `ellipse` are.
 */
export interface Curve {
  readonly kind: 'line' | 'arc' | 'cubic' | 'ellipse'
  readonly p: (t: number) => Pt
  readonly d: (t: number) => Pt
  readonly dd: (t: number) => Pt
  /** Size scale (control polygon length) for relative epsilons. */
  readonly scale: number
  /** Parameters in (0, 1) without a tangent: the fit splits here and may leave a corner. */
  readonly cusps: readonly number[]
  /** Parameters in (0, 1) where the fit pre-splits (inflections, ellipse vertices); G1 there. */
  readonly breaks: readonly number[]
  /** Circular arc only: tan(sweep / 4), positive counter-clockwise. */
  readonly bulge?: number
}

/**
 * Unit tangent in the direction of travel at t. `side` +1 looks forward (start of a piece), −1
 * backward (end of a piece); at a vanishing derivative (cusp, or a control point on its end point)
 * the limit direction comes from the higher derivatives.
 */
export function tangent(c: Curve, t: number, side: 1 | -1): Pt {
  const d = c.d(t)
  const s = c.scale
  if (len(d) > 1e-9 * s) return unit(d)
  const dd = c.dd(t)
  if (len(dd) > 1e-9 * s) return unit(mul(dd, side))
  // the third derivative of a cubic is constant: B'(t ± h) ≈ h²/2 · B''' on both sides
  const h = 1e-4 * side
  const q = c.d(Math.min(1, Math.max(0, t + h)))
  if (len(q) > 0) return unit(q)
  return unit(sub(c.p(1), c.p(0)))
}

function rootsQuadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c))
  if (scale === 0) return []
  if (Math.abs(a) < 1e-12 * scale) return Math.abs(b) < 1e-12 * scale ? [] : [-c / b]
  const disc = b * b - 4 * a * c
  if (disc < -1e-12 * scale * scale) return []
  const sq = Math.sqrt(Math.max(0, disc))
  const q = -0.5 * (b + Math.sign(b || 1) * sq)
  const r = [q / a]
  if (q !== 0) r.push(c / q)
  return r
}

const inside01 = (ts: number[]): number[] =>
  [...new Set(ts.filter((t) => t > 1e-9 && t < 1 - 1e-9).map((t) => +t.toPrecision(15)))].sort(
    (a, b) => a - b,
  )

export function lineCurve(a: Pt, b: Pt): Curve {
  const v = sub(b, a)
  return {
    kind: 'line',
    scale: len(v) || 1,
    cusps: [],
    breaks: [],
    p: (t) => add(a, mul(v, t)),
    d: () => v,
    dd: () => ({ x: 0, y: 0 }),
  }
}

export function cubicCurve(p0: Pt, c1: Pt, c2: Pt, p3: Pt): Curve {
  const a = sub(c1, p0)
  const b = sub(c2, c1)
  const c = sub(p3, c2)
  // B'(t)/3 = A t² + B t + C
  const A = add(sub(a, mul(b, 2)), c)
  const B = mul(sub(b, a), 2)
  const C = a
  const scale = len(a) + len(b) + len(c)
  const d = (t: number): Pt => mul(add(add(mul(A, t * t), mul(B, t)), C), 3)
  const dd = (t: number): Pt => mul(add(mul(A, 2 * t), B), 3)
  // cross(B', B'')/9 = −cross(A,B) t² + 2 cross(C,A) t + cross(C,B): inflections and cusps
  const crit = inside01(rootsQuadratic(-cross(A, B), 2 * cross(C, A), cross(C, B)))
  // cusps: x' and y' share a root (or the derivative nearly vanishes at a critical point)
  const xr = rootsQuadratic(A.x, B.x, C.x)
  const yr = rootsQuadratic(A.y, B.y, C.y)
  const cand = inside01([...crit, ...xr, ...yr])
  const cusps = cand.filter((t) => len(d(t)) <= 1e-6 * scale)
  const breaks = crit.filter((t) => !cusps.some((u) => Math.abs(u - t) < 1e-6))
  return {
    kind: 'cubic',
    scale: scale || 1,
    cusps,
    breaks,
    d,
    dd,
    p: (t) => {
      const s = 1 - t
      const w0 = s * s * s
      const w1 = 3 * s * s * t
      const w2 = 3 * s * t * t
      const w3 = t * t * t
      return {
        x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p3.x,
        y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p3.y,
      }
    },
  }
}

/** Relative radius difference below which an ellipse is a circle (its arcs stay exact). */
const CIRCULAR = 1e-9

/**
 * `c + u·cos θ + v·sin θ`, θ from `t0` over `dt`, in canonical form (principal radii and axis
 * angle from the 2×2 SVD of [u v]; a reflection flips the sweep). Circular → exact `arc` curve.
 */
export function ellipseCurve(c: Pt, u: Pt, v: Pt, t0: number, dt: number): Curve {
  // [u v] = R(phi) · diag(sx, sy) · R(psi); sy < 0 is a reflection
  const E = (u.x + v.y) / 2
  const F = (u.x - v.y) / 2
  const G = (u.y + v.x) / 2
  const H = (u.y - v.x) / 2
  const Q = Math.hypot(E, H)
  const R = Math.hypot(F, G)
  const sx = Q + R
  const sy = Q - R
  const a1 = Math.atan2(G, F)
  const a2 = Math.atan2(H, E)
  const psi = (a2 - a1) / 2
  const phi = (a2 + a1) / 2
  // M (cos θ, sin θ) = R(phi) diag(sx, |sy|) (cos θ', sin θ'), θ' = ±(θ + psi)
  const flip = sy < 0
  const th0 = flip ? -(t0 + psi) : t0 + psi
  const dth = flip ? -dt : dt
  return canonicalEllipse(c, sx, Math.abs(sy), phi, th0, dth)
}

function canonicalEllipse(
  c: Pt,
  rx: number,
  ry: number,
  phi: number,
  th0: number,
  dth: number,
): Curve {
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const R = (x: number, y: number): Pt => ({ x: cp * x - sp * y, y: sp * x + cp * y })
  const circular = Math.abs(rx - ry) <= CIRCULAR * Math.max(rx, ry)
  const breaks: number[] = []
  if (!circular) {
    // vertices (curvature extrema) inside the sweep
    const k0 = Math.ceil(Math.min(th0, th0 + dth) / (Math.PI / 2))
    const k1 = Math.floor(Math.max(th0, th0 + dth) / (Math.PI / 2))
    for (let k = k0; k <= k1; k++) breaks.push(((k * Math.PI) / 2 - th0) / dth)
  }
  const base = {
    scale: Math.max(rx, ry) * Math.abs(dth) || 1,
    cusps: [],
    breaks: inside01(breaks),
    p: (t: number): Pt => {
      const th = th0 + dth * t
      return add(c, R(rx * Math.cos(th), ry * Math.sin(th)))
    },
    d: (t: number): Pt => {
      const th = th0 + dth * t
      return mul(R(-rx * Math.sin(th), ry * Math.cos(th)), dth)
    },
    dd: (t: number): Pt => {
      const th = th0 + dth * t
      return mul(R(-rx * Math.cos(th), -ry * Math.sin(th)), dth * dth)
    },
  }
  return circular
    ? { ...base, kind: 'arc', bulge: Math.tan(dth / 4) }
    : { ...base, kind: 'ellipse' }
}

/** The curve of a segment (already in mm). */
export function curveOf(s: Seg): Curve {
  switch (s.kind) {
    case 'line':
      return lineCurve(s.a, s.b)
    case 'cubic':
      return cubicCurve(s.p0, s.c1, s.c2, s.p3)
    case 'ellipse':
      return ellipseCurve(s.c, s.u, s.v, s.t0, s.dt)
  }
}
