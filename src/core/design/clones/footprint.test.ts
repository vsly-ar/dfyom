// Clones source footprints (hardening B3): exact rounded boxes for circles and rectangles,
// regions through the 2D port for general shapes, bounds without one.
// Spec: docs/modes/features.md#clones (Outside the stock, Overlaps)
import { describe, expect, it } from 'vitest'
import { line } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import type { OperationGeometry } from '../../geometry/model'
import { footprintBounds, footprintsOverlap, sourceFootprint } from './footprint'

const drill = (u: number, v: number, d: number): OperationGeometry => ({
  kind: 'drilling',
  id: 'drill1',
  onZ: 0,
  center: [u, v],
  diameter: d,
  bottom: { kind: 'through' },
})
const rectPocket = (u: number, v: number, l: number, w: number, r = 0): OperationGeometry => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: { center: [u, v], contour: { kind: 'rectangle', length: l, width: w, cornerRadius: r } },
  depth: 2,
  floorRadius: 0,
})
/** A 20 × 2 strip turned 45°, as a placed region around its centre. */
const strip = (): OperationGeometry => {
  const h = 10 / Math.SQRT2
  const t = 1 / Math.SQRT2
  const p = (x: number, y: number) => [x, y] as const
  const pts = [p(-h + t, -h - t), p(h + t, h - t), p(h - t, h + t), p(-h - t, -h + t)]
  return {
    kind: 'pocket',
    id: 'pocket1',
    onZ: 0,
    shape: {
      center: [50, 30],
      contour: {
        kind: 'region',
        region: {
          pieces: [
            { outer: { elements: pts.map((a, i) => line(a, pts[(i + 1) % 4]!)) }, holes: [] },
          ],
        },
      },
    },
    depth: 2,
    floorRadius: 0,
  }
}

describe('footprints', () => {
  it('two circles overlap by distance, not by their boxes', () => {
    const f = sourceFootprint([drill(20, 20, 10)], undefined)
    // boxes overlap at (7.2, 7.2), the circles (10.18 apart) do not
    expect(footprintsOverlap(f, { u: 7.2, v: 7.2 }, undefined)).toBe(false)
    expect(footprintsOverlap(f, { u: 7, v: 7 }, undefined)).toBe(true)
    // touching is not overlapping
    expect(footprintsOverlap(f, { u: 10, v: 0 }, undefined)).toBe(false)
  })

  it('rounded rectangles: the corner radius decides at the diagonal', () => {
    const f = sourceFootprint([rectPocket(20, 20, 10, 10, 4)], undefined)
    expect(footprintsOverlap(f, { u: 9.5, v: 9.5 }, undefined)).toBe(false)
    const sharp = sourceFootprint([rectPocket(20, 20, 10, 10)], undefined)
    expect(footprintsOverlap(sharp, { u: 9.5, v: 9.5 }, undefined)).toBe(true)
    expect(footprintsOverlap(sharp, { u: 10, v: 3 }, undefined)).toBe(false)
  })

  it('a source of several operations overlaps when any pair does', () => {
    const f = sourceFootprint([rectPocket(20, 20, 4, 4), drill(30, 20, 2)], undefined)
    expect(footprintBounds(f)).toEqual({ min: [18, 18], max: [31, 22] })
    // the drilling of one instance lands on the pocket of the next
    expect(footprintsOverlap(f, { u: -10, v: 0 }, undefined)).toBe(true)
    expect(footprintsOverlap(f, { u: -13, v: 0 }, undefined)).toBe(false)
  })

  it('a turned strip: the 2D port intersects the regions; without it the bounds decide', () => {
    const region2d = nodeRegion2d()
    const f = sourceFootprint([strip()], region2d)
    // across the strip (4.24 mm apart, 2 wide): the boxes overlap, the strips do not
    expect(footprintsOverlap(f, { u: -3, v: 3 }, region2d)).toBe(false)
    expect(footprintsOverlap(f, { u: -3, v: 3 }, undefined)).toBe(true)
    // along it they do
    expect(footprintsOverlap(f, { u: 3, v: 3 }, region2d)).toBe(true)
  })

  it('profiles grow by their slot; facings have none', () => {
    const shape = { center: [20, 20] as const, contour: { kind: 'circle' as const, radius: 5 } }
    const profile = (side: 'inside' | 'outside' | 'on'): OperationGeometry => ({
      kind: 'profile',
      id: 'profile1',
      shape,
      side,
      slotWidth: 4,
      tabs: { count: 0, width: 0, thickness: 0 },
    })
    expect(footprintBounds(sourceFootprint([profile('inside')], undefined))!.max[0]).toBe(25)
    expect(footprintBounds(sourceFootprint([profile('on')], undefined))!.max[0]).toBe(27)
    expect(footprintBounds(sourceFootprint([profile('outside')], undefined))!.max[0]).toBe(29)
    expect(sourceFootprint([{ kind: 'facing', id: 'facing1', depth: 1 }], undefined)).toEqual([])
  })
})
