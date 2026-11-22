// Spike S1 (docs/decisions/0019-2d-geometry-library.md): greedy arc re-fitting of a closed polygon
// into lines and arcs within `tol`, the step a polygon-only library (Clipper2) needs to give G2/G3
// output again. Deliberately simple: the spike measures what a straightforward fitter recovers.

import type { Loop, Pt, Vertex } from './geom.ts'

function circle3(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-14) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x, y, r: Math.hypot(a.x - x, a.y - y) }
}

function lineFits(p: readonly Pt[], i: number, j: number, tol: number): boolean {
  const a = p[i]!
  const b = p[j]!
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return j - i <= 1
  for (let k = i + 1; k < j; k++) {
    const q = p[k]!
    if (Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / len > tol) return false
    const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / (len * len)
    if (t < 0 || t > 1) return false
  }
  return true
}

/** Bulge of the arc a→b through the circle, or null when the points between do not fit it. */
function arcFits(p: readonly Pt[], i: number, j: number, tol: number, maxR: number): number | null {
  if (j - i < 2) return null
  const a = p[i]!
  const b = p[j]!
  const m = p[(i + j) >> 1]!
  const c = circle3(a, m, b)
  if (!c || c.r > maxR) return null
  const turn = Math.sign((m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x))
  // sweep sign: counter-clockwise when the middle point lies to the right of the chord
  const ccw = turn > 0
  const ang = (q: Pt): number => Math.atan2(q.y - c.y, q.x - c.x)
  const a0 = ang(a)
  const norm = (t: number): number => {
    const s = ccw ? t - a0 : a0 - t
    return ((s % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  }
  const sweep = norm(ang(b))
  let last = 0
  for (let k = i + 1; k < j; k++) {
    const q = p[k]!
    if (Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - c.r) > tol) return null
    const s = norm(ang(q))
    if (s < last - 1e-9 || s > sweep + 1e-9) return null // monotone along the arc
    last = s
  }
  // edge midpoints too: a polygon corner has three points on some circle, but its edges are far
  // from it, while a flattened arc's chords stay within the sagitta tolerance
  for (let k = i; k < j; k++) {
    const q = p[k]!
    const r = p[k + 1]!
    const mx = (q.x + r.x) / 2 - c.x
    const my = (q.y + r.y) / 2 - c.y
    if (Math.abs(Math.hypot(mx, my) - c.r) > 2 * tol) return null
  }
  const bulge = Math.tan(sweep / 4)
  return ccw ? bulge : -bulge
}

/** Start where the turning angle is largest, so arcs are not cut at an arbitrary vertex. */
function sharpestVertex(p: readonly Pt[]): number {
  let best = 0
  let bestTurn = -1
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length]!
    const b = p[i]!
    const c = p[(i + 1) % p.length]!
    const t = Math.abs(
      Math.atan2(
        (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
        (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y),
      ),
    )
    if (t > bestTurn) {
      bestTurn = t
      best = i
    }
  }
  return best
}

/**
 * Lines win over arcs when both fit; each run is extended as far as it fits (exponential then
 * binary search, so long arcs cost O(k log k)).
 */
export function refit(polygon: readonly Pt[], tol: number, maxR = 1e4): Loop {
  const n = polygon.length
  if (n < 3) return { closed: true, verts: polygon.map((q) => [q.x, q.y, 0] as const) }
  const s = sharpestVertex(polygon)
  const p = [...polygon.slice(s), ...polygon.slice(0, s), polygon[s]!]
  const verts: Vertex[] = []
  let i = 0
  while (i < n) {
    const fit = (j: number): number | null => {
      if (lineFits(p, i, j, tol)) return 0
      return arcFits(p, i, j, tol, maxR)
    }
    let good = i + 1
    let step = 1
    while (good + step <= n && fit(good + step) !== null) {
      good += step
      step *= 2
    }
    let lo = good
    let hi = Math.min(good + step, n + 1)
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (fit(mid) !== null) lo = mid
      else hi = mid
    }
    const bulge = fit(lo) ?? 0
    verts.push([p[i]!.x, p[i]!.y, bulge])
    i = lo
  }
  return { closed: true, verts }
}
