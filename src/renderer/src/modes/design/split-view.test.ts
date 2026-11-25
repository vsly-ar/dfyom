// The exploded split preview's view model (split parts 4a polish): grid cells pulled along the cut
// normals, the handles in the gaps, snapping and the findings of a cut.
// Spec: docs/conventions/ui.md#split-part-split-parts-4a
import { describe, expect, it } from 'vitest'
import { easeEmphasized } from '../../viewport/SplitLayer'
import {
  cutFindings,
  cutShift,
  explodeGap,
  explodedCells,
  snapCut,
  type SplitCut,
} from './split-view'

const S = { L: 250, W: 200, T: 80 }
const line = (axis: 'x' | 'y', at: number, index = 0): SplitCut => ({
  kind: 'line',
  index,
  axis,
  at,
})
const level = (at: number, index = 0): SplitCut => ({ kind: 'level', index, axis: 'z', at })

describe('exploded split preview', () => {
  it('one level: two cells pulled apart along Z, the handle in the middle of the gap', () => {
    const cuts = [level(-40)]
    const cells = explodedCells(cuts, S, 10)
    expect(cells.map((c) => [c.min, c.max, c.offset])).toEqual([
      [
        [0, 0, -80],
        [250, 200, -40],
        [0, 0, -5],
      ],
      [
        [0, 0, -40],
        [250, 200, 0],
        [0, 0, 5],
      ],
    ])
    expect(cutShift(cuts, cuts[0]!, S, 10)).toBe(0)
  })

  it('a level and two lines: eight cells, each pulled away from the middle on every axis', () => {
    const cuts = [line('x', 125), line('y', 100, 1), level(-40)]
    const cells = explodedCells(cuts, S, 10)
    expect(cells).toHaveLength(8)
    for (const c of cells)
      for (const i of [0, 1, 2]) {
        const mid = (c.min[i]! + c.max[i]!) / 2
        const centre = i === 0 ? 125 : i === 1 ? 100 : -40
        expect(Math.sign(c.offset[i]!)).toBe(Math.sign(mid - centre))
        expect(Math.abs(c.offset[i]!)).toBe(5)
      }
  })

  it('two lines on one axis: the handles sit in their own gaps', () => {
    const cuts = [line('x', 200, 0), line('x', 50, 1)]
    const offsets = explodedCells(cuts, S, 10).map((c) => c.offset[0])
    expect(offsets).toEqual([-10, 0, 10])
    expect(cutShift(cuts, cuts[1]!, S, 10)).toBe(-5)
    expect(cutShift(cuts, cuts[0]!, S, 10)).toBe(5)
  })

  it('a cut on or past the stock edge cuts nothing', () => {
    expect(explodedCells([line('x', 0), line('y', 250)], S, 10)).toHaveLength(1)
  })

  it('the gap is a few % of the part, 4–30 mm', () => {
    expect(explodeGap(S)).toBe(15)
    expect(explodeGap({ L: 20, W: 20, T: 5 })).toBe(4)
    expect(explodeGap({ L: 2000, W: 100, T: 5 })).toBe(30)
  })

  it('snaps to whole millimetres and the part middle, inside the stock; free with snap off', () => {
    expect(snapCut(87.4, 'y', S, true, 3)).toBe(87)
    expect(snapCut(98.2, 'y', S, true, 3)).toBe(100)
    expect(snapCut(-40.8, 'z', S, true, 1)).toBe(-40)
    expect(snapCut(-44.6, 'z', S, true, 1)).toBe(-45)
    expect(snapCut(98.234, 'y', S, false, 3)).toBe(98.23)
    expect(snapCut(-5, 'x', S, true, 3)).toBe(1)
    expect(snapCut(300, 'x', S, true, 3)).toBe(249)
    expect(snapCut(5, 'z', S, true, 1)).toBe(-1)
  })

  it("a cut's findings: its glue face and the features near it", () => {
    const w = (params: Record<string, unknown>) => ({ code: 'design.split', params })
    const ws = [
      w({ rule: 'thinJoint', axis: 'x', at: 125 }),
      w({ rule: 'thinJoint', level: -40 }),
      w({ rule: 'featureNear', nearX: [125], nearY: [], nearZ: [-40] }),
      w({ rule: 'noStock', piece: 1 }),
      { code: 'tool.tooLarge', params: { at: 125 } },
    ]
    expect(cutFindings(ws, line('x', 125))).toEqual([ws[0], ws[2]])
    expect(cutFindings(ws, line('y', 125))).toEqual([])
    expect(cutFindings(ws, level(-40))).toEqual([ws[1], ws[2]])
  })

  it('eases like --ease-emphasized: 0 and 1 at the ends, most of the way early', () => {
    expect(easeEmphasized(0)).toBeCloseTo(0, 5)
    expect(easeEmphasized(1)).toBeCloseTo(1, 5)
    expect(easeEmphasized(0.3)).toBeGreaterThan(0.6)
  })
})
