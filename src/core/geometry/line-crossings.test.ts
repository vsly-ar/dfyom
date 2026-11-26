// Crossings of a Line's grooves (engraved-patterns.md § DFM read-out): crossings and meetings
// count once per place; neighbours along one line, a loop's closing joint and a line running on
// do not count; an arc crossing a line counts each point (a ccw arc from (0, 0) to (10, 0) about
// (5, 0) passes below).
// Doc: docs/modes/engraved-patterns.md#implementation-e4
import { describe, expect, it } from 'vitest'
import { arc, line, type Element } from './2d/model'
import type { Vec2 } from './model'
import { lineCrossings } from './line-crossings'

const open = (...pts: Vec2[]) => ({
  elements: pts.slice(1).map((p, i): Element => line(pts[i]!, p)),
  closed: false,
})

describe('lineCrossings', () => {
  it('two diagonals cross once; a third line through the same place is still one place', () => {
    expect(lineCrossings([open([0, 0], [10, 10]), open([0, 10], [10, 0])])).toBe(1)
    expect(
      lineCrossings([open([0, 0], [10, 10]), open([0, 10], [10, 0]), open([5, 0], [5, 10])]),
    ).toBe(1)
  })

  it('a loop and a polyline count nothing at their own joints', () => {
    const square = {
      elements: [
        line([0, 0], [10, 0]),
        line([10, 0], [10, 10]),
        line([10, 10], [0, 10]),
        line([0, 10], [0, 0]),
      ],
      closed: true,
    }
    expect(lineCrossings([square, open([20, 0], [30, 5], [40, 0], [50, 5])])).toBe(0)
  })

  it('a line crossing itself counts; a T-junction counts as a meeting', () => {
    expect(lineCrossings([open([0, 0], [10, 10], [10, 0], [0, 10])])).toBe(1)
    expect(lineCrossings([open([0, 0], [10, 0]), open([5, 0], [5, 10])])).toBe(1)
  })

  it('an arc over a line crosses it twice; parallel lines never', () => {
    const half = { elements: [arc([0, 0], [10, 0], [5, 0], true)], closed: false }
    expect(lineCrossings([half, open([-1, -2], [11, -2])])).toBe(2)
    expect(lineCrossings([open([0, 0], [10, 0]), open([0, 1], [10, 1])])).toBe(0)
  })

  it('many crossing lines: a 20 × 20 grid has 400 crossings', () => {
    const lines = Array.from({ length: 20 }, (_, i) => [
      open([-1, i], [20, i]),
      open([i + 0.5, -1], [i + 0.5, 20]),
    ]).flat()
    expect(lineCrossings(lines)).toBe(400)
  })
})
