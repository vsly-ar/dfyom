// The flat view's placement map (task U2): shape frame → face frame by mirror, rotation and offset,
// its inverse, and placed arcs keeping their sense.
// Doc: docs/conventions/ui.md#shape-editor
import { describe, expect, it } from 'vitest'
import type { Element } from '../../../core/geometry/2d/model'
import {
  placedBounds,
  placeElements,
  placePoint,
  unplacePoint,
  type ShapePlacement,
} from './flat-view'

const turn = (deg: number, mirror: boolean, offset: [number, number]): ShapePlacement => ({
  cos: Math.cos((deg * Math.PI) / 180),
  sin: Math.sin((deg * Math.PI) / 180),
  mirror,
  offset,
})

describe('flat view placement', () => {
  it('rotates counter-clockwise, then offsets', () => {
    const p = placePoint(turn(90, false, [10, 0]), [1, 0])
    expect(p[0]).toBeCloseTo(10)
    expect(p[1]).toBeCloseTo(1)
  })

  it('mirrors x before rotating', () => {
    const p = placePoint(turn(0, true, [0, 0]), [2, 3])
    expect(p).toEqual([-2, 3])
  })

  it('round-trips through the inverse', () => {
    const t = turn(37, true, [12, -4])
    const q = unplacePoint(t, placePoint(t, [5, 7]))
    expect(q[0]).toBeCloseTo(5)
    expect(q[1]).toBeCloseTo(7)
  })

  it('flips an arc’s sense under a mirror only', () => {
    const arc: Element = { kind: 'arc', a: [1, 0], b: [0, 1], centre: [0, 0], ccw: true }
    expect(placeElements(turn(45, false, [0, 0]), [arc])[0]).toMatchObject({ ccw: true })
    expect(placeElements(turn(45, true, [0, 0]), [arc])[0]).toMatchObject({ ccw: false })
  })

  it('bounds the placed elements', () => {
    const line: Element = { kind: 'line', a: [0, 0], b: [10, 0] }
    const b = placedBounds(turn(90, false, [5, 5]), [line])!
    expect(b.min[0]).toBeCloseTo(5)
    expect(b.max[1]).toBeCloseTo(15)
  })
})
