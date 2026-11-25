// The pattern feature P5 through its commands. `alternate: flip` is stored only when set, its
// record carries it, and a preset resets it. The chamfer's `side` (bottom, both) adds the owned
// `<id>_bottomChamfer` round the through cells' bottom edges on the opposite stock face (edge-
// chamfers.md E4b's bottom chamfer of a through pocket), mirrored into that face's frame, lofted
// cell by cell as the top one, with its own `dfm.chamferMeets`; refused without through or off a
// stock face; one undo step.
// Spec: docs/modes/patterns.md#implementation-p5
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { chainBounds } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { loopChamferPieces } from '../../geometry/chamfer-solids'
import { loadManifold } from '../../geometry/manifold'
import { isLoopChamfer } from '../../geometry/model'
import type { SolidKernel } from '../../geometry/solid-port'
import { designSetup, type DesignSetup } from '../design.fixture'
import { loadPart, partGeometryInput } from '../load'
import { bottomEdgeFace } from '../operation'
import { PATTERN_PRESETS } from './presets'

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
  warnings: {
    code: string
    operation: string
    parameter?: string
    params: Record<string, unknown>
  }[]
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...args,
  })) as Result
const ops = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const loaded = (s: DesignSetup) => {
  const l = expectOk(loadPart(s.d.doc, s.partId, 'test'))
  return { operations: l.part.operations, stock: l.stock }
}

const TRIANGLES = {
  lattice: 'square',
  cell: { kind: 'polygon', sides: '3', diameter: '12', across: 'corners', cornerRadius: '1' },
  spacing: { gap: '2' },
}

describe('alternate: flip (P5)', () => {
  it('stored only when flipped, carried by the record; more cells nest; a preset resets it', async () => {
    const s = await setup()
    const plain = await add(s, TRIANGLES)
    expect(s.part().features?.[0]).not.toHaveProperty('alternate')
    const flipped = await update(s, { alternate: 'flip' })
    expect(s.part().features?.[0]).toMatchObject({ alternate: 'flip' })
    expect(s.part().shapes?.find((x) => x.id === 'pattern1_cells')?.pattern).toMatchObject({
      alternate: 'flip',
    })
    // nested, about twice as many triangles fit
    expect(flipped.cells!).toBeGreaterThan(1.4 * plain.cells!)
    await s.undo()
    expect(s.part().features?.[0]).not.toHaveProperty('alternate')
    await s.redo()

    const honeycomb = PATTERN_PRESETS.find((p) => p.id === 'honeycomb')!
    await update(s, honeycomb.args)
    expect(s.part().features?.[0]).not.toHaveProperty('alternate')
    const triangles = PATTERN_PRESETS.find((p) => p.id === 'triangles')!
    const t = await update(s, triangles.args)
    expect(s.part().features?.[0]).toMatchObject({ alternate: 'flip', lattice: 'square' })
    expect(t.cells).toBeGreaterThan(20)
    expect(t.warnings.filter((w) => w.code === 'dfm.patternThinWeb')).toEqual([])
  })
})

