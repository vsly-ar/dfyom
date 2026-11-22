// Tabs along a profile's loop (task U2): distance along the loop, a dragged tab kept off its
// neighbours, the next tab's place, and a marker's quad across the slot.
// Doc: docs/conventions/ui.md#tab-markers
import { describe, expect, it } from 'vitest'
import type { Loop } from '../../../../core/geometry/2d/model'
import { chainLength } from '../../../../core/geometry/2d/measure'
import { clampTab, distanceAlong, newTabPosition, type ProfileTabs } from './tabs-model'
import { slotAcross, tabQuad } from './useTabMarkers'

// a 40 × 20 rectangle, counter-clockwise from the origin (length 120)
const square: Loop = {
  elements: [
    { kind: 'line', a: [0, 0], b: [40, 0] },
    { kind: 'line', a: [40, 0], b: [40, 20] },
    { kind: 'line', a: [40, 20], b: [0, 20] },
    { kind: 'line', a: [0, 20], b: [0, 0] },
  ],
}

const tabs = (over: Partial<ProfileTabs> = {}): ProfileTabs => ({
  chain: square,
  closed: true,
  length: chainLength(square),
  side: 'outside',
  slotWidth: 6,
  width: 8,
  centres: [20, 80],
  entered: false,
  allowed: true,
  ...over,
})

describe('tabs model', () => {
  it('measures the distance along the loop of the closest point', () => {
    expect(distanceAlong(square, [10, -3])).toBeCloseTo(10)
    expect(distanceAlong(square, [43, 10])).toBeCloseTo(50)
    expect(distanceAlong(square, [-2, 5])).toBeCloseTo(115)
  })

  it('moves a tab freely between its neighbours', () => {
    expect(clampTab([20, 80], 0, 40, 8, 120)).toBeCloseTo(40)
    // around the start point
    expect(clampTab([20, 80], 0, 110, 8, 120)).toBeCloseTo(110)
  })

  it('stops a tab at its neighbour’s edge', () => {
    expect(clampTab([20, 80], 0, 79, 8, 120)).toBeCloseTo(72 - 0.02)
    expect(clampTab([20, 80], 1, 21, 8, 120)).toBeCloseTo(28 + 0.02)
  })

  it('puts a new tab in the middle of the largest gap', () => {
    expect(newTabPosition([], 120)).toBe(60)
    expect(newTabPosition([20, 40], 120)).toBeCloseTo(90)
  })

  it('spans the slot on the cut side', () => {
    expect(slotAcross('outside', 6)).toEqual([0, 6])
    expect(slotAcross('inside', 6)).toEqual([-6, 0])
    expect(slotAcross('on', 6)).toEqual([-3, 3])
  })

  it('draws a tab as a bar across the slot, as long as the tab is wide', () => {
    const q = tabQuad(tabs(), 20)!
    // on the bottom edge: along x from 16 to 24, outward is −y (outside the loop)
    const xs = q.map((p) => p[0])
    const ys = q.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(16)
    expect(Math.max(...xs)).toBeCloseTo(24)
    expect(Math.min(...ys)).toBeLessThan(-6)
    expect(Math.max(...ys)).toBeGreaterThan(0)
  })
})
