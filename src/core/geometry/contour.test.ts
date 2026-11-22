import { describe, expect, it } from 'vitest'
import {
  arcSegments,
  contourElements,
  flattenPath,
  flattenRing,
  offsetContour,
  parameterize,
  perimeter,
} from './contour'
import { CHORD_TOLERANCE, type AnalyticContour as Contour, type Vec2 } from './model'

const rect = (length: number, width: number, cornerRadius: number): Contour => ({
  kind: 'rectangle',
  length,
  width,
  cornerRadius,
})

/** Signed distance to a centered rounded rectangle (negative inside). Independent oracle. */
function sdRoundedRect(p: Vec2, c: Extract<Contour, { kind: 'rectangle' }>): number {
  const r = c.cornerRadius
  const qx = Math.abs(p[0]) - (c.length / 2 - r)
  const qy = Math.abs(p[1]) - (c.width / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r
}

describe('arcSegments', () => {
  it('uses the fewest chords whose sagitta stays within the tolerance', () => {
    for (const [r, sweep] of [
      [4, Math.PI / 2],
      [3, 2 * Math.PI],
      [11, Math.PI / 2],
      [0.5, Math.PI / 2],
    ] as const) {
      const n = arcSegments(r, sweep)
      const sagitta = (k: number) => r * (1 - Math.cos(sweep / k / 2))
      expect(sagitta(n)).toBeLessThanOrEqual(CHORD_TOLERANCE + 1e-12)
      if (n > 1) expect(sagitta(n - 1)).toBeGreaterThan(CHORD_TOLERANCE)
    }
  })

  it('is at least 1 for an open arc, also for a zero or tiny radius', () => {
    expect(arcSegments(0, Math.PI / 2)).toBe(1)
    expect(arcSegments(0.001, Math.PI / 2)).toBe(1)
  })

  it('keeps closed circles a polygon: ≥ 3 chords inscribed, ≥ 4 circumscribed', () => {
    for (const r of [0.001, 0.005, 0.01, 0.02]) {
      expect(arcSegments(r, 2 * Math.PI)).toBeGreaterThanOrEqual(3)
      expect(arcSegments(r, 2 * Math.PI, CHORD_TOLERANCE, 'circumscribed')).toBeGreaterThanOrEqual(
        4,
      )
    }
  })

  it('keeps both flattenings within the tolerance over a sweep of radii', () => {
    const radii = Array.from({ length: 400 }, (_, i) => 0.001 * 1.03 ** i) // 0.001 … ~130 mm
    for (const r of radii)
      for (const sweep of [Math.PI / 2, 2 * Math.PI]) {
        const ni = arcSegments(r, sweep)
        expect(r * (1 - Math.cos(sweep / ni / 2)), `inscribed r=${r}`).toBeLessThanOrEqual(
          CHORD_TOLERANCE + 1e-12,
        )
        const nc = arcSegments(r, sweep, CHORD_TOLERANCE, 'circumscribed')
        expect(r * (1 / Math.cos(sweep / nc / 2) - 1), `circumscribed r=${r}`).toBeLessThanOrEqual(
          CHORD_TOLERANCE + 1e-12,
        )
      }
  })

  it('flattens circumscribed corners and circles no further than the tolerance out', () => {
    for (const r of [0.02, 0.024, 0.03, 0.034, 0.5, 4]) {
      for (const c of [rect(10, 8, r), { kind: 'circle', radius: r } as const]) {
        const ring = flattenRing(parameterize(c, [0], 'circumscribed'), 0).unwrap()
        for (const s of ring) {
          const d =
            c.kind === 'circle'
              ? Math.hypot(...s.point) - r
              : sdRoundedRect(s.point, c as Extract<Contour, { kind: 'rectangle' }>)
          expect(d, `r=${r} ${c.kind}`).toBeLessThanOrEqual(CHORD_TOLERANCE + 1e-9)
          expect(d).toBeGreaterThanOrEqual(-1e-9)
        }
      }
    }
  })
})

describe('offsetContour', () => {
  it('offsets a rounded rectangle inward and outward', () => {
    expect(offsetContour(rect(40, 25, 4), 2).unwrap()).toEqual(rect(36, 21, 2))
    expect(offsetContour(rect(84, 44, 5), -6).unwrap()).toEqual(rect(96, 56, 11))
  })

  it('rounds sharp corners when offset outward and keeps them sharp inward', () => {
    expect(offsetContour(rect(10, 8, 0), -3).unwrap()).toEqual(rect(16, 14, 3))
    expect(offsetContour(rect(10, 8, 0), 1).unwrap()).toEqual(rect(8, 6, 0))
  })

  it('collapses a circle to a point and rejects offsets past the center', () => {
    expect(offsetContour({ kind: 'circle', radius: 3 }, 3).unwrap()).toEqual({
      kind: 'circle',
      radius: 0,
    })
    expect(offsetContour({ kind: 'circle', radius: 3 }, 3.1).isNone()).toBe(true)
    expect(offsetContour(rect(10, 8, 0), 4.5).isNone()).toBe(true)
  })
})

describe('contourElements', () => {
  it('walks a rounded rectangle counter-clockwise from the start of wall[0]', () => {
    const els = contourElements(rect(84, 44, 5))
    expect(els.map((e) => `${e.label.role}[${e.label.index}]`)).toEqual([
      'wall[0]',
      'corner[1]',
      'wall[1]',
      'corner[2]',
      'wall[2]',
      'corner[3]',
      'wall[3]',
      'corner[0]',
    ])
    expect(els[0]).toMatchObject({ kind: 'line', from: [-37, -22], to: [37, -22] })
    expect(els[1]).toMatchObject({ kind: 'arc', center: [37, -17], radius: 5 })
  })

  it('gives a circle one wall starting at the front', () => {
    const [e] = contourElements({ kind: 'circle', radius: 3 })
    expect(e).toMatchObject({ kind: 'arc', label: { role: 'wall', index: 0 }, radius: 3 })
    expect(contourElements({ kind: 'circle', radius: 3 })).toHaveLength(1)
  })
})

describe('perimeter', () => {
  it('matches the analytic length', () => {
    expect(perimeter(rect(84, 44, 5))).toBeCloseTo(2 * 74 + 2 * 34 + 10 * Math.PI, 12)
    expect(perimeter({ kind: 'circle', radius: 3 })).toBeCloseTo(6 * Math.PI, 12)
  })
})

describe('flattenRing', () => {
  const c = rect(40, 25, 4)

  it('keeps every inscribed point on the contour and every chord within the tolerance', () => {
    const p = parameterize(c, [0, 2], 'inscribed')
    for (const offset of [0, 2]) {
      const oc = offsetContour(c, offset).unwrap() as Extract<Contour, { kind: 'rectangle' }>
      const ring = flattenRing(p, offset).unwrap()
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!.point
        const b = ring[(i + 1) % ring.length]!.point
        expect(Math.abs(sdRoundedRect(a, oc))).toBeLessThan(1e-9)
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        const d = sdRoundedRect(mid, oc)
        expect(d).toBeLessThanOrEqual(1e-9)
        expect(d).toBeGreaterThanOrEqual(-CHORD_TOLERANCE)
      }
    }
  })

  it('keeps circumscribed points outside the contour, within the tolerance', () => {
    const p = parameterize(c, [0], 'circumscribed')
    const ring = flattenRing(p, 0).unwrap()
    for (const s of ring) {
      const d = sdRoundedRect(s.point, c as Extract<Contour, { kind: 'rectangle' }>)
      expect(d).toBeGreaterThanOrEqual(-1e-9)
      expect(d).toBeLessThanOrEqual(CHORD_TOLERANCE + 1e-9)
    }
  })

  it('uses one parameterization for all levels, labelling each segment', () => {
    const p = parameterize(c, [0, 1, 4], 'inscribed')
    const rings = [0, 1, 4].map((o) => flattenRing(p, o).unwrap())
    expect(rings[1]).toHaveLength(rings[0]!.length)
    expect(rings[2]).toHaveLength(rings[0]!.length)
    // offset 4 = cornerRadius: every corner collapses to one point
    const corner1 = rings[2]!.filter((s) => s.label.role === 'corner' && s.label.index === 1)
    expect(new Set(corner1.map((s) => s.point.join()))).toHaveProperty('size', 1)
    const walls = new Set(rings[0]!.map((s) => `${s.label.role}[${s.label.index}]`))
    expect(walls).toEqual(
      new Set(
        ['wall[0]', 'wall[1]', 'wall[2]', 'wall[3]'].concat(
          [0, 1, 2, 3].map((i) => `corner[${i}]`),
        ),
      ),
    )
  })

  it('flattens a circle into one closed wall', () => {
    const p = parameterize({ kind: 'circle', radius: 3 }, [0], 'inscribed')
    const ring = flattenRing(p, 0).unwrap()
    expect(ring.length).toBe(arcSegments(3, 2 * Math.PI))
    for (const s of ring) expect(Math.hypot(...s.point)).toBeCloseTo(3, 12)
  })
})

