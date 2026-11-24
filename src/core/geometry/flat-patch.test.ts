// Flat patches and touch-off spots (hardening DF69).
// Spec: docs/modes/z-reference.md#touch-off-spot, docs/modes/z-reference.md#implementation-notes-df69
import { describe, expect, it } from 'vitest'
import { regionArea } from './2d/model'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { spotFits, touchOffSpot } from './flat-patch'
import { rectangle } from './through-depth'

const port = nodeRegion2d()

describe('touchOffSpot', () => {
  it('takes the middle of a rectangle on the grid, its distance to the boundary as radius', () => {
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1)!
    expect(s.at).toEqual([50, 30])
    expect(s.radius).toBeCloseTo(30, 6)
  })

  it('rounds to the grid (inch machines: 1.27 mm)', () => {
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1.27)!
    expect(s.at[0] / 1.27).toBeCloseTo(Math.round(s.at[0] / 1.27), 9)
    expect(Math.abs(s.at[1] - 30)).toBeLessThanOrEqual(1.27 / 2)
  })

  it('maps through a rotated frame: the spot is in the WCS', () => {
    // a setup turned 90°: WCS (x, y) = face (y, −x) shifted by the face length
    const frame = {
      toWcs: ([x, y]: readonly [number, number]) => [y, 100 - x] as [number, number],
      fromWcs: ([x, y]: readonly [number, number]) => [100 - y, x] as [number, number],
    }
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1, frame)!
    expect(s.at).toEqual([30, 50])
  })

  it('finds nothing when the clearance swallows the patch', () => {
    expect(touchOffSpot(port, rectangle(6, 6), 4, 1)).toBeUndefined()
    expect(regionArea(rectangle(6, 6))).toBe(36)
  })
})

describe('spotFits', () => {
  it('accepts points of the eroded patch only', () => {
    expect(spotFits(port, rectangle(100, 60), 4, [10, 10])).toBe(true)
    expect(spotFits(port, rectangle(100, 60), 4, [2, 10])).toBe(false)
  })
})
