// A pattern's cells (patterns P1): lattices, spacing, angle, origin, the boundary less the
// margin (whole cells), the invariants and the pieces emitted without a boolean.
// Spec: docs/modes/patterns.md#model, docs/modes/patterns.md#implementation-p1
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../shared/testing/result'
import { chainBounds, regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { resolveDefinition } from '../shape'
import type { ShapeItem } from '../shape.dto'
import { PATTERN_CELLS_MAX, resolvePattern, type PatternDefinition } from './layout'

const port = nodeRegion2d()
const circle = (diameter: number): ShapeItem<number> => ({
  kind: 'circle',
  op: 'add',
  center: [0, 0],
  diameter,
})

/** Ø 8 circles, gap 2, over 100 × 60 less 5 (the patterns.md defaults on the test block). */
const def = (over: Partial<PatternDefinition> = {}): PatternDefinition => ({
  kind: 'pattern',
  op: 'add',
  cell: [circle(8)],
  cellRotation: 0,
  lattice: 'square',
  angle: 0,
  spacing: { gap: 2 },
  boundary: { min: [0, 0], max: [100, 60] },
  margin: 5,
  ...over,
})

const cells = (over: Partial<PatternDefinition> = {}) =>
  resolvePattern(port, def(over), (d) => resolveDefinition(port, d)).unwrap()

const boundsOf = (r: Region) => chainBounds(r.pieces.flatMap((p) => p.outer.elements))!
const centres = (r: Region) =>
  r.pieces.map((p) => {
    const b = chainBounds(p.outer.elements)!
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  })

describe('lattices', () => {
  it('square: 9 × 5 cells at a 10 mm pitch about the centre', () => {
    const p = cells()
    expect(p.cells).toBe(45)
    expect(p.region.pieces).toHaveLength(45)
    expect(p.pitch).toEqual([10, 10])
    const b = boundsOf(p.region)
    expect(b.min[0]).toBeCloseTo(6, 9)
    expect(b.max[0]).toBeCloseTo(94, 9)
    expect(b.min[1]).toBeCloseTo(6, 9)
    expect(b.max[1]).toBeCloseTo(54, 9)
    expect(regionArea(p.region)).toBeCloseTo(45 * Math.PI * 16, 6)
  })

  it('staggered: odd rows shifted half a pitch (9 + 8 + 9 + 8 + 9)', () => {
    const p = cells({ lattice: 'staggered' })
    expect(p.cells).toBe(43)
    const row = centres(p.region).filter((c) => Math.abs(c[1]! - 40) < 1e-9)
    expect(row.map((c) => c[0]!).sort((a, b) => a - b)[0]).toBeCloseTo(15, 9)
  })

  it('hex: rows 60° apart, so the web to every neighbour is the gap', () => {
    const p = cells({ lattice: 'hex' })
    expect(p.pitch[0]).toBe(10)
    expect(p.pitch[1]).toBeCloseTo(5 * Math.sqrt(3), 12)
    expect(p.cells).toBe(43)
    const cs = centres(p.region)
    let nearest = Infinity
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++)
        nearest = Math.min(nearest, Math.hypot(cs[i]![0]! - cs[j]![0]!, cs[i]![1]! - cs[j]![1]!))
    expect(nearest - 8).toBeCloseTo(2, 9)
  })

  it('pitch given directly', () => {
    expect(cells({ spacing: { pitch: [20, 12] } }).cells).toBe(5 * 3)
  })

  it('an angle turns the lattice about the origin; every cell stays inside', () => {
    const p = cells({ angle: 30 })
    expect(p.cells).toBeGreaterThan(30)
    const b = boundsOf(p.region)
    expect(b.min[0]).toBeGreaterThanOrEqual(5 - 1e-9)
    expect(b.max[0]).toBeLessThanOrEqual(95 + 1e-9)
    expect(b.min[1]).toBeGreaterThanOrEqual(5 - 1e-9)
    expect(b.max[1]).toBeLessThanOrEqual(55 + 1e-9)
  })

  it('origin: a node; the cells fill from it', () => {
    const p = cells({ origin: [9, 9] })
    expect(p.cells).toBe(45)
    const b = boundsOf(p.region)
    expect(b.min).toEqual([5, 5])
  })

  it('cell rotation turns the cell before the box is centred on the node', () => {
    const rect: ShapeItem<number> = {
      kind: 'rectangle',
      op: 'add',
      center: [3, 1],
      length: 12,
      width: 4,
      cornerRadius: 0,
    }
    const p = cells({ cell: [rect], cellRotation: 90, lattice: 'square' })
    // 4 × 12 cells at pitch 6 × 14: 15 columns × 3 rows inside 90 × 50
    expect(p.pitch).toEqual([6, 14])
    expect(p.cells).toBe(15 * 3)
    const first = chainBounds(p.region.pieces[0]!.outer.elements)!
    expect(first.max[0] - first.min[0]).toBeCloseTo(4, 9)
  })
})

