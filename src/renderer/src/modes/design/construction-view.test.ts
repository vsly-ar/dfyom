// Construction surfaces in the 3D view (DF118 V3): patch loops in the face frame → part-frame
// outline, fill and glyph. Doc: docs/modes/construction-surfaces.md#ui
import { describe, expect, it } from 'vitest'
import type { ConstructionSurface, Vec2 } from '../../../../core/geometry/model'
import { constructionOverlays, patchTriangles } from './construction-view'

const STOCK = { length: 80, width: 40.35, thickness: 10.11 }
const square = (u0: number, v0: number, s: number, reverse = false): Vec2[] => {
  const l: Vec2[] = [
    [u0, v0],
    [u0 + s, v0],
    [u0 + s, v0 + s],
    [u0, v0 + s],
  ]
  return reverse ? l.reverse() : l
}
const area = (tris: readonly Vec2[]) => {
  let a = 0
  for (let i = 0; i < tris.length; i += 3) {
    const [p, q, r] = [tris[i]!, tris[i + 1]!, tris[i + 2]!]
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2
  }
  return a
}

const floor = (loops: Vec2[][]): ConstructionSurface => ({
  surface: 'pocket1.floor',
  consumedBy: ['pocket2', 'chamfer1'],
  referencedBy: [{ operationId: 'pocket2', param: 'on' }],
  patch: { direction: '-z', z: -2.3, loops },
})

describe('construction overlays (DF118 V3)', () => {
  it('fills a patch, a loop wound the other way inside an outline being a hole', () => {
    expect(area(patchTriangles([square(0, 0, 10)]))).toBeCloseTo(100, 9)
    expect(area(patchTriangles([square(0, 0, 10), square(4, 4, 2, true)]))).toBeCloseTo(96, 9)
    // two separate outlines
    expect(area(patchTriangles([square(0, 0, 2), square(5, 5, 3)]))).toBeCloseTo(13, 9)
  })

  it('places a bottom-face patch at its level in the part frame, glyph at its centroid', () => {
    const [o] = constructionOverlays(
      [floor([square(25, 10, 10)])],
      STOCK,
      new Set(['pocket1.floor']),
      true,
    )
    expect(o).toMatchObject({ surface: 'pocket1.floor', pickable: true, normal: [0, 0, -1] })
    // on stock.bottom X stays X and v points to the front (Y = W − v); 2.3 mm above the bottom
    const z = -STOCK.thickness + 2.3
    expect(o!.at[0]).toBeCloseTo(30, 9)
    expect(o!.at[1]).toBeCloseTo(STOCK.width - 15, 9)
    expect(o!.at[2]).toBeCloseTo(z, 9)
    for (let i = 2; i < o!.fill.length; i += 3) expect(o!.fill[i]).toBeCloseTo(z, 5)
    expect(o!.loops[0]).toHaveLength(4)
  })

  it('keeps the glyph on the patch when its centroid falls in a hole, and shows only the asked', () => {
    const ring = floor([square(0, 0, 10), square(2, 2, 6, true)])
    const [o] = constructionOverlays([ring], STOCK, new Set(['pocket1.floor']), false)
    const u = o!.at[0]
    const v = STOCK.width - o!.at[1]
    expect(u > 2 && u < 8 && v > 2 && v < 8).toBe(false)
    expect(constructionOverlays([ring], STOCK, new Set(), false)).toEqual([])
  })
})
