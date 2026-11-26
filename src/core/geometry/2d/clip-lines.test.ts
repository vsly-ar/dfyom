// Clipping lines at a region's boundary (engraved-patterns.md E4): an open path crossing a circle
// keeps its chord inside; a loop crossing a rectangle becomes one open run across its start; a
// line wholly inside or outside is not split; touching the boundary from inside keeps one piece;
// a region with a hole drops the piece in the hole.
// Spec: docs/modes/engraved-patterns.md#implementation-e4
import { describe, expect, it } from 'vitest'
import { ClipBoundary, clipLine, type ClipRun } from './clip-lines'
import { arc, elementLength, line, type Element, type Region } from './model'

const rect = (x0: number, y0: number, x1: number, y1: number): Element[] => {
  const c: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  return c.map((p, i) => line(p, c[(i + 1) % 4]!))
}
const circle = (r: number): Element[] => [
  arc([r, 0], [-r, 0], [0, 0], true),
  arc([-r, 0], [r, 0], [0, 0], true),
]
const region = (outer: Element[], holes: Element[][] = []): Region => ({
  pieces: [{ outer: { elements: outer }, holes: holes.map((h) => ({ elements: h })) }],
})
const runs = (c: ReturnType<typeof clipLine>): readonly ClipRun[] => {
  if (typeof c === 'string') throw new Error(c)
  return c
}
const len = (els: readonly Element[]) => els.reduce((a, e) => a + elementLength(e), 0)

describe('clipLine', () => {
  it('keeps the chord of an open path crossing a circle', () => {
    const b = new ClipBoundary(region(circle(10)))
    const r = runs(clipLine([line([-20, 6], [20, 6])], false, b))
    expect(r).toHaveLength(1)
    expect(len(r[0]!.elements)).toBeCloseTo(16, 9)
    expect(r[0]!.from).toBeCloseTo(12, 9)
    expect(r[0]!.to).toBeCloseTo(28, 9)
  })

  it('splits an arc at the boundary and keeps the inside pieces of a polyline', () => {
    const b = new ClipBoundary(region(rect(0, 0, 10, 10)))
    // a half circle of radius 6 about (5, 0): the part above y = 0 is inside
    const r = runs(clipLine([arc([11, 0], [-1, 0], [5, 0], true)], false, b))
    expect(r).toHaveLength(1)
    const zig = runs(
      clipLine([line([-5, 5], [5, 5]), line([5, 5], [5, 15]), line([5, 15], [5, 5.5])], false, b),
    )
    // in at x = 0, out at y = 10, in again at y = 10 down to 5.5
    expect(zig).toHaveLength(2)
    expect(len(zig[0]!.elements)).toBeCloseTo(10, 9)
    expect(len(zig[1]!.elements)).toBeCloseTo(4.5, 9)
  })

  it('a loop crossing the boundary becomes open runs; one across its start runs on', () => {
    const b = new ClipBoundary(region(rect(0, 0, 10, 10)))
    // a square loop from (8, 2) half outside on the right
    const loop = [
      line([8, 2], [12, 2]),
      line([12, 2], [12, 8]),
      line([12, 8], [8, 8]),
      line([8, 8], [8, 2]),
    ]
    const r = runs(clipLine(loop, true, b))
    expect(r).toHaveLength(1)
    expect(len(r[0]!.elements)).toBeCloseTo(2 + 6 + 2, 9)
    expect(r[0]!.elements[0]!.a).toEqual([10, 8])
  })

  it('wholly inside or outside: not split; touching from inside: one piece', () => {
    const b = new ClipBoundary(region(rect(0, 0, 10, 10)))
    expect(clipLine([line([1, 1], [9, 9])], false, b)).toBe('inside')
    expect(
      clipLine(
        circle(2).map((e) => e),
        true,
        new ClipBoundary(region(rect(5, 5, 9, 9))),
      ),
    ).toBe('outside')
    expect(clipLine([line([2, 5], [10, 5]), line([10, 5], [2, 6])], false, b)).toBe('inside')
    expect(clipLine(rect(2, 2, 8, 8), true, b)).toBe('inside')
  })

  it('drops the piece inside a hole', () => {
    const b = new ClipBoundary(region(rect(0, 0, 30, 10), [rect(10, 2, 20, 8).reverse()]))
    const r = runs(clipLine([line([-5, 5], [35, 5])], false, b))
    expect(r.map((x) => len(x.elements))).toEqual([10, 10].map((x) => expect.closeTo(x, 9)))
  })
})
