// Signed distance to a closed mesh (DF60 P5, docs/modes/reference-tools.md#overlay-ui): the sign
// from the angle-weighted pseudo-normal is right on faces, convex and concave edges and corners.
import { describe, expect, it } from 'vitest'
import { MeshBvh, signedDistances } from './mesh-distance'
import { boxSoup } from './stl.testing'

/** The L-shaped prism 0..20 × 0..10 ∪ 0..10 × 10..20, `h` high: one concave edge at (10, 10). */
function lPrism(h: number): number[] {
  const poly: [number, number][] = [
    [0, 0],
    [20, 0],
    [20, 10],
    [10, 10],
    [10, 20],
    [0, 20],
  ]
  const out: number[] = []
  // (0, 0) sees every vertex: a fan triangulates the L
  for (let i = 1; i + 1 < poly.length; i++) {
    const [a, b, c] = [poly[0]!, poly[i]!, poly[i + 1]!]
    out.push(...a, h, ...b, h, ...c, h) // top, counter-clockwise from above
    out.push(...a, 0, ...c, 0, ...b, 0) // bottom, reversed
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    out.push(...a, 0, ...b, 0, ...b, h, ...a, 0, ...b, h, ...a, h)
  }
  return out
}

describe('MeshBvh.signedDistance', () => {
  const box = new MeshBvh(boxSoup(20, 10, 5))

  it('is negative inside, positive outside, the distance to the nearest face', () => {
    expect(box.signedDistance(10, 5, 2)).toBeCloseTo(-2)
    expect(box.signedDistance(10, 5, 7)).toBeCloseTo(2)
    expect(box.signedDistance(-1, 5, 2.5)).toBeCloseTo(1)
    expect(box.signedDistance(19.5, 5, 2.5)).toBeCloseTo(-0.5)
  })

  it('takes the sign right near convex edges and corners', () => {
    expect(box.signedDistance(21, 11, 2.5)).toBeCloseTo(Math.SQRT2)
    expect(box.signedDistance(21, 11, 6)).toBeCloseTo(Math.sqrt(3))
    expect(box.signedDistance(-1, -1, -1)).toBeCloseTo(Math.sqrt(3))
    expect(box.signedDistance(0.1, 0.1, 0.1)).toBeCloseTo(-0.1)
  })

  it('agrees with inside-the-box for points all around it', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 30 - 5
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = [rnd(), rnd() / 2, rnd() / 4]
      const inside = x > 0 && x < 20 && y > 0 && y < 10 && z > 0 && z < 5
      const d = box.signedDistance(x, y, z)
      if (Math.abs(d) > 1e-6) expect(d < 0).toBe(inside)
    }
  })

  it('takes the sign right at a concave edge', () => {
    const l = new MeshBvh(lPrism(5))
    // nearest the concave edge from inside: the edge's pseudo-normal points into the notch
    expect(l.signedDistance(9, 9, 2.5)).toBeCloseTo(-Math.SQRT2)
    expect(l.signedDistance(11, 11, 2.5)).toBeCloseTo(1)
    expect(l.signedDistance(15, 15, 2.5)).toBeCloseTo(5)
  })

  it('signedDistances: one per vertex', () => {
    expect([...signedDistances(box, [10, 5, 2, 10, 5, 6])].map((d) => +d.toFixed(5))).toEqual([
      -2, 1,
    ])
  })
})
