// The polyline fitter of reference sections (DF60 P1): faceted circles, faceted fillets back to
// arcs within the tolerance, sharp corners kept, and the fit staying within the tolerance.
// Spec: docs/modes/reference-tools.md#test-plans (P1 section and fitting)
import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../model'
import { fitClosedPolyline } from './fit-polyline'
import { arcRadius, signedArea, type Element } from './model'
import { insideCorners } from '../shape-measure'

const TOL = 0.01
const opts = { tolerance: TOL, cornerAngle: (15 * Math.PI) / 180 }

const circle = (r: number, n: number, c: Vec2 = [3, -2]): Vec2[] =>
  Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]
  })

/** A rectangle (counter-clockwise) with corner radius r, each corner `chords` facets. */
function roundedRect(w: number, h: number, r: number, chords: number): Vec2[] {
  const out: Vec2[] = []
  const corners: [Vec2, number][] = [
    [[w - r, r], -Math.PI / 2],
    [[w - r, h - r], 0],
    [[r, h - r], Math.PI / 2],
    [[r, r], Math.PI],
  ]
  for (const [c, start] of corners)
    for (let k = 0; k <= chords; k++) {
      const a = start + ((Math.PI / 2) * k) / chords
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    }
  return out
}

/** Points along a straight edge, so the sides are polylines too. */
function densify(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = []
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length]!
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  })
  return out
}

const arcs = (els: readonly Element[]) => els.filter((e) => e.kind === 'arc')

describe('fitClosedPolyline', () => {
  it.each([32, 64, 256])('a faceted circle (%i chords) fits to one circle', (n) => {
    const r = 12.5
    const f = fitClosedPolyline(circle(r, n), opts)
    expect(f.circle).toBeDefined()
    // the chords' vertices lie on the circle: the least-squares circle is within the tolerance
    expect(Math.abs(f.circle!.radius - r)).toBeLessThan(TOL)
    expect(f.elements).toHaveLength(2)
    expect(f.maxDeviation).toBeLessThanOrEqual(TOL)
  })

  it('a rounded rectangle r 4 (8 chords per corner) gives four arcs of r 4 ± 0.01', () => {
    const f = fitClosedPolyline(densify(roundedRect(40, 25, 4, 8), 2), opts)
    expect(f.circle).toBeUndefined()
    expect(f.corners).toHaveLength(0)
    const radii = arcs(f.elements).map(arcRadius)
    expect(radii.length).toBeGreaterThanOrEqual(4)
    for (const r of radii) expect(Math.abs(r - 4)).toBeLessThan(TOL)
    // read as a pocket, its smallest inside radius is the fitted 4, not 0
    const c = insideCorners([{ elements: f.elements }], 1)
    expect(Math.min(...c.map((x) => x.radius))).toBeCloseTo(4, 1)
    expect(c.every((x) => x.radius > 0)).toBe(true)
    expect(f.maxDeviation).toBeLessThanOrEqual(TOL)
    expect(f.elements.length).toBeLessThanOrEqual(12)
  })

  it('a sharp rectangle keeps four corners and no micro-arc', () => {
    const f = fitClosedPolyline(
      densify(
        [
          [0, 0],
          [30, 0],
          [30, 20],
          [0, 20],
        ],
        1,
      ),
      opts,
    )
    expect(f.corners).toHaveLength(4)
    expect(arcs(f.elements)).toHaveLength(0)
    expect(f.elements).toHaveLength(4)
    expect(insideCorners([{ elements: f.elements }], 1).every((x) => x.radius === 0)).toBe(true)
  })

  it('keeps the direction of the polyline and closes the chain', () => {
    const pts = densify(roundedRect(40, 25, 4, 8), 2).reverse()
    const f = fitClosedPolyline(pts, opts)
    expect(signedArea({ elements: f.elements })).toBeLessThan(0)
    for (let i = 0; i < f.elements.length; i++) {
      const a = f.elements[i]!.b
      const b = f.elements[(i + 1) % f.elements.length]!.a
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9)
    }
  })

  it('stays within the tolerance on a wavy outline with mixed curvature', () => {
    const pts: Vec2[] = Array.from({ length: 720 }, (_, k) => {
      const a = (2 * Math.PI * k) / 720
      const r = 30 + 2 * Math.sin(3 * a)
      return [r * Math.cos(a), r * Math.sin(a)]
    })
    const f = fitClosedPolyline(pts, opts)
    expect(f.maxDeviation).toBeLessThanOrEqual(TOL)
    expect(f.elements.length).toBeLessThan(pts.length / 4)
  })
})
