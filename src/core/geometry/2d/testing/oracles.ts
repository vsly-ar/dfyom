/**
 * Independent checks of 2D port results (spike S1's oracles, spikes/2d/geom.ts): the offset
 * distance oracle and proper crossings of the flattened loops. Test-only.
 */
import type { Vec2 } from '../../model'
import { elementClosest, elementPointAt } from '../measure'
import { arcRadius, arcSweep, type Loop } from '../model'

/**
 * Offset oracle: every point of the offset boundary lies exactly `|d|` from the input boundary.
 * Returns the largest deviation over `samples` points per output element.
 */
export function maxOffsetError(
  input: readonly Loop[],
  output: readonly Loop[],
  d: number,
  samples = 5,
): number {
  const elements = input.flatMap((l) => l.elements)
  let worst = 0
  for (const l of output)
    for (const e of l.elements)
      for (let k = 0; k < samples; k++) {
        const p = elementPointAt(e, (k + 0.5) / samples).point
        let best = Infinity
        for (const q of elements) {
          const c = elementClosest(q, p)
          best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1]))
        }
        worst = Math.max(worst, Math.abs(best - Math.abs(d)))
      }
  return worst
}

/** Inscribed flattening within chord tolerance `tol`; the start point is not repeated. */
export function flattenLoop(l: Loop, tol: number): Vec2[] {
  const out: Vec2[] = []
  for (const e of l.elements) {
    out.push(e.a)
    if (e.kind === 'line') continue
    const r = arcRadius(e)
    const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI
    const n = Math.max(1, Math.ceil(Math.abs(arcSweep(e)) / step))
    for (let k = 1; k < n; k++) out.push(elementPointAt(e, k / n).point)
  }
  return out
}

const orient = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/**
 * Proper (transversal) crossings between edges of the loops flattened to `tol`, self and mutual;
 * touching and shared endpoints do not count. A valid region has none.
 */
export function crossings(loops: readonly Loop[], tol = 0.002): number {
  const edges: [Vec2, Vec2][] = []
  for (const l of loops) {
    const pts = flattenLoop(l, tol)
    for (let i = 0; i < pts.length; i++) edges.push([pts[i]!, pts[(i + 1) % pts.length]!])
  }
  if (edges.length === 0) return 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [a, b] of edges) {
    minX = Math.min(minX, a[0], b[0])
    minY = Math.min(minY, a[1], b[1])
    maxX = Math.max(maxX, a[0], b[0])
    maxY = Math.max(maxY, a[1], b[1])
  }
  const cell = Math.max((maxX - minX) / Math.sqrt(edges.length), (maxY - minY) / 64, 1e-6)
  const grid = new Map<string, number[]>()
  edges.forEach(([a, b], ei) => {
    const x0 = Math.floor((Math.min(a[0], b[0]) - minX) / cell)
    const x1 = Math.floor((Math.max(a[0], b[0]) - minX) / cell)
    const y0 = Math.floor((Math.min(a[1], b[1]) - minY) / cell)
    const y1 = Math.floor((Math.max(a[1], b[1]) - minY) / cell)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`
        const list = grid.get(k)
        if (list) list.push(ei)
        else grid.set(k, [ei])
      }
  })
  const seen = new Set<number>()
  let count = 0
  const e = 1e-12
  for (const list of grid.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const ia = list[i]!
        const ib = list[j]!
        const key = Math.min(ia, ib) * edges.length + Math.max(ia, ib)
        if (seen.has(key)) continue
        seen.add(key)
        const [a, b] = edges[ia]!
        const [c, d] = edges[ib]!
        const o1 = orient(a, b, c)
        const o2 = orient(a, b, d)
        const o3 = orient(c, d, a)
        const o4 = orient(c, d, b)
        if (
          ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) &&
          ((o3 > e && o4 < -e) || (o3 < -e && o4 > e))
        )
          count++
      }
  return count
}
