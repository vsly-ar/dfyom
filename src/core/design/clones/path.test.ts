// The clone path (v0.4 F5), ported from cnc-code's clones tests (src/core/composer/clones.test.ts)
// with stable numbering. Spec: docs/modes/features.md#properties
import { describe, expect, it } from 'vitest'
import {
  arcSteps,
  clonePath,
  keepSkips,
  rowPointCount,
  rowPointOf,
  toggleSkip,
  type PathRow,
  type UV,
} from './path'

const at = (u: number, v: number): UV => ({ u, v })
const sk = (skip?: number[]) => (skip ? { skip } : {})
const grid = (cols: number, rows: number, du: number, dv: number, skip?: number[]): PathRow => ({
  kind: 'grid',
  cols,
  rows,
  du,
  dv,
  ...sk(skip),
})
const offset = (count: number, du: number, dv: number, skip?: number[]): PathRow => ({
  kind: 'offset',
  count,
  du,
  dv,
  ...sk(skip),
})
const polar = (count: number, angle: number, distance: number, skip?: number[]): PathRow => ({
  kind: 'polar',
  count,
  angle,
  distance,
  ...sk(skip),
})
const arc = (radius: number, angle: number, a: number, step: number, skip?: number[]): PathRow => ({
  kind: 'arc',
  radius,
  angle,
  arc: a,
  step,
  ...sk(skip),
})
const point = (u: number, v: number, skip?: number[]): PathRow => ({
  kind: 'point',
  u,
  v,
  ...sk(skip),
})

const positions = (origin: UV, rows: PathRow[]) =>
  clonePath(origin, rows).instances.map((i) => i.at)
const numbers = (origin: UV, rows: PathRow[]) =>
  clonePath(origin, rows).instances.map((i) => i.number)

