// What the Reference panel draws (DF60 P1 follow-ups): the fitted loops as the Shape Editor's
// backdrop segments (raw segments kept for open meshes), and in the part frame for the viewport
// with the sharp inside corners, the hole rings (P3) and the hovered level's triangles.
// Spec: docs/modes/reference-tools.md#ui, docs/conventions/ui.md#reference-tools-df60
import { describe, expect, it } from 'vitest'
import type { FittedLoop } from '../../../../core/design/reference-section'
import { boxSoup } from '../../../../core/design/stl.testing'
import { fittedSegments, keepLoop, overlayView } from './reference-overlay'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A 20 × 10 rectangular hole (clockwise) with its four sharp corners. */
const HOLE: FittedLoop = {
  role: 'hole',
  open: false,
  loop: {
    elements: [
      { kind: 'line', a: [0, 0], b: [0, 10] },
      { kind: 'line', a: [0, 10], b: [20, 10] },
      { kind: 'line', a: [20, 10], b: [20, 0] },
      { kind: 'line', a: [20, 0], b: [0, 0] },
    ],
  },
  area: 200,
  bounds: { min: [0, 0], max: [20, 10] },
  sharp: [
    [0, 0],
    [0, 10],
    [20, 10],
    [20, 0],
  ],
  maxDeviation: 0,
}
/** A circle Ø 4 at (50, 5) as two half arcs. */
const CIRCLE: FittedLoop = {
  role: 'outer',
  open: false,
  loop: {
    elements: [
      { kind: 'arc', a: [52, 5], b: [48, 5], centre: [50, 5], ccw: true },
      { kind: 'arc', a: [48, 5], b: [52, 5], centre: [50, 5], ccw: true },
    ],
  },
  circle: { centre: [50, 5], diameter: 4 },
  area: 4 * Math.PI,
  bounds: { min: [48, 3], max: [52, 7] },
  sharp: [],
  maxDeviation: 0,
}
const OPEN: FittedLoop = { ...HOLE, open: true, loop: { elements: [] }, sharp: [] }

describe('fittedSegments', () => {
  it('draws lines as one segment each and arcs as chords on the circle', () => {
    const s = fittedSegments([HOLE, CIRCLE])!
    // the rectangle's four sides first
    expect(Array.from(s.slice(0, 16))).toEqual([
      0, 0, 0, 10, 0, 10, 20, 10, 20, 10, 20, 0, 20, 0, 0, 0,
    ])
    const arc = s.slice(16)
    expect(arc.length / 4).toBeGreaterThan(16) // finely chorded
    for (let i = 0; i < arc.length; i += 2)
      expect(Math.hypot(arc[i]! - 50, arc[i + 1]! - 5)).toBeCloseTo(2, 2)
  })

  it('leaves an open section to the raw segments', () => {
    expect(fittedSegments([HOLE, OPEN])).toBeUndefined()
    expect(fittedSegments(undefined)).toBeUndefined()
  })

  it('keeps the loops of a filter', () => {
    expect([HOLE, CIRCLE, OPEN].filter((l) => keepLoop(l, 'holes'))).toEqual([HOLE])
    expect([HOLE, CIRCLE, OPEN].filter((l) => keepLoop(l, 'outer'))).toEqual([CIRCLE])
    expect([HOLE, CIRCLE, OPEN].filter((l) => keepLoop(l, 'all'))).toEqual([HOLE, CIRCLE])
  })
})

describe('overlayView', () => {
  const stock = { length: 100, width: 60, thickness: 20 }
  // a 20 × 10 × 5 box in the part frame, its top 2 mm under the stock top
  const box = Float32Array.from(boxSoup(20, 10, 5).map((x, i) => (i % 3 === 2 ? x - 7 : x)))
  const ghost = { positions: box, matrix: IDENTITY, faceMatrix: IDENTITY }

  it('puts the loops and the sharp corners at the section plane in the part frame', () => {
    const v = overlayView(
      { referenceId: 'r1', direction: '+z', depth: 4, loops: [HOLE], hover: null },
      stock,
      ghost,
    )
    // the top face's frame: u = x, v = y, w = z; the plane 4 mm below the top
    expect(Array.from(v.lines.slice(0, 6))).toEqual([0, 0, -4, 0, 10, -4])
    expect(v.lines.length).toBe(4 * 6)
    expect(v.corners).toEqual([
      [0, 0, -4],
      [0, 10, -4],
      [20, 10, -4],
      [20, 0, -4],
    ])
    expect(v.axes).toEqual({ u: [1, 0, 0], v: [0, 1, 0] })
    expect(v.highlight).toBeNull()
  })

  it('on the bottom face the plane is measured from the bottom', () => {
    const v = overlayView(
      { referenceId: 'r1', direction: '-z', depth: 1, loops: [HOLE], hover: null },
      stock,
      ghost,
    )
    for (let i = 2; i < v.lines.length; i += 3) expect(v.lines[i]).toBeCloseTo(-19, 9)
  })

  it('puts the hole rings at their mouths in the part frame (P3)', () => {
    const v = overlayView(
      {
        referenceId: 'r1',
        direction: '-z',
        depth: 0,
        loops: null,
        hover: null,
        holes: [{ center: [10, 5], diameter: 3, top: 2 }],
      },
      stock,
      ghost,
    )
    // the bottom face: u = x, v = −y, the mouth 2 mm above the bottom (z −20)
    expect(v.holes).toHaveLength(1)
    expect(v.holes![0]!.radius).toBe(1.5)
    const [x, y, z] = v.holes![0]!.at
    expect([x, y, z].map((c) => Math.round(c * 1e9) / 1e9)).toEqual([10, -5 + 60, -18])
  })

  it('highlights the hovered level’s triangles with the ghost’s matrix', () => {
    const v = overlayView(
      {
        referenceId: 'r1',
        direction: '+z',
        depth: 0,
        loops: null,
        hover: { depth: 2, facing: 'face' },
      },
      stock,
      { ...ghost, faceMatrix: IDENTITY },
    )
    expect(v.lines).toHaveLength(0)
    expect(v.highlight?.matrix).toBe(IDENTITY)
    expect(v.highlight?.positions.length).toBe(18) // the box top: two triangles
    for (let i = 2; i < 18; i += 3) expect(v.highlight!.positions[i]).toBe(-2)
    // nothing flat at that depth on the other side
    expect(
      overlayView(
        {
          referenceId: 'r1',
          direction: '+z',
          depth: 0,
          loops: null,
          hover: { depth: 2, facing: 'opposite' },
        },
        stock,
        ghost,
      ).highlight,
    ).toBeNull()
  })
})