describe('flattenPath', () => {
  const c = rect(84, 44, 5)
  const p = parameterize(c, [-1, 7], 'inscribed')

  it('returns the open sub-path by arc length, offset with the contour', () => {
    // wall[0] runs from s = 0 to 74; its middle is the front middle
    const path = flattenPath(p, 0, 33, 41).unwrap()
    expect(path).toEqual([
      [-4, -22],
      [4, -22],
    ])
    expect(flattenPath(p, -6, 33, 41).unwrap()).toEqual([
      [-4, -28],
      [4, -28],
    ])
  })

  it('follows a corner and wraps past the start', () => {
    // straddles corner[1] (s 74..74+5π/2)
    const around = flattenPath(p, 0, 70, 90).unwrap()
    expect(around[0]).toEqual([33, -22])
    expect(around.at(-1)![0]).toBeCloseTo(42, 12)
    expect(around.length).toBeGreaterThan(3)
    for (const q of around)
      expect(Math.abs(sdRoundedRect(q, c as Extract<Contour, { kind: 'rectangle' }>))).toBeLessThan(
        1e-9,
      )
    // across s = 0: from the end of wall[3] / corner[0] into wall[0]
    const wrapped = flattenPath(p, 0, -4, 4).unwrap()
    expect(wrapped[0]![1]).toBeLessThan(-17)
    expect(wrapped.at(-1)).toEqual([-33, -22])
  })
})