describe('clonePath', () => {
  it('without rows: the source alone, number 1, offset 0', () => {
    const p = clonePath(at(3, 4), [])
    expect(p.instances).toEqual([{ number: 1, offset: at(0, 0), at: at(3, 4) }])
    expect(p.lastNumber).toBe(1)
  })

  describe('grid', () => {
    it('numbers its cells row by row from the source', () => {
      expect(positions(at(5, 10), [grid(3, 2, 10, 20)])).toEqual([
        at(5, 10),
        at(15, 10),
        at(25, 10),
        at(5, 30),
        at(15, 30),
        at(25, 30),
      ])
    })

    it('rounds to the G-code resolution, so 0.1 · 3 lands where 0.3 does', () => {
      expect(clonePath(at(0, 0), [grid(4, 1, 0.1, 1)]).instances.map((i) => i.offset.u)).toEqual([
        0, 0.1, 0.2, 0.3,
      ])
    })

    it('moves the reference point to its last cell in zigzag order', () => {
      expect(positions(at(0, 0), [grid(3, 2, 10, 10), offset(1, 0, 5)]).at(-1)).toEqual(at(0, 15))
      expect(positions(at(0, 0), [grid(3, 3, 10, 10), offset(1, 0, 5)]).at(-1)).toEqual(at(20, 25))
    })

    it('a skipped cell keeps its number and still moves the reference point', () => {
      const p = clonePath(at(0, 0), [grid(2, 2, 10, 10, [1]), offset(1, 0, 5)])
      expect(p.instances.map((i) => [i.number, i.at])).toEqual([
        [1, at(0, 0)],
        [2, at(10, 0)],
        [4, at(10, 10)],
        [5, at(0, 15)],
      ])
      expect(p.skipped).toEqual([3])
    })

    it('a 6 × 4 spoilboard grid with 4 bolt holes skipped: 20 holes', () => {
      expect(clonePath(at(0, 0), [grid(6, 4, 50, 50, [4, 6, 15, 17])]).instances).toHaveLength(20)
    })
  })

  it('offset: N steps from the reference point', () => {
    expect(positions(at(1, 2), [offset(3, 10, -5)])).toEqual([
      at(1, 2),
      at(11, -3),
      at(21, -8),
      at(31, -13),
    ])
  })

  it('polar: N steps of a distance along an angle', () => {
    expect(positions(at(0, 0), [polar(2, 90, 10)])).toEqual([at(0, 0), at(0, 10), at(0, 20)])
    expect(positions(at(0, 0), [polar(1, 45, Math.SQRT2 * 10)])[1]).toEqual(at(10, 10))
  })

  describe('arc', () => {
    it('runs counter-clockwise for a positive arc, clockwise for a negative one', () => {
      expect(positions(at(0, 0), [arc(10, 0, 180, 90)])).toEqual([at(0, 0), at(10, -10), at(20, 0)])
      expect(positions(at(0, 0), [arc(10, 0, -180, 90)])).toEqual([at(0, 0), at(10, 10), at(20, 0)])
    })

    it('stops at the last whole step; the next row starts there', () => {
      const p = positions(at(0, 0), [arc(10, 0, 100, 30), offset(1, 0, 1)])
      expect(p).toHaveLength(5)
      expect(p[3]).toEqual(at(10, -10))
      expect(p[4]).toEqual(at(10, -9))
    })

    it('a 360° bolt circle closes on itself: 6 holes, the closing point has no number', () => {
      const p = clonePath(at(0, 0), [arc(10, 0, 360, 60), offset(1, 0, 5)])
      expect(p.instances.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
      expect(p.rows[0]!.points.at(-1)).toMatchObject({ kind: 'closes' })
      expect(p.rows[0]!.points.at(-1)!.number).toBeUndefined()
      expect(p.duplicates).toEqual([])
      for (const i of p.instances.slice(0, 6))
        expect(Math.hypot(i.at.u - 10, i.at.v)).toBeCloseTo(10, 3)
    })

    it('a full circle in steps that are not whole degrees still closes', () => {
      expect(clonePath(at(0, 0), [arc(10, 0, 360, 360 / 7)]).instances).toHaveLength(7)
    })

    it('an arc ending on an earlier instance is a duplicate that keeps its number', () => {
      const p = clonePath(at(0, 0), [arc(10, 0, 180, 90), arc(10, 180, 180, 90)])
      expect(p.duplicates).toEqual([5])
      expect(p.instances.map((i) => i.number)).toEqual([1, 2, 3, 4])
    })
  })

  describe('skips, stable numbers and the reference chain', () => {
    it('skipping 3 leaves 4–8 as 4–8 (D30)', () => {
      expect(numbers(at(0, 0), [offset(7, 10, 0)])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(numbers(at(0, 0), [offset(7, 10, 0, [1])])).toEqual([1, 2, 4, 5, 6, 7, 8])
      expect(numbers(at(0, 0), [offset(3, 10, 0), offset(3, 0, 10, [0])])).toEqual([
        1, 2, 3, 4, 6, 7,
      ])
    })

    it('a skipped last point gets no clone but moves the reference point', () => {
      expect(positions(at(0, 0), [offset(2, 10, 0, [1]), offset(1, 0, 5)])).toEqual([
        at(0, 0),
        at(10, 0),
        at(20, 5),
      ])
    })

    it('indices past the row are ignored', () => {
      expect(clonePath(at(0, 0), [offset(2, 10, 0, [2, 99])]).instances).toHaveLength(3)
    })

    it('a skipped one-position row is a plain shift', () => {
      expect(positions(at(0, 0), [offset(1, 20, 0, [0]), arc(5, 0, 180, 180)])).toEqual([
        at(0, 0),
        at(30, 0),
      ])
    })

    it('a point row: absolute [u, v], the reference point moves there', () => {
      expect(positions(at(5, 5), [offset(1, 10, 0), point(-3, 40), offset(1, 1, 0)])).toEqual([
        at(5, 5),
        at(15, 5),
        at(-3, 40),
        at(-2, 40),
      ])
      expect(clonePath(at(5, 5), [point(-3, 40)]).instances[1]!.offset).toEqual(at(-8, 35))
    })

    it('a point row on the source is a duplicate', () => {
      expect(clonePath(at(5, 5), [point(5, 5)]).duplicates).toEqual([2])
    })

    it('rows chain: each starts where the one before ended', () => {
      const p = clonePath(at(0, 0), [offset(2, 10, 0, [1]), polar(1, 90, 5)])
      expect(p.rows[0]).toMatchObject({ start: at(0, 0), end: at(20, 0) })
      expect(p.rows[1]!.start).toEqual(at(20, 0))
      expect(p.rows[1]!.line).toHaveLength(2)
    })

    it("a grid's line runs in zigzag; points stay row by row", () => {
      const r = clonePath(at(0, 0), [grid(3, 2, 10, 10, [2])]).rows[0]!
      expect(r.line).toEqual([at(0, 0), at(10, 0), at(20, 0), at(20, 10), at(10, 10), at(0, 10)])
      expect(r.points.map((p) => [p.kind, p.number])).toEqual([
        ['clone', 2],
        ['clone', 3],
        ['skipped', 4],
        ['clone', 5],
        ['clone', 6],
      ])
    })

    it("an arc's circle: centre from the reference point, starting at angle + 180°", () => {
      const r = clonePath(at(0, 0), [arc(10, 90, 180, 60)]).rows[0]!
      expect(r.arc!.centre.u).toBeCloseTo(0, 6)
      expect(r.arc!.centre.v).toBeCloseTo(10, 6)
      expect(r.arc).toMatchObject({ radius: 10, from: 270, sweep: 180 })
    })
  })

  it('duplicates of any earlier instance are left out, listed by number', () => {
    const p = clonePath(at(0, 0), [offset(2, 10, 0), offset(2, -10, 0.0004)])
    expect(p.instances.map((i) => i.at)).toEqual([at(0, 0), at(10, 0), at(20, 0)])
    expect(p.duplicates).toEqual([4, 5])
  })
})

describe('arcSteps', () => {
  it('whole steps only, with a hair of slack, and the sign of the arc', () => {
    expect(arcSteps({ arc: 360, step: 60 })).toEqual({ n: 6, sweep: 360 })
    expect(arcSteps({ arc: 100, step: 30 })).toEqual({ n: 3, sweep: 90 })
    expect(arcSteps({ arc: -0.3, step: 0.1 })).toMatchObject({ n: 3 })
  })
})

describe('rowPointOf / toggleSkip', () => {
  it('finds the row and point of each number; skipping it removes that instance only', () => {
    const rows = [grid(3, 3, 10, 10), arc(15, 0, 360, 45)]
    const before = clonePath(at(0, 0), rows)
    expect(rowPointOf(before, 1)).toBeNull()
    for (const inst of before.instances.slice(1)) {
      const { row, point } = rowPointOf(before, inst.number)!
      const after = clonePath(at(0, 0), toggleSkip(rows, row, point))
      expect(after.instances.map((i) => i.number)).toEqual(
        before.instances.map((i) => i.number).filter((n) => n !== inst.number),
      )
    }
  })

  it('adds sorted, removes again, drops an empty skip; bad indices change nothing', () => {
    const rows = [offset(5, 1, 0), grid(3, 3, 1, 1, [4])]
    const a = toggleSkip(rows, 1, 2)
    expect(a[1]).toEqual(grid(3, 3, 1, 1, [2, 4]))
    expect(a[0]).toBe(rows[0])
    expect(toggleSkip(toggleSkip(a, 1, 4), 1, 2)[1]).toEqual(grid(3, 3, 1, 1))
    expect(toggleSkip(rows, 2, 0)).toBe(rows)
    expect(toggleSkip(rows, 0, -1)).toBe(rows)
    expect(toggleSkip(rows, 0, 0.5)).toBe(rows)
  })
})

describe('rowPointCount', () => {
  it.each([
    [grid(3, 3, 1, 1), 8],
    [grid(1, 1, 1, 1), 0],
    [offset(4, 1, 0), 4],
    [arc(10, 0, 100, 30), 3],
    [arc(10, 0, 360, 60), 6],
    [point(3, 3), 1],
  ])('%o has %i points', (row, n) => {
    expect(rowPointCount(row)).toBe(n)
  })
})

describe('keepSkips', () => {
  it('a grid keeps each skipped cell across a change of columns or rows', () => {
    const prev = grid(3, 2, 10, 10, [0, 3, 4])
    expect(keepSkips(prev, grid(4, 2, 10, 10))).toEqual(grid(4, 2, 10, 10, [0, 4, 5]))
    expect(keepSkips(prev, grid(2, 2, 10, 10))).toEqual(grid(2, 2, 10, 10, [0, 2]))
    expect(keepSkips(grid(3, 2, 10, 10, [1, 4]), grid(1, 1, 10, 10))).toEqual(grid(1, 1, 10, 10))
  })

  it('other kinds keep the indices inside the row; a change of kind drops them', () => {
    expect(keepSkips(offset(5, 1, 0, [1, 4]), offset(3, 2, 0))).toEqual(offset(3, 2, 0, [1]))
    expect(keepSkips(arc(10, 0, 180, 30, [2, 5]), arc(10, 0, 90, 30))).toEqual(
      arc(10, 0, 90, 30, [2]),
    )
    expect(keepSkips(offset(3, 1, 0, [0]), polar(3, 0, 1, [1]))).toEqual(polar(3, 0, 1))
  })
})