describe('the bottom chamfer of through cells (P5)', () => {
  it('bottomEdgeFace: a through pocket has one, a blind pocket none', async () => {
    const s = await setup()
    await add(s, { cell: { kind: 'circle', diameter: '6' }, through: true })
    expect(bottomEdgeFace(loaded(s).operations.find((o) => o.id === 'pattern1_pocket'))).toBe(
      'stock.bottom',
    )
    await update(s, { through: false })
    expect(
      bottomEdgeFace(loaded(s).operations.find((o) => o.id === 'pattern1_pocket')),
    ).toBeUndefined()
  })

  it('side bottom and both add <id>_bottomChamfer on the opposite face; top removes it', async () => {
    const s = await setup()
    await add(s, { cell: { kind: 'circle', diameter: '6' }, through: true })
    await update(s, { chamfer: { side: 'both' } })
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_chamfer', 'pattern1_bottomChamfer'])
    expect(s.op('pattern1_bottomChamfer')).toMatchObject({
      kind: 'chamfer',
      on: 'stock.bottom',
      edgeOf: 'pattern1_pocket',
      featureRole: 'bottomChamfer',
      width: { source: '0.5 mm' },
    })
    expect(s.op('pattern1_chamfer')).toMatchObject({ on: 'stock.top' })
    expect(s.part().features?.[0]).toMatchObject({ chamfer: { side: 'both' } })
    // a width edit moves both; side bottom drops the top one
    await update(s, { chamfer: { width: '0.8' } })
    expect(s.op('pattern1_bottomChamfer')).toMatchObject({ width: { source: '0.8' } })
    await update(s, { chamfer: { side: 'bottom' } })
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_bottomChamfer'])
    await update(s, { chamfer: { side: 'top' } })
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_chamfer'])
    expect(s.part().features?.[0]).toMatchObject({ chamfer: { width: { source: '0.8' } } })
    expect((s.part().features?.[0] as unknown as { chamfer: object }).chamfer).not.toHaveProperty(
      'side',
    )
    await s.undo()
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_bottomChamfer'])
  })

  it('refused without through and off a stock face', async () => {
    const s = await setup()
    await add(s, { cell: { kind: 'circle', diameter: '6' } })
    const blind = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', chamfer: { side: 'bottom' } },
      'model.invariant',
    )
    expect(blind.issues).toContainEqual(
      expect.objectContaining({ path: ['chamfer', 'side'], rule: 'patternChamferBottom' }),
    )
    // a through pattern stacked on a blind one stands on a floor, not a stock face
    await update(s, { lattice: 'square', cell: { kind: 'rectangle', length: '30', width: '30' } })
    await add(s, { on: 'pattern1_pocket.floor', cell: { kind: 'circle', diameter: '3' } })
    const stacked = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern2', through: true, chamfer: { side: 'both' } },
      'model.invariant',
    )
    expect(stacked.issues).toContainEqual(
      expect.objectContaining({ path: ['chamfer', 'side'], rule: 'patternChamferBottom' }),
    )
    // on the stock top, through and the bottom side go together; through off is refused then
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'pattern2' })
    await update(s, { through: true, chamfer: { side: 'both' } })
    const off = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', through: false },
      'model.invariant',
    )
    expect(off.issues.map((i) => i.rule)).toContain('patternChamferBottom')
  })

  it('the geometry input: the cells mirrored into the bottom face, lofted cell by cell', async () => {
    const s = await setup()
    // an off-centre origin makes the mirror visible: the cells' box moves to W − v below
    await add(s, {
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '3' },
      origin: ['20', '10'],
      through: true,
      chamfer: { width: '0.5', side: 'both' },
    })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const top = g.operations.find((o) => o.id === 'pattern1_chamfer')!
    const bottom = g.operations.find((o) => o.id === 'pattern1_bottomChamfer')!
    if (!(top.kind === 'chamfer' && isLoopChamfer(top))) throw new Error('no top chamfer')
    if (!(bottom.kind === 'chamfer' && isLoopChamfer(bottom))) throw new Error('no bottom chamfer')
    expect(bottom.edge.pattern).toBe(true)
    expect(bottom.edge).not.toHaveProperty('depth')
    const box = (c: typeof top) => {
      if (c.edge.shape.contour.kind !== 'region') throw new Error('no region')
      const b = chainBounds(c.edge.shape.contour.region.pieces.flatMap((p) => p.outer.elements))!
      const [u, v] = c.edge.shape.center
      return {
        min: [b.min[0] + u, b.min[1] + v] as const,
        max: [b.max[0] + u, b.max[1] + v] as const,
      }
    }
    const width = loaded(s).stock.width.canonical
    // top → bottom maps (u, v) to (u, W − v): the cells' box mirrored about the stock's middle
    const [t, b] = [box(top), box(bottom)]
    expect(b.min[0]).toBeCloseTo(t.min[0], 6)
    expect(b.min[1]).toBeCloseTo(width - t.max[1], 6)
    const stats = loopChamferPieces(bottom, {
      region2d,
      triangulate: (r) => kernel.withSolids((x) => x.triangulate(r)),
    })
    expect(stats).toMatchObject({ fallback: 0, groups: 1, meshes: 1 })
  })

  it('bevels meeting: each owned chamfer has its own chamferMeets', async () => {
    const s = await setup()
    const out = await add(s, {
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '1.5' },
      through: true,
      chamfer: { width: '1', side: 'both' },
    })
    const meets = out.warnings.filter((w) => w.code === 'dfm.chamferMeets')
    expect(meets.map((w) => w.operation).sort()).toEqual([
      'pattern1_bottomChamfer',
      'pattern1_chamfer',
    ])
    for (const m of meets) expect(m.params['wall']).toBeCloseTo(1.5, 2)
    // the marker read on the bottom face: mirrored
    const width = loaded(s).stock.width.canonical
    const [top, bottom] = ['pattern1_chamfer', 'pattern1_bottomChamfer'].map(
      (id) => meets.find((m) => m.operation === id)!.params['at'] as [number, number],
    )
    expect(bottom![0]).toBeCloseTo(top![0]!, 6)
    expect(bottom![1]).toBeCloseTo(width - top![1]!, 6)
  })
})
