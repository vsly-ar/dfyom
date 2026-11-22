// Plans of parts with named shapes (v0.3 K3): the toolpath input hash covers the shape
// definition, and general shapes map to the region generators (T1/T2 wiring).
// Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/plan-v0.3.md#wiring-t1-t2
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { toGeneratorInputs } from '../toolpath/inputs'
import { planOperationInputs } from './inputs'
import { planSetup } from './plan.fixture'

const region2d = nodeRegion2d()

describe('plans with named shapes', () => {
  it('hash the shape definition; general shapes go to the region generator', async () => {
    const s = await planSetup({ services: { region2d } })
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'rectangle', center: ['0', '0'], length: '20', width: '10' }],
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], rotation: '15' },
      depth: '2',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const ops = s.plan(planId).setups[0]!.operations
    for (const op of ops.filter((o) => o.designOperationIds[0]!.startsWith('drill')))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
    const named = (doc: typeof s.d.doc) =>
      expectOk(planOperationInputs(doc, planId)).find((i) =>
        i.operations.some((o) => o.id === 'pocket2'),
      )!
    const input = named(s.d.doc)
    // the plan's design snapshot carries the shape: a changed definition changes the hash
    const doc = structuredClone(s.d.doc)
    const item = doc.plans[planId]!.design.part.shapes![0]!.items[0]!
    if (item.kind !== 'rectangle') throw new Error('rectangle expected')
    item.length = { ...item.length, source: '30' }
    expect(named(doc).inputHash).not.toBe(input.inputHash)
    expect(expectOk(toGeneratorInputs(input, region2d)).kind).toBe('regionPocket')
  })
})
