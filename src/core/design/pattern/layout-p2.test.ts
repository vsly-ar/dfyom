// A pattern's cells, P2: a named boundary with a keep-out less the margin, `clip` with slivers
// dropped, `invert` (cells as holes of the area), the polar lattice, a split piece's clip
// rectangle and the thin web (`patternWeb`).
// Spec: docs/modes/patterns.md#implementation-p2
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../shared/testing/result'
import { regionContains } from '../../geometry/2d/measure'
import { chainBounds, regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { resolveDefinition } from '../shape'
import type { ShapeItem } from '../shape.dto'
import { circumRadius, clipToRect, resolvePattern, type PatternDefinition } from './layout'

const port = nodeRegion2d()
const circle = (diameter: number, center: [number, number] = [0, 0]): ShapeItem<number> => ({
  kind: 'circle',
  op: 'add',
  center,
  diameter,
})

/** A rounded 80 × 50 R 10 rectangle with a Ø 20 keep-out at its centre. */
const ROUNDED: ShapeItem<number>[] = [
  { kind: 'rectangle', op: 'add', center: [0, 0], length: 80, width: 50, cornerRadius: 10 },
  { kind: 'circle', op: 'subtract', center: [0, 0], diameter: 20 },
]

const def = (over: Partial<PatternDefinition> = {}): PatternDefinition => ({
  kind: 'pattern',
  op: 'add',
  cell: [circle(6)],
  cellRotation: 0,
  lattice: 'hex',
  angle: 0,
  spacing: { gap: 2 },
  boundary: { min: [0, 0], max: [100, 60] },
  margin: 3,
  ...over,
})
const resolve = (over: Partial<PatternDefinition> = {}) =>
  resolvePattern(port, def(over), (d) => resolveDefinition(port, d))
const cells = (over: Partial<PatternDefinition> = {}) => resolve(over).unwrap()
const inRounded = (over: Partial<PatternDefinition> = {}) =>
  cells({ area: { items: ROUNDED, center: [50, 30], rotation: 0 }, ...over })

const centreOf = (r: Region, i: number): [number, number] => {
  const b = chainBounds(r.pieces[i]!.outer.elements)!
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
}

describe('boundary shape', () => {
  it('cells lie wholly in the boundary less the margin, none on the grown keep-out', () => {
    const p = inRounded()
    expect(p.cells).toBeGreaterThan(20)
    expect(p.region.pieces).toHaveLength(p.cells)
    // the area: 74 × 44 R 7 less a Ø 26 disc
    const want = 74 * 44 - (4 - Math.PI) * 49 - Math.PI * 169
    expect(regionArea(p.area)).toBeCloseTo(want, 1)
    for (let i = 0; i < p.region.pieces.length; i++) {
      const c = centreOf(p.region, i)
      // cell Ø 6: its centre at least 3 from the area's edge, so ≥ 16 from the keep-out centre
      expect(Math.hypot(c[0] - 50, c[1] - 30)).toBeGreaterThanOrEqual(16 - 1e-6)
      expect(regionContains(p.area, c)).toBe(true)
    }
    // every cell lies inside the area: the area minus the cells loses exactly their area
    const left = port.difference(p.area, p.region).unwrap()
    expect(regionArea(left)).toBeCloseTo(regionArea(p.area) - p.cells * Math.PI * 9, 3)
  })

  it('the origin defaults to the centre of the area; the frame stays the face', () => {
    const p = inRounded()
    expect(p.frame).toEqual({ min: [0, 0], max: [100, 60] })
    // hex rows about [50, 30]: a node there would sit in the keep-out, its row neighbours stay
    const xs = p.region.pieces.map((_, i) => centreOf(p.region, i))
    expect(xs.some((c) => Math.abs(c[1] - 30) < 1e-9 && Math.abs(c[0] - 66) < 1e-9)).toBe(true)
  })

  it('a turned boundary is placed by its box centre', () => {
    const p = inRounded({ area: { items: ROUNDED, center: [50, 30], rotation: 90 }, margin: 0 })
    const b = chainBounds(p.area.pieces.flatMap((x) => x.outer.elements))!
    expect(b.min[0]).toBeCloseTo(25, 9)
    expect(b.max[1]).toBeCloseTo(70, 9)
  })

  it('an open boundary is refused at boundary', () => {
    const open: ShapeItem<number> = {
      kind: 'path',
      op: 'add',
      closed: false,
      start: [0, 0],
      segments: [
        { kind: 'line', to: [30, 0] },
        { kind: 'line', to: [30, 20] },
      ],
    } as unknown as ShapeItem<number>
    const e = expectErrCode(
      resolve({ area: { items: [open], center: [50, 30], rotation: 0 } }),
      'model.invariant',
    )
    expect(e.issues[0]?.path[0]).toBe('boundary')
  })
})

describe('clip', () => {
  it('cuts the cells crossing the area and drops the slivers', () => {
    const whole = inRounded()
    const clipped = inRounded({ fit: 'clip' })
    expect(clipped.cells).toBeGreaterThan(whole.cells)
    expect(regionArea(clipped.region)).toBeGreaterThan(regionArea(whole.region))
    // nothing outside the area: the cells minus the area is empty
    const out = port.difference(clipped.region, clipped.area).unwrap()
    expect(regionArea(out)).toBeLessThan(1e-6)
    // every fragment kept is at least 1 mm wide
    for (const piece of clipped.region.pieces)
      expect(port.offset({ pieces: [piece] }, 0.5).unwrap().pieces.length).toBeGreaterThan(0)
  })

  it('clips to the face rectangle less the margin too', () => {
    const p = cells({ fit: 'clip', lattice: 'square', spacing: { gap: 3 } })
    const b = chainBounds(p.region.pieces.flatMap((x) => x.outer.elements))!
    expect(b.min[0]).toBeGreaterThanOrEqual(3 - 1e-9)
    expect(b.max[0]).toBeLessThanOrEqual(97 + 1e-9)
    expect(p.cells).toBeGreaterThan(cells({ lattice: 'square', spacing: { gap: 3 } }).cells)
    expect(p.dropped).toBe(0)
  })

  it('fragments under 1 mm wide are dropped and counted', () => {
    // nodes every 10 mm from [50, 30]: the cells on the face edges enter the area by 0.5 mm
    const p = cells({ fit: 'clip', lattice: 'square', spacing: { gap: 4 }, margin: 2.5 })
    const whole = cells({ lattice: 'square', spacing: { gap: 4 }, margin: 2.5 })
    // the corner cells miss the area (their nearest point is 3.5 from the face corner)
    expect(p.dropped).toBe(2 * 9 + 2 * 5)
    expect(p.cells).toBe(whole.cells)
  })
})

describe('invert', () => {
  it('the area minus the cells: cells become holes, area = area − cells', () => {
    const plain = inRounded()
    const inv = inRounded({ invert: true })
    expect(inv.cells).toBe(plain.cells)
    expect(regionArea(inv.region)).toBeCloseTo(regionArea(plain.area) - regionArea(plain.region), 4)
    const holes = inv.region.pieces.reduce((n, p) => n + p.holes.length, 0)
    // the keep-out hole plus one hole per cell
    expect(holes).toBe(plain.cells + 1)
    // a cell centre is not in the pocket, a point between cells is
    expect(regionContains(inv.region, centreOf(plain.region, 0))).toBe(false)
  })

  it('inverted and clipped: crossing fragments notch the area, its corners opened by R 0.5', () => {
    const p = inRounded({ invert: true, fit: 'clip' })
    const c = inRounded({ fit: 'clip' })
    const sharp = regionArea(c.area) - regionArea(c.region)
    // the opening takes the sharp notch corners and the thin bits beside dropped slivers
    expect(regionArea(p.region)).toBeLessThan(sharp)
    expect(regionArea(p.region)).toBeGreaterThan(sharp * 0.98)
  })

  it('on the face: the whole face less the margin (corners R 0.5) minus the cells', () => {
    const p = cells({ invert: true })
    const plain = cells()
    expect(p.region.pieces).toHaveLength(1)
    const face = 94 * 54 - (4 - Math.PI) * 0.25
    expect(regionArea(p.region)).toBeCloseTo(face - regionArea(plain.region), 4)
  })
})

describe('polar', () => {
  it('rings about the origin: 1 + 6 + 12 … circles a chord ≥ pitch apart', () => {
    const p = cells({
      lattice: 'polar',
      spacing: { gap: 2 },
      boundary: { min: [0, 0], max: [60, 60] },
      margin: 0,
    })
    expect(p.pitch).toEqual([8, 8])
    // ring 1 at r 8: ⌊π / asin(0.5)⌋ = 6; ring 2 at r 16: ⌊π / asin(0.25)⌋ = 12
    const centres = p.region.pieces.map((_, i) => centreOf(p.region, i))
    const at = (r: number) =>
      centres.filter((c) => Math.abs(Math.hypot(c[0] - 30, c[1] - 30) - r) < 1e-6).length
    expect(at(0)).toBe(1)
    expect(at(8)).toBe(6)
    expect(at(16)).toBe(12)
    // no two cells closer than the pitch
    for (let i = 0; i < centres.length; i++)
      for (let j = i + 1; j < centres.length; j++)
        expect(
          Math.hypot(centres[i]![0] - centres[j]![0], centres[i]![1] - centres[j]![1]),
        ).toBeGreaterThanOrEqual(8 - 1e-9)
  })

  it('a square cell keeps its orientation; the gap is round its circumscribed circle', () => {
    const sq: ShapeItem<number> = {
      kind: 'rectangle',
      op: 'add',
      center: [0, 0],
      length: 6,
      width: 6,
      cornerRadius: 0,
    }
    const p = cells({ lattice: 'polar', cell: [sq], spacing: { gap: 1 }, angle: 15 })
    expect(p.pitch[0]).toBeCloseTo(6 * Math.SQRT2 + 1, 9)
    for (const piece of p.region.pieces) {
      // axis-aligned: every edge horizontal or vertical
      for (const e of piece.outer.elements)
        expect(Math.min(Math.abs(e.a[0] - e.b[0]), Math.abs(e.a[1] - e.b[1]))).toBeLessThan(1e-9)
    }
  })

  it('a pitch under the circumscribed diameter is patternOverlap', () => {
    const e = expectErrCode(
      resolve({ lattice: 'polar', spacing: { pitch: [5, 8] } }),
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['spacing'], rule: 'patternOverlap' })
  })

  it('circumRadius: a circle off the origin, a square', () => {
    expect(
      circumRadius({
        pieces: [
          {
            outer: {
              elements: [{ kind: 'arc', a: [3, 0], b: [3, 0], centre: [1, 0], ccw: true }],
            },
            holes: [],
          },
        ],
      }),
    ).toBeCloseTo(3, 12)
  })
})

