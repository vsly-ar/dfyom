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
    expect(expectOk(partGeometryInput(s.d.doc, s.partId))).toEqual({ ...testPart(), references })
  })

  it('lists `on` and each formula reference once per operation and parameter (dfm.surfaceMissing)', async () => {
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
  })

  it('an evaluation of a part whose references all exist reports no dfm.surfaceMissing', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    const input = expectOk(partGeometryInput(s.d.doc, s.partId))
    const e = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
    expect(e.warnings.filter((w) => w.code === 'dfm.surfaceMissing')).toEqual([])
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
})
