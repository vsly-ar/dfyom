// The pattern feature P3 through its commands: the chamfer arg adds, updates and removes the owned
// edge chamfer `<id>_chamfer` on the owned pocket (defaults 0.5 mm × 90°, its own tool field, one
// undo step), refusals reported at the feature's chamfer fields, and bevels meeting on a web give
// one `dfm.chamferMeets` (the owned chamfer's E3 finding, shown at Chamfer width) with the narrowest web and a suggested width.
// Spec: docs/modes/patterns.md#implementation-p3
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { loopChamferPieces } from '../../geometry/chamfer-solids'
import { loadManifold } from '../../geometry/manifold'
import { isLoopChamfer } from '../../geometry/model'
import type { SolidKernel } from '../../geometry/solid-port'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import { patternSpec } from './pattern'

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
    severity: string
    operation: string
    parameter?: string
    params: Record<string, unknown>
    suggestion?: unknown
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

describe('the chamfer on a pattern (P3)', () => {
  it('off by default; on with the defaults; updated; removed; one undo step each', async () => {
    const s = await setup()
    const out = await add(s, { cell: { kind: 'circle', diameter: '6' } })
    expect(out.operationIds).toEqual(['pattern1_pocket'])
    expect(s.part().features?.[0]).not.toHaveProperty('chamfer')

    const on = await update(s, { chamfer: {} })
    expect(on.operationIds).toEqual(['pattern1_pocket', 'pattern1_chamfer'])
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_chamfer'])
    const ch = s.op('pattern1_chamfer') as Record<string, unknown>
    expect(ch).toMatchObject({
      kind: 'chamfer',
      edgeOf: 'pattern1_pocket',
      featureId: 'pattern1',
      featureRole: 'chamfer',
      width: { source: '0.5 mm' },
      angle: { source: '90°' },
    })
    expect(s.part().features?.[0]).toMatchObject({
      chamfer: { width: { source: '0.5 mm' }, angle: { source: '90°' } },
    })

    // a field not given keeps its value
    await update(s, { chamfer: { width: '0.8' } })
    expect(s.op('pattern1_chamfer')).toMatchObject({
      width: { source: '0.8' },
      angle: { source: '90°' },
    })
    await update(s, { chamfer: { angle: '60' } })
    expect(s.op('pattern1_chamfer')).toMatchObject({
      width: { source: '0.8' },
      angle: { source: '60' },
    })
    // other edits keep the chamfer
    await update(s, { depth: '2' })
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_chamfer'])

    await update(s, { chamfer: null })
    expect(ops(s)).toEqual(['pattern1_pocket'])
    expect(s.part().features?.[0]).not.toHaveProperty('chamfer')
    await s.undo()
    expect(ops(s)).toEqual(['pattern1_pocket', 'pattern1_chamfer'])
  })

  it('the geometry input: a loop chamfer on the cells, lofted cell by cell', async () => {
    const s = await setup()
    await add(s, {
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '3' },
      chamfer: { width: '0.5' },
    })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const c = g.operations.find((o) => o.id === 'pattern1_chamfer')!
    if (c.kind !== 'chamfer' || !isLoopChamfer(c)) throw new Error('no loop chamfer')
    const pocket = g.operations.find((o) => o.id === 'pattern1_pocket')!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const cells = pocket.shape.contour.region.pieces.length
    expect(cells).toBeGreaterThan(20)
    const stats = loopChamferPieces(c, {
      region2d,
      triangulate: (r) => kernel.withSolids((x) => x.triangulate(r)),
    })
    // every cell lofted from one distinct piece, all apart: one mesh
    expect(stats).toEqual({ lofted: cells, fallback: 0, meshes: 1, groups: 1 })
  })

  it('refusals at the chamfer fields; the owned chamfer takes its own tool', async () => {
    const s = await setup()
    await add(s, { cell: { kind: 'circle', diameter: '6' } })
    const e = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', chamfer: { width: '0' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toContain('chamfer.width')
    const a = await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', chamfer: { angle: '20' } },
      'model.invariant',
    )
    expect(a.issues.map((i) => i.path.join('.'))).toContain('chamfer.angle')
  })

  it('bevels meeting on a web: one chamferMeets at Chamfer width, with the web and a width', async () => {
    const s = await setup()
    const out = await add(s, {
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '1.5' },
      chamfer: { width: '1' },
    })
    const meets = out.warnings.filter((w) => w.code === 'dfm.chamferMeets')
    expect(meets).toHaveLength(1)
    // the owned chamfer's finding, shown at the feature's Chamfer width (fieldOf)
    expect(meets[0]).toMatchObject({ operation: 'pattern1_chamfer', parameter: 'width' })
    expect(patternSpec.fieldOf!('chamfer', ['width'])).toEqual(['chamfer', 'width'])
    expect(meets[0]!.params['wall']).toBeCloseTo(1.5, 2)
    expect(meets[0]!.suggestion).toEqual({ relation: 'atMost', value: 0.75 })
    // apart: none
    const apart = await update(s, { chamfer: { width: '0.5' } })
    expect(apart.warnings.filter((w) => w.code === 'dfm.chamferMeets')).toEqual([])
  })

  it('inverted: bevels meeting across an island give the island width', async () => {
    const s = await setup()
    const out = await add(s, {
      cell: { kind: 'circle', diameter: '3' },
      spacing: { gap: '4' },
      invert: true,
      chamfer: { width: '2' },
    })
    const meets = out.warnings.filter((w) => w.code === 'dfm.chamferMeets')
    expect(meets).toHaveLength(1)
    expect(meets[0]!.params['wall']).toBeCloseTo(3, 1)
    expect(meets[0]!.suggestion).toMatchObject({ relation: 'atMost' })
  })
})