describe('boundary and margin', () => {
  it('whole cells only: none fits a margin that leaves less than a cell (no error)', () => {
    const p = cells({ margin: 27 })
    expect(p.cells).toBe(0)
    expect(p.region.pieces).toEqual([])
    expect(p.frame).toEqual({ min: [0, 0], max: [100, 60] })
  })

  it('margin 0 runs the cells to the face edge', () => {
    const p = cells({ margin: 0, origin: [4, 4] })
    expect(p.cells).toBe(10 * 6)
  })
})

describe('invariants', () => {
  it('patternOverlap: touching or overlapping neighbours', () => {
    const square: ShapeItem<number> = {
      kind: 'rectangle',
      op: 'add',
      center: [0, 0],
      length: 10,
      width: 10,
      cornerRadius: 0,
    }
    const touch = resolvePattern(port, def({ cell: [square], spacing: { pitch: [10, 10] } }), (d) =>
      resolveDefinition(port, d),
    )
    const e = expectErrCode(touch, 'model.invariant')
    expect(e.issues.map((i) => [i.path, i.rule])).toEqual([[['spacing'], 'patternOverlap']])
    // a circle's box overlaps its neighbour's on the diagonal of a staggered lattice, the circle not
    const ok = resolvePattern(
      port,
      def({ lattice: 'staggered', spacing: { pitch: [9, 7] } }),
      (d) => resolveDefinition(port, d),
    )
    expect(ok.isOk()).toBe(true)
  })

  it('patternTooMany past the limit', () => {
    const many = resolvePattern(
      port,
      def({ cell: [circle(1)], spacing: { gap: 0.5 }, margin: 0 }),
      (d) => resolveDefinition(port, d),
    )
    const e = expectErrCode(many, 'model.invariant')
    expect(e.issues[0]!.rule).toBe('patternTooMany')
    expect(e.issues[0]!.params).toEqual({ max: PATTERN_CELLS_MAX })
  })

  it('patternCellOpen: an open path is no cell', () => {
    const open: ShapeItem<number> = {
      kind: 'path',
      op: 'add',
      start: [0, 0],
      segments: [{ kind: 'line', to: [5, 0] }],
      closed: false,
    }
    const e = expectErrCode(
      resolvePattern(port, def({ cell: [open] }), (d) => resolveDefinition(port, d)),
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['cell'], rule: 'patternCellOpen' })
  })

  it('positive gap', () => {
    const e = expectErrCode(
      resolvePattern(port, def({ spacing: { gap: 0 } }), (d) => resolveDefinition(port, d)),
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['spacing', 'gap'], rule: 'positive' })
  })
})

describe('through resolveDefinition', () => {
  it('a pattern definition resolves to its pieces, frame and cell count', () => {
    const r = resolveDefinition(port, [def()]).unwrap()
    expect(r.kind).toBe('region')
    if (r.kind !== 'region') return
    expect(r.cells).toBe(45)
    expect(r.frame).toEqual({ min: [0, 0], max: [100, 60] })
  })

  it('2 000 cells resolve in well under a second (no boolean, S8 finding 2)', () => {
    const t = performance.now()
    const r = resolvePattern(
      port,
      def({
        cell: [circle(1)],
        lattice: 'hex',
        spacing: { gap: 0.85 },
        margin: 1,
        boundary: { min: [0, 0], max: [100, 60] },
      }),
      (d) => resolveDefinition(port, d),
    ).unwrap()
    expect(r.cells).toBeGreaterThan(1500)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
