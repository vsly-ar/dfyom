// A deviation region's box in the part frame for the Plan viewport's marker (U4 follow-up): top,
// bottom and side faces through the stock face frames; the framed box's minimum size.
// Doc: docs/modes/deviation.md#region-marker-u4-follow-up
import { describe, expect, it } from 'vitest'
import { focusBox, FOCUS_MIN_MM, regionBox } from './deviation-region'

const stock = { length: 100, width: 60, thickness: 20 }

describe('regionBox', () => {
  it('top: u, v are X, Y; depths below the face go down from Z 0', () => {
    expect(
      regionBox(
        {
          face: 'stock.top',
          bounds: [
            [10, 20],
            [30, 25],
          ],
          depthRange: [2, 2.5],
        },
        stock,
      ),
    ).toEqual({ min: [10, 20, -2.5], max: [30, 25, -2] })
  })

  it('bottom: seen from below, u along X, v mirrored in Y; depths go up from the bottom', () => {
    const b = regionBox(
      {
        face: 'stock.bottom',
        bounds: [
          [10, 0],
          [30, 5],
        ],
        depthRange: [1, 3],
      },
      stock,
    )!
    expect(b.min[2]).toBeCloseTo(-19)
    expect(b.max[2]).toBeCloseTo(-17)
    expect(b.max[0] - b.min[0]).toBeCloseTo(20)
    expect(b.max[1] - b.min[1]).toBeCloseTo(5)
    // the box lies inside the stock in plan
    expect(b.min[1]).toBeGreaterThanOrEqual(0)
    expect(b.max[1]).toBeLessThanOrEqual(60)
  })

  it('a side face: the depth runs along its normal', () => {
    const b = regionBox(
      {
        face: 'stock.side[0]',
        bounds: [
          [0, 0],
          [10, 4],
        ],
        depthRange: [0.5, 1],
      },
      stock,
    )
    expect(b).toBeDefined()
    // side[0] (front) is −Y: depth 0.5–1 below it is Y 0.5–1
    expect(b!.min[1]).toBeCloseTo(0.5)
    expect(b!.max[1]).toBeCloseTo(1)
  })

  it('undefined for a face that is not a stock face', () => {
    expect(
      regionBox(
        {
          face: 'pocket1.floor',
          bounds: [
            [0, 0],
            [1, 1],
          ],
          depthRange: [0, 1],
        },
        stock,
      ),
    ).toBeUndefined()
  })
})

describe('focusBox', () => {
  it('grows a small box about its centre to the minimum, keeps a large side', () => {
    const f = focusBox({ min: [0, 0, -1], max: [0.5, 40, -0.5] })
    expect(f.max[0] - f.min[0]).toBeCloseTo(FOCUS_MIN_MM)
    expect((f.max[0] + f.min[0]) / 2).toBeCloseTo(0.25)
    expect(f.min[1]).toBe(0)
    expect(f.max[1]).toBe(40)
    expect(f.max[2] - f.min[2]).toBeCloseTo(FOCUS_MIN_MM)
  })
})
