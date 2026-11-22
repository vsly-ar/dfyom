// The v0.4 exit part (task X0): the lid's four countersunk screws line up with the v0.3 base's four
// blind holes as the v0.3 X1 flow drills them. Here, not in core, because the base's holes live in
// the v0.3 fixture. The rest of the lid's layout: src/core/design/enclosure-lid.test.ts.
// Docs: docs/plans/v0.4.md#exit-criteria
import { describe, expect, it } from 'vitest'
import {
  EXPECTED,
  gridInstances,
  LID_CENTRE,
  LID_STOCK,
  onBoard,
  SCREWS,
} from '../../core/design/enclosure-lid.testing'
import { BASE_HOLE_CENTRES, STOCK_V03 } from './exit-criteria.v03.fixture'

/** A base hole in the part's top-view frame (x, y): the bottom face's v runs −Y from the back. */
const basePartXY = ([u, v]: readonly [string, string]): [number, number] => [
  Number(u),
  STOCK_V03.width - Number(v),
]

const BASE_CENTRE = [STOCK_V03.length / 2, STOCK_V03.width / 2] as const

const sorted = (ps: readonly (readonly [number, number])[]) =>
  [...ps].sort((p, q) => p[0] - q[0] || p[1] - q[1])

describe('v0.4 exit part: the lid over the v0.3 base (X0)', () => {
  it('has the length of the base board, 15 mm more width (D40), the outline centred on both', () => {
    expect([LID_STOCK.length, LID_STOCK.width]).toEqual([STOCK_V03.length, STOCK_V03.width + 15])
    expect(LID_CENTRE).toEqual([LID_STOCK.length / 2, LID_STOCK.width / 2])
  })

  it('puts the four screws over the four base holes within 0.01 mm', () => {
    const base = sorted(BASE_HOLE_CENTRES.map(basePartXY))
    // both boards carry the outline on their centre: compare in the base board's frame
    const shift = (p: readonly [number, number]): [number, number] => {
      const q = onBoard(p)
      return [q[0] - LID_CENTRE[0] + BASE_CENTRE[0], q[1] - LID_CENTRE[1] + BASE_CENTRE[1]]
    }
    const lid = sorted(gridInstances(SCREWS.source, SCREWS.grid).map((i) => shift(i.at)))
    const expected = sorted(EXPECTED.screws.map(shift))
    expect(base).toHaveLength(4)
    for (let k = 0; k < 4; k++)
      for (const ps of [lid, expected]) {
        expect(Math.abs(ps[k]![0] - base[k]![0])).toBeLessThanOrEqual(0.01)
        expect(Math.abs(ps[k]![1] - base[k]![1])).toBeLessThanOrEqual(0.01)
      }
  })
})
