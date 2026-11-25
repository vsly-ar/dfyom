// A pattern's cells, P5: `alternate: flip` (every other cell turned 180°, triangles nesting with
// pitches bisected to the gap), the thin web between flipped neighbours, and the ghosts (cells
// left out at the border) the viewport draws.
// Spec: docs/modes/patterns.md#implementation-p5
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../../shared/testing/result'
import { chainBounds, regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { resolveDefinition } from '../shape'
import type { ShapeItem } from '../shape.dto'
import { resolvePattern, type PatternDefinition } from './layout'

const port = nodeRegion2d()
/** An equilateral triangle Ø 12 across its corners, a flat side at the bottom: side 6√3, height 9. */
const TRIANGLE: ShapeItem<number> = {
  kind: 'polygon',
  op: 'add',
  center: [0, 0],
  sides: 3,
  diameter: 12,
  across: 'corners',
  cornerRadius: 0,
}
const SIDE = 6 * Math.sqrt(3)
const HEIGHT = 9

const def = (over: Partial<PatternDefinition> = {}): PatternDefinition => ({
  kind: 'pattern',
  op: 'add',
  cell: [TRIANGLE],
  cellRotation: 0,
  lattice: 'square',
  angle: 0,
  spacing: { gap: 2 },
  alternate: 'flip',
  boundary: { min: [0, 0], max: [100, 60] },
  margin: 3,
  ...over,
})
const resolve = (over: Partial<PatternDefinition> = {}) =>
  resolvePattern(port, def(over), (d) => resolveDefinition(port, d))
const cells = (over: Partial<PatternDefinition> = {}) => resolve(over).unwrap()

/** Whether the piece points up: its lowest point is a side (wide), not a corner. */
function pointsUp(r: Region, i: number): boolean {
  const els = r.pieces[i]!.outer.elements
  const b = chainBounds(els)!
  const low = els.filter((e) => Math.abs(e.a[1] - b.min[1]) < 1e-6).map((e) => e.a[0])
  return Math.max(...low) - Math.min(...low) > 1
}

/** The narrowest web between the region's pieces, to 0.01 mm (they merge when grown by half). */
function narrowestWeb(r: Region): number {
  let lo = 0
  let hi = 4
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2
    const grown = port.offset(r, -mid / 2).unwrap()
    if (grown.pieces.length < r.pieces.length) hi = mid
    else lo = mid
  }
  return lo
}

describe('alternate: flip', () => {
  it('nests triangles: pitches s/2 + 2g/√3 along the rows and h + g between them', () => {
    const p = cells()
    // to the 2D port's precision (≈ 0.1 µm per boolean)
    expect(p.pitch[0]).toBeCloseTo(SIDE / 2 + 4 / Math.sqrt(3), 3)
    expect(p.pitch[1]).toBeCloseTo(HEIGHT + 2, 3)
    expect(p.cells).toBeGreaterThan(40)
    expect(p.region.pieces).toHaveLength(p.cells)
  })

  it('turns every other cell, along rows and between rows', () => {
    const p = cells({ margin: 0 })
    const centres = p.region.pieces.map((x) => {
      const b = chainBounds(x.outer.elements)!
      return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] as const
    })
    const at = (u: number, v: number) =>
      centres.findIndex((c) => Math.abs(c[0] - u) < 1e-6 && Math.abs(c[1] - v) < 1e-6)
    const [a, b] = p.pitch
    // the origin's node (the area's centre) is not flipped; its neighbours are
    const o = at(50, 30)
    expect(o).toBeGreaterThanOrEqual(0)
    expect(pointsUp(p.region, o)).toBe(true)
    expect(pointsUp(p.region, at(50 + a, 30))).toBe(false)
    expect(pointsUp(p.region, at(50, 30 + b))).toBe(false)
    expect(pointsUp(p.region, at(50 + a, 30 + b))).toBe(true)
  })

  it('keeps the gap as the narrowest web, exactly', () => {
    expect(narrowestWeb(cells().region)).toBeCloseTo(2, 1)
    expect(narrowestWeb(cells({ spacing: { gap: 1.2 } }).region)).toBeCloseTo(1.2, 1)
  })

  it('works on staggered and hex rows and on a turned lattice (no overlap, the gap kept)', () => {
    for (const over of [
      { lattice: 'staggered' as const },
      { lattice: 'hex' as const },
      { angle: 30 },
    ]) {
      const p = cells(over)
      expect(p.cells).toBeGreaterThan(20)
      expect(narrowestWeb(p.region)).toBeGreaterThan(1.95)
    }
  })

  it('refuses a pitch that makes flipped cells overlap; a polar ring alternates', () => {
    expectErrCode(resolve({ spacing: { pitch: [SIDE / 2, HEIGHT + 1] } }), 'model.invariant')
    expect(cells({ spacing: { pitch: [SIDE / 2 + 2, HEIGHT + 2] } }).cells).toBeGreaterThan(20)
    const polar = cells({ lattice: 'polar', margin: 0 })
    const ups = polar.region.pieces.filter((_, i) => pointsUp(polar.region, i)).length
    expect(ups).toBeGreaterThan(0)
    expect(ups).toBeLessThan(polar.cells)
  })

  it('finds a thin web between flipped neighbours (dfm.patternThinWeb)', () => {
    const p = cells({ spacing: { gap: 0.6 } })
    expect(p.web?.width).toBeCloseTo(0.6, 1)
    expect(p.web?.island).toBe(false)
    expect(cells().web).toBeUndefined()
  })

  it('inverted: the area less every cell, flipped ones included', () => {
    const p = cells({ invert: true })
    const plain = cells()
    expect(p.cells).toBe(plain.cells)
    // the margin rectangle's corners are rounded R 0.5 (P2)
    const corners = (4 - Math.PI) * 0.25
    expect(regionArea(p.region)).toBeCloseTo(
      regionArea(p.area) - corners - regionArea(plain.region),
      3,
    )
  })
})

describe('ghosts', () => {
  it('are the cells crossing the area (whole), none of them cut', () => {
    const p = cells()
    const g = p.ghosts!
    expect(g.pieces.length).toBeGreaterThan(0)
    for (const piece of g.pieces) {
      const b = chainBounds(piece.outer.elements)!
      const inside = b.min[0] >= 3 && b.max[0] <= 97 && b.min[1] >= 3 && b.max[1] <= 57
      expect(inside).toBe(false)
    }
    // ghosts and cells never overlap
    const both = port.intersect(g, p.region).unwrap()
    expect(regionArea(both)).toBeCloseTo(0, 6)
  })

  it('with clip, the cells cut or dropped as slivers', () => {
    const p = cells({ fit: 'clip', margin: 2.5 })
    const whole = cells({ margin: 2.5 })
    expect(p.cells).toBeGreaterThan(whole.cells)
    expect(p.ghosts!.pieces.length).toBe(p.cells - whole.cells + p.dropped)
  })
})
