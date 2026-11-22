// Snap engine (task U3): priority, tolerance in screen pixels, grid in inch, shape and stock targets.
// Doc: docs/conventions/ui.md#snap-and-measure
import { describe, expect, it } from 'vitest'
import type { Element } from '../../../core/geometry/2d/model'
import {
  isExactSnap,
  shapePoints,
  snapGridMm,
  snapPoint,
  stockTargets,
  type SnapTargets,
} from './snap'

const none: SnapTargets = { points: [], edges: [] }

describe('snapPoint', () => {
  it('takes a target within the tolerance in pixels, whatever the zoom', () => {
    const t: SnapTargets = { ...none, points: [{ kind: 'end', at: [10, 0] }] }
    // 0.5 mm off: 5 px at 10 px/mm snaps, 50 px at 100 px/mm does not
    expect(snapPoint([10.5, 0], t, { pxPerUnit: 10 })).toEqual({ at: [10, 0], kind: 'end' })
    expect(snapPoint([10.5, 0], t, { pxPerUnit: 100 })).toBeNull()
    expect(snapPoint([10.5, 0], t, { pxPerUnit: 100, tolerancePx: 60 })?.kind).toBe('end')
  })

  it('prefers points to edges, edges to the grid, then the nearest', () => {
    const { points, edges } = stockTargets(100, 50)
    const t: SnapTargets = { points, edges, grid: 1 }
    // on the bottom edge 0.6 mm from the corner: the corner wins over the edge under the pointer
    expect(snapPoint([0.6, 0], t, { pxPerUnit: 10 })).toEqual({ at: [0, 0], kind: 'corner' })
    // far from corners, near the edge: the edge's nearest point beats a grid point
    expect(snapPoint([40.3, 0.2], t, { pxPerUnit: 10 })).toEqual({ at: [40.3, 0], kind: 'edge' })
    // in the middle of the face: the grid
    expect(snapPoint([40.3, 20.2], t, { pxPerUnit: 10 })).toEqual({ at: [40, 20], kind: 'grid' })
    // two points of the same rank: the nearer
    const two: SnapTargets = {
      ...none,
      points: [
        { kind: 'midpoint', at: [0, 0] },
        { kind: 'midpoint', at: [1, 0] },
      ],
    }
    expect(snapPoint([0.7, 0], two, { pxPerUnit: 10 })?.at).toEqual([1, 0])
    // a centre outranks a midpoint even when farther
    const mixed: SnapTargets = {
      ...none,
      points: [
        { kind: 'midpoint', at: [0, 0] },
        { kind: 'centre', at: [0.7, 0] },
      ],
    }
    expect(snapPoint([0.1, 0], mixed, { pxPerUnit: 10 })?.kind).toBe('centre')
  })

  it('snaps to grid points of an inch grid (1/16 in)', () => {
    const g = snapGridMm({ mm: 1, inch: 1 / 16 }, 'inch')
    expect(g).toBeCloseTo(1.5875, 12)
    const s = snapPoint([3.3, -1.5], { ...none, grid: g }, { pxPerUnit: 20 })
    expect(s?.kind).toBe('grid')
    expect(s?.at[0]).toBeCloseTo(2 * 1.5875, 12)
    expect(s?.at[1]).toBeCloseTo(-1.5875, 12)
    // exactly 1/8 in and −1/16 in: written back in inch, these are 0.125 and −0.0625
    expect(+(s!.at[0] / 25.4).toFixed(9)).toBe(0.125)
    expect(snapGridMm({ mm: 0.5, inch: 1 / 16 }, 'mm')).toBe(0.5)
  })

  it('snaps to the nearest point of the reference section', () => {
    const reference = Float32Array.from([0, 10, 20, 10, 20, 10, 20, 30])
    const s = snapPoint([19.8, 22], { ...none, reference }, { pxPerUnit: 10 })
    expect(s?.kind).toBe('reference')
    expect(s?.at[0]).toBeCloseTo(20, 5)
    expect(s?.at[1]).toBeCloseTo(22, 5)
    expect(isExactSnap('reference')).toBe(false)
    expect(isExactSnap('grid')).toBe(true)
  })

  it('skips the excluded point (the dragged handle where it started)', () => {
    const t: SnapTargets = {
      ...none,
      points: [
        { kind: 'end', at: [0, 0] },
        { kind: 'end', at: [0.5, 0] },
      ],
    }
    expect(snapPoint([0.1, 0], t, { pxPerUnit: 10, exclude: [0, 0] })?.at).toEqual([0.5, 0])
  })
})

describe('shapePoints', () => {
  it('lists ends, midpoints and arc centres once each', () => {
    const elements: Element[] = [
      { kind: 'line', a: [0, 0], b: [10, 0] },
      { kind: 'arc', a: [10, 0], b: [10, 10], centre: [10, 5], ccw: true },
    ]
    const pts = shapePoints([elements])
    const of = (k: string) =>
      pts.filter((p) => p.kind === k).map((p) => p.at.map((v) => +v.toFixed(6)))
    expect(of('end')).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ])
    expect(of('centre')).toEqual([[10, 5]])
    // the line's middle and the arc's: a counter-clockwise half circle from (10,0) to (10,10)
    // bulges to +x
    expect(of('midpoint')).toEqual([
      [5, 0],
      [15, 5],
    ])
  })
})
