// The compare overlay's colours (DF60 P5): neutral within the threshold, the kind's hue from NEAR
// to full at the scale, per vertex on the render geometry, fading from the surface colours; and
// the state helpers (region frame, worst region, the view only for the mesh it measured).
import { describe, expect, it } from 'vitest'
import {
  deviationView,
  regionFrame,
  worstRegion,
  type CompareRegion,
} from '../modes/design/reference-compare-state'
import { toLinear, type Rgb } from './colours'
import { deviationColour, deviationColours, deviationScale, NEAR } from './deviation'

const palette = {
  part: [1, 1, 1] as Rgb,
  danger: [1, 0, 0] as Rgb,
  info: [0, 0, 1] as Rgb,
}
const scale = { missing: 1, extra: 2 }

describe('deviation colours', () => {
  it('keeps the part colour within ± threshold', () => {
    expect(deviationColour(0, 0.1, scale, palette)).toEqual(palette.part)
    expect(deviationColour(-0.1, 0.1, scale, palette)).toEqual(palette.part)
    expect(deviationColour(0.1, 0.1, scale, palette)).toEqual(palette.part)
    expect(deviationColour(Number.NaN, 0.1, scale, palette)).toEqual(palette.part)
  })

  it('missing is red, extra blue, from NEAR at the threshold to full at the scale', () => {
    const justMissing = deviationColour(-0.1001, 0.1, scale, palette)
    expect(justMissing[0]).toBe(1)
    expect(justMissing[1]).toBeCloseTo(1 - NEAR, 3)
    expect(deviationColour(-1, 0.1, scale, palette)).toEqual([1, 0, 0])
    expect(deviationColour(-5, 0.1, scale, palette)).toEqual([1, 0, 0])
    expect(deviationColour(2, 0.1, scale, palette)).toEqual([0, 0, 1])
    const half = deviationColour(1.05, 0.1, scale, palette)
    expect(half[0]).toBeCloseTo(1 - (NEAR + (1 - NEAR) * 0.5), 5)
    expect(half[2]).toBe(1)
  })

  it('scales to the largest deviation of each kind, at least twice the threshold', () => {
    expect(deviationScale(new Float32Array([-0.5, 0.01, 3]), 0.1)).toEqual({
      missing: 0.5,
      extra: 3,
    })
    expect(deviationScale(new Float32Array([0, 0.05]), 0.1)).toEqual({ missing: 0.2, extra: 0.2 })
  })

  it('colours each corner of the render geometry by its vertex, faded from the base', () => {
    const mesh = {
      positions: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
      triangleSurface: new Uint32Array([0, 0]),
      surfaces: ['stock.top'],
    }
    const view = { distances: new Float32Array([0, -1, 2, 0]), threshold: 0.1, scale }
    const base = new Float32Array(18).fill(0.5)
    const full = deviationColours(mesh, view, palette, 1, base)
    expect([...full.subarray(0, 3)]).toEqual([1, 1, 1]) // vertex 0: neutral (linear white)
    expect([...full.subarray(3, 6)]).toEqual([...toLinear([1, 0, 0])])
    expect([...full.subarray(6, 9)]).toEqual([...toLinear([0, 0, 1])])
    expect([...full.subarray(9, 12)]).toEqual([...toLinear([0, 0, 1])]) // vertex 2 again
    const none = deviationColours(mesh, view, palette, 0, base)
    expect([...none]).toEqual([...base])
  })
})

describe('compare state', () => {
  const region = (kind: 'missing' | 'extra', maxDev: number): CompareRegion => ({
    kind,
    volume: 1,
    maxDev,
    at: [0, 0, 0],
    bounds: [
      [0, 0, -1],
      [30, 2, 0],
    ],
    surfaces: [],
    operationIds: [],
  })

  it('frames a region at least 10 mm on each axis about its centre', () => {
    expect(regionFrame(region('missing', 1))).toEqual({ min: [0, -4, -5.5], max: [30, 6, 4.5] })
  })

  it('the worst region is the largest deviation, not the first', () => {
    expect(worstRegion({ regions: [region('extra', 1), region('missing', 3)] })?.kind).toBe(
      'missing',
    )
    expect(worstRegion({ regions: [] })).toBeUndefined()
  })

  it('draws the view only on the mesh it measured', () => {
    const positions = new Float32Array(9)
    const state = {
      busy: false,
      view: { positions, distances: new Float32Array([0, -0.5, 0]), missing: null },
    }
    expect(deviationView(state, 0.1, positions, null)).toMatchObject({
      threshold: 0.1,
      scale: { missing: 0.5, extra: 0.2 },
      region: null,
    })
    expect(deviationView(state, 0.1, new Float32Array(9), null)).toBeNull()
    expect(deviationView({ busy: false }, 0.1, positions, null)).toBeNull()
  })
})
