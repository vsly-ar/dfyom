// dfm.lineMerge's measurement (engraved-patterns.md § DFM, E4): two parallel grooves 1 mm deep
// with a 60° V-bit (1.155 mm wide) leave a 0.245 mm wall 1.4 mm apart (found) and a 0.345 mm wall
// 1.5 mm apart (not); crossings, a T-junction, a line running on from another and a ring touching
// another are no merge; a hairpin of one line is; at most 10 places.
// Spec: docs/modes/engraved-patterns.md#implementation-e4
import { describe, expect, it } from 'vitest'
import { arc, line, type Element } from './2d/model'
import { DEFAULT_LINE_CUTTER } from './line'
import { LINE_MERGE_MARKERS, lineMerges } from './line-merge'
import type { Shape } from './model'

const path = (elements: Element[]): Shape => ({
  center: [0, 0],
  contour: { kind: 'path', path: { elements } },
})
const ring = (c: [number, number], r: number): Shape => ({
  center: [0, 0],
  contour: {
    kind: 'region',
    region: {
      pieces: [
        {
          outer: {
            elements: [
              arc([c[0] + r, c[1]], [c[0] - r, c[1]], c, true),
              arc([c[0] - r, c[1]], [c[0] + r, c[1]], c, true),
            ],
          },
          holes: [],
        },
      ],
    },
  },
})
const op = (paths: Shape[], depth = 1) => ({
  paths,
  depth: { start: depth, end: depth },
  cutter: DEFAULT_LINE_CUTTER,
})

describe('lineMerges', () => {
  it('finds a wall under 0.3 mm between parallel grooves, not one over it', () => {
    const near = lineMerges(op([path([line([0, 0], [30, 0])]), path([line([0, 1.4], [30, 1.4])])]))
    expect(near).toHaveLength(1)
    expect(near[0]!.wall).toBeCloseTo(1.4 - 2 * Math.tan(Math.PI / 6), 6)
    expect(near[0]!.at[1]).toBeCloseTo(0.7, 6)
    const far = lineMerges(op([path([line([0, 0], [30, 0])]), path([line([0, 1.5], [30, 1.5])])]))
    expect(far).toEqual([])
    // shallower grooves are narrower: the same 1.4 mm is fine at 0.5 mm deep
    expect(
      lineMerges(op([path([line([0, 0], [30, 0])]), path([line([0, 1.4], [30, 1.4])])], 0.5)),
    ).toEqual([])
  })

  it('crossings, a T, a run-on and a touching ring are no merge', () => {
    const cross = op([path([line([0, 0], [20, 20])]), path([line([20, 0], [0, 20])])])
    expect(lineMerges(cross)).toEqual([])
    const shallow = op([path([line([0, 0], [40, 0])]), path([line([0, -2], [40, 2])])])
    expect(lineMerges(shallow)).toEqual([])
    const tee = op([path([line([0, 0], [20, 0])]), path([line([10, 0], [10, 10])])])
    expect(lineMerges(tee)).toEqual([])
    const runOn = op([
      path([line([0, 0], [10, 0]), line([10, 0], [10, 5])]),
      path([line([10, 0], [20, 0])]),
    ])
    expect(lineMerges(runOn)).toEqual([])
    // a small ring inside a big one, touching it (the Rosette's circles in its border)
    expect(lineMerges(op([ring([0, 0], 30), ring([12, 0], 18)]))).toEqual([])
  })

  it('a hairpin of one line is a merge; at most 10 places are reported', () => {
    const hairpin = op([
      path([
        line([0, 0], [30, 0]),
        arc([30, 0], [30, 1.2], [30, 0.6], true),
        line([30, 1.2], [0, 1.2]),
      ]),
    ])
    expect(lineMerges(hairpin)).toHaveLength(1)
    const comb = op(Array.from({ length: 15 }, (_, k) => path([line([0, k * 1.3], [30, k * 1.3])])))
    expect(lineMerges(comb)).toHaveLength(LINE_MERGE_MARKERS)
  })
})
