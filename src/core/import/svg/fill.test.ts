import { describe, expect, it } from 'vitest'
import { arc, line, regionArea, signedArea, type Loop } from '../../geometry/2d/model'
import { checkChain } from '../../geometry/2d/wire'
import { circle, hole, rect } from '../../geometry/2d/testing/fixtures'
import { crossings } from '../../geometry/2d/testing/oracles'
import { fillLoops, type FillResult } from './fill'
import { intersect } from './intersect'

const poly = (...p: [number, number][]): Loop => ({
  elements: p.map((a, i) => line(a, p[(i + 1) % p.length]!)),
})

/** Area of the filled result (outer loops minus holes; loops never overlap). */
const area = (r: FillResult): number => r.loops.reduce((s, l) => s + signedArea(l.loop), 0)
const ops = (r: FillResult): string[] => r.loops.map((l) => l.op)

function valid(r: FillResult): void {
  for (const l of r.loops) {
    expect(checkChain(l.loop.elements, true, 'test').isOk()).toBe(true)
    expect(Math.sign(signedArea(l.loop))).toBe(l.op === 'add' ? 1 : -1)
  }
  expect(crossings(r.loops.map((l) => l.loop))).toBe(0)
  expect(r.unclosed).toBe(0)
}

describe('intersect', () => {
  it('finds line–line crossings and collinear overlaps', () => {
    const h = intersect(line([0, 0], [10, 0]), line([5, -5], [5, 5]))
    expect(h).toEqual([{ p: [5, 0], s: 0.5, t: 0.5 }])
    expect(intersect(line([0, 0], [10, 0]), line([0, 1], [10, 1]))).toEqual([])
    const o = intersect(line([0, 0], [10, 0]), line([5, 0], [15, 0]))
    expect(o.map((x) => x.p)).toEqual([
      [5, 0],
      [10, 0],
    ])
  })

  it('finds line–arc and arc–arc points, tangents once', () => {
    const half = arc([10, 0], [-10, 0], [0, 0], true) // upper half circle r 10
    expect(intersect(line([-20, 5], [20, 5]), half)).toHaveLength(2)
    expect(intersect(line([-20, 10], [20, 10]), half)).toHaveLength(1)
    expect(intersect(line([-20, -5], [20, -5]), half)).toHaveLength(0)
    const other = arc([20, 0], [0, 0], [10, 0], true)
    const h = intersect(half, other)
    expect(h).toHaveLength(1)
    expect(h[0]!.p[0]).toBeCloseTo(5, 12)
    expect(h[0]!.p[1]).toBeCloseTo(Math.sqrt(75), 12)
    // the same circle overlapping: the overlap's ends
    const q = arc([0, 10], [-10, 0], [0, 0], true)
    expect(intersect(half, q).map((x) => x.p)).toEqual([
      [0, 10],
      [-10, 0],
    ])
  })
})

describe('fillLoops without crossings', () => {
  it('nonzero: a nested loop of the same sense is filled over, of the opposite sense a hole', () => {
    const same = fillLoops([{ rule: 'nonzero', loops: [rect(0, 0, 10, 10), rect(2, 2, 6, 6)] }])
    expect(ops(same)).toEqual(['add'])
    expect(same.dropped).toBe(1)
    const opp = fillLoops([
      { rule: 'nonzero', loops: [rect(0, 0, 10, 10), hole(rect(2, 2, 6, 6))] },
    ])
    expect(ops(opp)).toEqual(['add', 'subtract'])
    expect(area(opp)).toBeCloseTo(64, 9)
  })

  it('evenodd: nesting alternates whatever the sense, orientation is fixed', () => {
    const r = fillLoops([
      {
        rule: 'evenodd',
        loops: [hole(rect(0, 0, 10, 10)), rect(2, 2, 6, 6), circle(5, 5, 1)],
      },
    ])
    expect(ops(r)).toEqual(['add', 'subtract', 'add'])
    valid(r)
    expect(area(r)).toBeCloseTo(100 - 36 + Math.PI, 9)
  })

  it('combines elements even-odd: a loop of its own inside another is a hole', () => {
    const r = fillLoops([
      { rule: 'nonzero', loops: [rect(0, 0, 10, 10)] },
      { rule: 'nonzero', loops: [circle(5, 5, 2)] },
    ])
    expect(ops(r)).toEqual(['add', 'subtract'])
  })
})

describe('fillLoops repairs crossings', () => {
  it('splits a bow tie into two lobes', () => {
    const r = fillLoops([{ rule: 'nonzero', loops: [poly([0, 0], [10, 10], [10, 0], [0, 10])] }])
    expect(r.repaired).toBe(1)
    expect(ops(r)).toEqual(['add', 'add'])
    valid(r)
    expect(area(r)).toBeCloseTo(50, 9)
  })

  it('pentagram: nonzero fills the centre, evenodd leaves it out', () => {
    const p: [number, number][] = []
    for (let k = 0; k < 5; k++) {
      const a = Math.PI / 2 + (k * 4 * Math.PI) / 5
      p.push([10 * Math.cos(a), 10 * Math.sin(a)])
    }
    const nz = fillLoops([{ rule: 'nonzero', loops: [poly(...p)] }])
    const eo = fillLoops([{ rule: 'evenodd', loops: [poly(...p)] }])
    valid(nz)
    valid(eo)
    expect(ops(nz)).toEqual(['add'])
    expect(nz.loops[0]!.loop.elements).toHaveLength(10)
    // the inner pentagon: R·sin(18°)/sin(54°)... area by difference
    expect(area(eo)).toBeLessThan(area(nz))
    expect(eo.loops).toHaveLength(5)
  })

  it('unites overlapping circles (nonzero) or leaves their lens out (evenodd)', () => {
    const loops = [circle(0, 0, 10), circle(10, 0, 10)]
    const nz = fillLoops([{ rule: 'nonzero', loops }])
    const eo = fillLoops([{ rule: 'evenodd', loops }])
    valid(nz)
    valid(eo)
    expect(ops(nz)).toEqual(['add'])
    const lens = 2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(400 - 100)
    expect(area(nz)).toBeCloseTo(2 * Math.PI * 100 - lens, 6)
    expect(area(eo)).toBeCloseTo(2 * Math.PI * 100 - 2 * lens, 6)
    expect(eo.loops).toHaveLength(2)
    expect(regionArea({ pieces: [] })).toBe(0)
  })

  it('merges coincident loops and edges', () => {
    const r = fillLoops([{ rule: 'nonzero', loops: [rect(0, 0, 10, 10), rect(0, 0, 10, 10)] }])
    valid(r)
    expect(ops(r)).toEqual(['add'])
    expect(area(r)).toBeCloseTo(100, 9)
    const t = fillLoops([{ rule: 'nonzero', loops: [rect(0, 0, 10, 10), rect(10, 2, 5, 5)] }])
    valid(t)
    expect(ops(t)).toEqual(['add'])
    expect(area(t)).toBeCloseTo(125, 9)
  })

  it('separates loops that touch at a corner', () => {
    const r = fillLoops([{ rule: 'nonzero', loops: [rect(0, 0, 10, 10), rect(10, 10, 5, 5)] }])
    valid(r)
    expect(ops(r)).toEqual(['add', 'add'])
  })
})
