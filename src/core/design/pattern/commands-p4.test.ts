// The pattern feature P4 through its commands. Stacking (Q127): a pattern `on` another pattern's
// pocket floor is bounded by that pattern's cleared region less the margin (the record's
// `floor`), follows edits of the lower pattern, is narrowed by its own boundary shape, and stands
// on the web of an inverted lower pattern. Through (Q126): the owned pocket becomes a through
// pocket (depth = the material below `on`, no floor target, no floor in the solid), refused with
// `invert` and for cells with islands; turning it off restores the depth; one undo step.
// Spec: docs/modes/patterns.md#implementation-p4
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionArea, type Region } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../geometry/evaluate'
import { loadManifold } from '../../geometry/manifold'
import type { SolidKernel } from '../../geometry/solid-port'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })
let kernel: SolidKernel
beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

interface Result {
  featureId: string
  operationIds: string[]
  cells?: number
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, featureId: string, args: object) =>
  (await s.run('design.pattern.update', { partId: s.partId, featureId, ...args })) as Result

const regionOf = (s: DesignSetup, id: string): Region => {
  const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = g.operations.find((o) => o.id === id)!
  if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
  return op.shape.contour.region
}

/** Area of `a` outside `b` (mm²). */
const outside = (a: Region, b: Region) => regionArea(expectOk(region2d.difference(a, b)))

/** The grid: 20 × 20 R 2 squares, gap 4, 2 mm deep on the test block's top (100 × 60 × 20). */
const GRID = {
  lattice: 'square',
  cell: { kind: 'rectangle', length: '20', width: '20', cornerRadius: '2' },
  spacing: { gap: '4' },
  margin: '4',
  depth: '2',
}
/** The lace: Ø 2 circles, hex, gap 1, 1 mm margin, 1 mm below the grid's floor. */
const LACE = {
  on: 'pattern1_pocket.floor',
  lattice: 'hex',
  cell: { kind: 'circle', diameter: '2' },
  spacing: { gap: '1' },
  margin: '1',
  depth: '1',
}

describe('stacking (P4, Q127)', () => {
  it("a pattern on another's floor lies only inside its cells less the margin", async () => {
    const s = await setup()
    const grid = await add(s, GRID)
    expect(grid.cells).toBe(3)
    const lace = await add(s, LACE)
    expect(lace.featureId).toBe('pattern2')
    expect(s.part().shapes?.find((x) => x.id === 'pattern2_cells')?.pattern).toMatchObject({
      floor: 'pattern1_cells',
    })
    const below = regionOf(s, 'pattern1_pocket')
    const cells = regionOf(s, 'pattern2_pocket')
    expect(lace.cells).toBe(cells.pieces.length)
    expect(lace.cells).toBeGreaterThan(3 * 20)
    // every lace cell inside a grid cell shrunk by the margin
    const shrunk = expectOk(region2d.offset(below, 1))
    expect(outside(cells, shrunk)).toBeLessThan(1e-6)
    // on the stock top the same lace covers the whole face
    const flat = await add(s, { ...LACE, on: 'stock.top' })
    expect(flat.cells).toBeGreaterThan(2 * lace.cells!)
    expect(s.part().shapes?.find((x) => x.id === 'pattern3_cells')?.pattern).not.toHaveProperty(
      'floor',
    )
  })

  it('follows edits of the lower pattern; undo restores', async () => {
    const s = await setup()
    await add(s, GRID)
    const lace = await add(s, LACE)
    // a wider gap leaves one grid cell
    expect((await update(s, 'pattern1', { spacing: { gap: '30' } })).cells).toBe(1)
    const smaller = regionOf(s, 'pattern2_pocket').pieces.length
    expect(smaller).toBeLessThan(lace.cells!)
    expect(outside(regionOf(s, 'pattern2_pocket'), regionOf(s, 'pattern1_pocket'))).toBeLessThan(
      1e-6,
    )
    await s.undo()
    expect(regionOf(s, 'pattern2_pocket').pieces).toHaveLength(lace.cells!)
  })

  it('its own boundary shape narrows the stack; an inverted lower pattern gives its web', async () => {
    const s = await setup()
    await add(s, GRID)
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'rectangle', center: ['0', '0'], length: '40', width: '60' }],
    })
    const all = (await add(s, LACE)).cells!
    const narrowed = await update(s, 'pattern2', {
      boundary: { shapeId: 'shape1', center: ['20', '30'] },
    })
    expect(narrowed.cells).toBeGreaterThan(0)
    expect(narrowed.cells).toBeLessThan(all)
    for (const p of regionOf(s, 'pattern2_pocket').pieces)
      for (const e of p.outer.elements) expect(e.a[0]).toBeLessThan(40 + 1e-6)

    // inverted grid: the lace stands on the web between the squares
    await update(s, 'pattern2', { boundary: null })
    await update(s, 'pattern1', { invert: true })
    const web = regionOf(s, 'pattern1_pocket')
    const lace = regionOf(s, 'pattern2_pocket')
    expect(lace.pieces.length).toBeGreaterThan(0)
    expect(outside(lace, expectOk(region2d.offset(web, 1)))).toBeLessThan(1e-6)
  })
})

