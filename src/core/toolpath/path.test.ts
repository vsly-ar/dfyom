import { describe, expect, it } from 'vitest'
import type { Contour } from '../geometry/model'
import { offsetRing, segLength, segPoint, segsLength, walkRing, type Seg } from './path'

const rect: Contour = { kind: 'rectangle', length: 20, width: 10, cornerRadius: 2 }
const perimeter = 2 * (16 + 6) + 2 * Math.PI * 2

describe('offsetRing', () => {
  it('starts at the shape point of the given arc length and closes', () => {
    for (const cw of [false, true]) {
      const ring = offsetRing(rect, -1, [5, 5], 8, cw) // middle of wall[0]
      expect(segPoint(ring[0]!, 0)).toEqual([5, -1])
      const end = segPoint(ring.at(-1)!, 1)
      expect(end[0]).toBeCloseTo(5, 12)
      expect(end[1]).toBeCloseTo(-1, 12)
      expect(segsLength(ring)).toBeCloseTo(2 * (16 + 6) + 2 * Math.PI * 3, 9)
      // counter-clockwise rings head +X along the front wall, clockwise ones −X
      const first = ring[0]!
      expect(first.kind === 'line' && Math.sign(first.to[0] - first.from[0])).toBe(cw ? -1 : 1)
    }
  })

  it('drops zero-length pieces: a sharp ring has four lines', () => {
    const ring = offsetRing(rect, 3, [0, 0], 8, false)
    expect(ring.map((s) => s.kind)).toEqual(['line', 'line', 'line', 'line', 'line'])
    expect(offsetRing({ kind: 'circle', radius: 3 }, 3, [0, 0], 0, false)).toEqual([])
  })
})

describe('walkRing', () => {
  const ring = offsetRing(rect, 0, [0, 0], 8, false)
  const end = (segs: readonly Seg[]) => segPoint(segs.at(-1)!, 1)

  for (const length of [5, 30, perimeter + 7, 2.5 * perimeter])
    it(`walks ${length.toFixed(1)} mm and laps once from there`, () => {
      const { walked, lap } = walkRing(ring, length)
      expect(segsLength(walked)).toBeCloseTo(length, 9)
      expect(segsLength(lap)).toBeCloseTo(perimeter, 9)
      expect(segPoint(lap[0]!, 0)[0]).toBeCloseTo(end(walked)[0], 9)
      expect(segPoint(lap[0]!, 0)[1]).toBeCloseTo(end(walked)[1], 9)
      expect(end(lap)[0]).toBeCloseTo(end(walked)[0], 9)
      expect(lap.every((s) => segLength(s) > 0)).toBe(true)
    })
})
