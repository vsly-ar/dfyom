import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import type { SolidKernel } from '../geometry/solid-port'
import {
  TEST_PART_SURFACES,
  testPart,
  testPartChordBound,
  testPartVolume,
} from '../geometry/testing/test-part'
import { buildTestPart, designSetup } from './design.fixture'
import { partGeometryInput } from './load'

let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

describe('design → geometry input', () => {
  it('maps the geometry test part built through the design commands exactly', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    // every pocket and drilling starts on the default `on`, the facing floor
    const references = ['pocket1', 'drill1', 'drill2', 'drill3', 'drill4'].map((operation) => ({
      operation,
      parameter: 'on',
      surface: 'facing1.floor',
    }))
    expect(expectOk(partGeometryInput(s.d.doc, s.partId))).toEqual({
      ...testPart(),
      references,
      dependants: { 'facing1.floor': references.map((r) => r.operation) },
    })
  })

  it('lists `on` and each formula reference once per operation and parameter, with dependants (dfm.surfaceCutAway)', async () => {
    const s = await designSetup()
    const partId = s.partId
    await s.run('design.facing.add', { partId })
    await s.run('design.pocket.add', {
      partId,
      on: 'stock.top',
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20' },
      depth: '-facing1.floor.z + 2',
    })
    await s.run('design.drilling.add', {
      partId,
      on: 'pocket1.floor',
      center: ['50', '30'],
      diameter: '4',
      bottom: 'flat',
      depth: 'pocket1.floor.z.max - pocket1.floor.z - stock.bottom.z / 10',
    })
    expect(expectOk(partGeometryInput(s.d.doc, s.partId)).references).toEqual([
      { operation: 'pocket1', parameter: 'on', surface: 'stock.top' },
      { operation: 'pocket1', parameter: 'depth', surface: 'facing1.floor' },
      { operation: 'drill1', parameter: 'on', surface: 'pocket1.floor' },
      { operation: 'drill1', parameter: 'depth', surface: 'pocket1.floor' },
      { operation: 'drill1', parameter: 'depth', surface: 'stock.bottom' },
    ])
    // the drilling depends on the pocket, so it is a dependant of every surface the pocket uses
    expect(expectOk(partGeometryInput(s.d.doc, s.partId)).dependants).toEqual({
      'stock.top': ['pocket1', 'drill1'],
      'facing1.floor': ['pocket1', 'drill1'],
      'pocket1.floor': ['drill1'],
      'stock.bottom': ['drill1'],
    })
  })

  it('an evaluation of a part whose referenced surfaces all keep triangles has no construction surfaces', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    const input = expectOk(partGeometryInput(s.d.doc, s.partId))
    const e = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
    expect(e.warnings.filter((w) => w.code === 'dfm.surfaceCutAway')).toEqual([])
    expect(e.construction).toEqual([])
  })

  it('evaluates it: every surface id, volume within the chord-error bound', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    const input = expectOk(partGeometryInput(s.d.doc, s.partId))
    const e = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
    for (const id of TEST_PART_SURFACES) expect(e.surfaces, id).toContain(id)
    const exact = testPartVolume()
    expect(e.volume).toBeGreaterThanOrEqual(exact)
    expect(e.volume - exact).toBeLessThanOrEqual(testPartChordBound())
    expect(kernel.liveObjects()).toBe(0)
  })

  it('maps inch values to canonical mm and `on` to the analytic z', async () => {
    const s = await designSetup({ units: 'inch' })
    await s.run('design.facing.add', { partId: s.partId }) // 1/64" = 0.396875 mm
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['1', '1/2'],
      diameter: '1/4',
      bottom: 'flat',
      depth: '0.1',
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['2', '1'], diameter: '1' },
      depth: '1/8',
    })
    expect(expectOk(partGeometryInput(s.d.doc, s.partId)).operations).toEqual([
      { kind: 'facing', id: 'facing1', depth: 0.396875 },
      {
        kind: 'drilling',
        id: 'drill1',
        onZ: -0.396875,
        center: [25.4, 12.7],
        diameter: 6.35,
        bottom: { kind: 'flat', depth: 2.54 },
      },
      {
        kind: 'pocket',
        id: 'pocket1',
        onZ: -0.396875,
        shape: { center: [50.8, 25.4], contour: { kind: 'circle', radius: 12.7 } },
        depth: 3.175,
        floorRadius: 0,
      },
    ])
  })

  it('groups each Clones source operation with its instances (clone layers): same part as ungrouped', async () => {
    const s = await designSetup()
    const partId = s.partId
    await s.run('design.facing.add', { partId, depth: '0.5' })
    await s.run('design.hole.add', {
      partId,
      center: ['15', '15'],
      fastener: 'M3',
      type: 'counterbore',
    })
    await s.run('design.clones.add', {
      partId,
      source: { featureId: 'hole1' },
      rows: [{ kind: 'grid', du: '20', dv: '15', cols: 4, rows: 3 }],
    })
    await s.run('design.pocket.add', {
      partId,
      shape: { kind: 'rectangle', center: ['90', '30'], length: '10', width: '40' },
      depth: '2',
    })
    const input = expectOk(partGeometryInput(s.d.doc, partId))
    const instances = (step: string) =>
      Array.from({ length: 11 }, (_, i) => `clones1_${i + 2}_hole1_${step}`)
    expect(input.cloneGroups).toEqual([
      ['hole1_counterbore', ...instances('counterbore')],
      ['hole1_drill', ...instances('drill')],
    ])
    const { cloneGroups: _, ...plain } = input
    const evaluate = (i: typeof input) =>
      expectOk(kernel.withSolids((solids) => evaluatePart(i, solids)))
    const grouped = evaluate(input)
    const ungrouped = evaluate(plain)
    expect(grouped.volume).toBeCloseTo(ungrouped.volume, 6)
    expect(grouped.stats.triangles).toBe(ungrouped.stats.triangles)
    expect(grouped.surfaces).toEqual(ungrouped.surfaces)
    expect(grouped.warnings).toEqual(ungrouped.warnings)
  })

  it('leaves `cloneGroups` out without Clones (inputs byte-identical)', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    expect(expectOk(partGeometryInput(s.d.doc, s.partId))).not.toHaveProperty('cloneGroups')
  })
})