describe('through (P4, Q126)', () => {
  it('a through pocket: depth = the stock below on, no floor target, no floor', async () => {
    const s = await setup()
    const out = await add(s, {
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '3' },
      depth: '3',
      through: true,
    })
    expect(s.part().features?.[0]).toMatchObject({ through: true, depth: { source: '3' } })
    const pocket = s.op('pattern1_pocket') as Record<string, unknown>
    expect(pocket).toMatchObject({ through: true, depth: { source: '20 mm' } })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    expect(g.operations[0]).toMatchObject({ kind: 'pocket', depth: 20, through: true })

    // every cell cleared through, no slug: the removed volume is twice that of the same cells
    // 10 mm deep (the same chords), so each removal reaches past the bottom with no floor
    const cells = regionOf(s, 'pattern1_pocket')
    expect(cells.pieces).toHaveLength(out.cells!)
    const removed = (input: typeof g) =>
      100 * 60 * 20 -
      kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap().volume
    const half = removed({
      ...g,
      operations: g.operations.map((o) =>
        o.kind === 'pocket'
          ? { kind: o.kind, id: o.id, onZ: o.onZ, shape: o.shape, depth: 10, floorRadius: 0 }
          : o,
      ),
    })
    expect(half / (regionArea(cells) * 10)).toBeCloseTo(1, 1)
    expect(removed(g) / (2 * half)).toBeCloseTo(1, 9)

    // nothing stands on a through pocket's floor
    const e = await s.fail(
      'design.pattern.add',
      { partId: s.partId, on: 'pattern1_pocket.floor' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('onSurface')

    // off: the stored depth again; undo turns it back on
    await update(s, 'pattern1', { through: false })
    expect(s.op('pattern1_pocket')).toMatchObject({ depth: { source: '3' } })
    expect(s.op('pattern1_pocket')).not.toHaveProperty('through')
    expect(s.part().features?.[0]).not.toHaveProperty('through')
    await s.undo()
    expect(s.op('pattern1_pocket')).toMatchObject({ through: true })
  })

  it('refused with invert, and for a cell with an island', async () => {
    const s = await setup()
    await add(s, { cell: { kind: 'circle', diameter: '6' }, through: true })
    const inv = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', invert: true },
      'model.invariant',
    )
    expect(inv.issues).toContainEqual(
      expect.objectContaining({ path: ['invert'], rule: 'patternThroughInvert' }),
    )
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        { kind: 'circle', center: ['0', '0'], diameter: '10' },
        { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '4' },
      ],
    })
    const ring = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', cell: { kind: 'shape', shapeId: 'shape1' } },
      'model.invariant',
    )
    expect(ring.issues).toContainEqual(
      expect.objectContaining({ path: ['cell'], rule: 'patternThroughIslands' }),
    )
    // blind, the ring is fine
    await update(s, 'pattern1', { through: false, cell: { kind: 'shape', shapeId: 'shape1' } })
  })
})