describe('clip rectangle (split pieces)', () => {
  it('cuts the cells at the rectangle; cells inside stay whole', () => {
    const p = cells({ clip: { min: [0, 0], max: [50, 60] } })
    const full = cells()
    const b = chainBounds(p.region.pieces.flatMap((x) => x.outer.elements))!
    expect(b.max[0]).toBeLessThanOrEqual(50 + 1e-9)
    // the two halves make the whole pattern
    const q = cells({ clip: { min: [50, 0], max: [100, 60] } })
    expect(regionArea(p.region) + regionArea(q.region)).toBeCloseTo(regionArea(full.region), 4)
  })

  it('an inverted region keeps its holes inside the rectangle', () => {
    const p = inRounded({ invert: true, clip: { min: [0, 0], max: [50, 60] } })
    const q = inRounded({ invert: true, clip: { min: [50, 0], max: [100, 60] } })
    const full = inRounded({ invert: true })
    expect(regionArea(p.region) + regionArea(q.region)).toBeCloseTo(regionArea(full.region), 3)
  })

  it('clipToRect leaves a region inside alone and drops one outside', () => {
    const r = cells().region
    expect(clipToRect(port, r, [-10, -10], [200, 200]).unwrap()).toEqual(r)
    expect(clipToRect(port, r, [200, 200], [300, 300]).unwrap().pieces).toHaveLength(0)
  })
})

describe('thin web', () => {
  it('none at a 2 mm gap of circles', () => {
    expect(cells().web).toBeUndefined()
  })

  it('a 0.6 mm web between hex circles is found and measured', () => {
    const p = cells({ spacing: { gap: 0.6 } })
    expect(p.web?.island).toBe(false)
    expect(p.web?.width).toBeCloseTo(0.6, 1)
    // the marker lies between two cells: in no cell, near two
    const at = p.web!.at
    expect(regionContains(p.region, at)).toBe(false)
  })

  it('a staggered rectangle web along the rows', () => {
    const rect: ShapeItem<number> = {
      kind: 'rectangle',
      op: 'add',
      center: [0, 0],
      length: 10,
      width: 4,
      cornerRadius: 0,
    }
    const p = cells({ cell: [rect], lattice: 'square', spacing: { pitch: [10.5, 6] } })
    expect(p.web?.width).toBeCloseTo(0.5, 1)
  })

  it('inverted: a 0.8 mm island is thin, a 6 mm one is not', () => {
    expect(cells({ invert: true }).web).toBeUndefined()
    const p = cells({ invert: true, cell: [circle(0.8)], spacing: { gap: 3 } })
    expect(p.web?.island).toBe(true)
    expect(p.web?.width).toBeCloseTo(0.8, 1)
  })

  it('polar webs come from real neighbour pairs', () => {
    const p = cells({ lattice: 'polar', spacing: { gap: 0.5 }, margin: 0 })
    expect(p.web?.width).toBeCloseTo(0.5, 1)
  })
})
