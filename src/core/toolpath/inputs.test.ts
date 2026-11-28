// Spec: docs/architecture/workers.md#plan-operation-to-generator-input
import { describe, expect, it } from 'vitest'
import { None, Some } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import type { Tool } from '../library/tool'
import { planOperationInputs, type PlanOperationInput } from '../plan/inputs'
import { planSetup } from '../plan/plan.fixture'
import { generateDrilling } from './drilling'
import { nearestNeighbourOrder, toGeneratorInputs, toolpathTool } from './inputs'
import {
  generateRequest,
  GeneratorRequestSchema,
  type GeneratorRequest,
  type SingleRequest,
} from './request'
import { toolpathStats } from './stats'

/** The test part's plan with every input resolvable (the 6 mm drill has no data: overrides). */
async function resolvedInputs(): Promise<PlanOperationInput[]> {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const drills = s
    .plan(planId)
    .setups[0]!.operations.filter((o) => o.tool === s.plan(planId).setups[0]!.operations[1]!.tool)
  for (const op of drills)
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
  return expectOk(planOperationInputs(s.d.doc, planId))
}

const byDesign = (inputs: PlanOperationInput[], ...ids: string[]) =>
  inputs.find((i) => i.operations.map((o) => o.id).join('+') === ids.join('+'))!

const q = (canonical: number) => ({ canonical })

describe('toolpathTool', () => {
  const tool = (type: string, extra: object = {}) =>
    ({
      type,
      diameter: q(6),
      cornerRadius: None,
      fluteLength: q(20),
      pointAngle: None,
      ...extra,
    }) as unknown as Tool
  it('uses the effective corner radius: 0 flat, RE bull nose, D/2 ball', () => {
    expect(toolpathTool(tool('flatEndMill'), 's1')).toEqual({
      id: 's1',
      type: 'flatEndMill',
      diameter: 6,
      cornerRadius: 0,
      fluteLength: 20,
    })
    expect(
      toolpathTool(tool('bullNoseEndMill', { cornerRadius: Some(q(1.5)) }), 's').cornerRadius,
    ).toBe(1.5)
    expect(toolpathTool(tool('ballEndMill'), 's').cornerRadius).toBe(3)
    expect(toolpathTool(tool('drill', { pointAngle: Some(q(135)) }), 's')).toMatchObject({
      type: 'drill',
      cornerRadius: 0,
      pointAngle: 135,
    })
  })
})

describe('nearestNeighbourOrder', () => {
  it('starts at the hole nearest the work zero and always goes to the nearest next one', () => {
    const holes = [
      [90, 10],
      [10, 50],
      [12, 8],
      [50, 50],
      [80, 50],
    ].map((c, i) => ({ id: i, center: c as [number, number] }))
    expect(nearestNeighbourOrder(holes).map((h) => h.id)).toEqual([2, 1, 3, 4, 0])
    expect(nearestNeighbourOrder([])).toEqual([])
  })
})

describe('toGeneratorInputs', () => {
  it('maps every kind of the test plan to plain inputs in canonical mm', async () => {
    const inputs = await resolvedInputs()
    const requests = inputs.map((i) => expectOk(toGeneratorInputs(i)) as SingleRequest)
    expect(requests.map((r) => [r.kind, r.inputs.length])).toEqual([
      ['facing', 1],
      ['drilling', 1],
      ['drilling', 2],
      ['drilling', 1],
      ['pocket', 1],
      ['profile', 1],
    ])
    for (const [i, r] of requests.entries()) {
      // plain data: parses with the worker's schema and survives cloning unchanged
      expect(GeneratorRequestSchema.safeParse(r).success).toBe(true)
      expect(structuredClone(r)).toEqual(r)
      // every generator accepts its input
      expectOk(generateRequest(r))
      const input = inputs[i]!
      for (const g of r.inputs) {
        expect(g.planOperationId).toBe(input.planOperationId)
        expect(g.tool.id).toBe(input.toolSnapshotId)
        expect(g.heights).toEqual({ clearanceHeight: 10, retractHeight: 2 })
        expect(g.stock).toEqual({ length: 100, width: 60, thickness: 20 })
        expect(g.maxFeedRate).toEqual([5000, 5000, 1000])
        expect(g.cutting.feedRate).toBe(input.feeds.fields.feedRate.unwrap().value)
      }
    }

    const facing = requests[0] as Extract<GeneratorRequest, { kind: 'facing' }>
    expect(facing.inputs[0]).toMatchObject({
      tool: { type: 'flatEndMill', diameter: 6, cornerRadius: 0, fluteLength: 25 },
      operation: { kind: 'facing', id: 'facing1', depth: 0.5 },
      strategy: { pattern: 'zigzag', axis: 'x', overshoot: 1, direction: 'climb' },
    })
    expect(Object.keys(facing.inputs[0]!.cutting).sort()).toEqual([
      'feedRate',
      'plungeRate',
      'spindleSpeed',
      'stepdown',
      'stepover',
    ])

    const pocket = requests[4] as Extract<GeneratorRequest, { kind: 'pocket' }>
    expect(pocket.inputs[0]).toMatchObject({
      tool: { type: 'bullNoseEndMill', diameter: 6, cornerRadius: 2 },
      operation: { kind: 'pocket', onZ: -0.5, depth: 8, floorRadius: 2 },
      strategy: { entry: 'helix', rampAngle: 3, direction: 'climb' },
    })
    const profile = requests[5] as Extract<GeneratorRequest, { kind: 'profile' }>
    expect(profile.inputs[0]).toMatchObject({
      operation: { kind: 'profile', side: 'outside', slotWidth: 6, tabs: { count: 4 } },
      strategy: { entry: 'ramp', rampAngle: 3, breakthrough: 0.5 },
    })
  })

  it('drilling: one input per hole in nearest-neighbour order, joined into one toolpath', async () => {
    const inputs = await resolvedInputs()
    const group = expectOk(toGeneratorInputs(byDesign(inputs, 'drill3', 'drill4'))) as SingleRequest
    expect(group.kind).toBe('drilling')
    const holes = group.inputs as Extract<GeneratorRequest, { kind: 'drilling' }>['inputs']
    expect(holes.map((h) => h.operation.id)).toEqual(['drill3', 'drill4'])
    expect(holes.map((h) => h.operation.center)).toEqual([
      [15, 45],
      [85, 45],
    ])
    for (const h of holes) {
      expect(h.tool).toMatchObject({ type: 'drill', diameter: 6, pointAngle: 118 })
      expect(h.cutting).toEqual({ spindleSpeed: 3000, feedRate: 150, plungeRate: 150 })
      expect(h.strategy).toEqual({ cycle: 'simple', breakthrough: 0.5 })
    }
    const joined = expectOk(generateRequest(group))
    const each = holes.map((h) => expectOk(generateDrilling(h)))
    // each pass names its hole (clone position comments, plan-v0.4.md P-E)
    const passes = each.flatMap((t, i) =>
      t.passes.map((p) => ({ ...p, operationId: holes[i]!.operation.id })),
    )
    expect(joined.passes).toEqual(passes)
    expect(joined.stats).toEqual(toolpathStats(passes, [5000, 5000, 1000]))
    expect(joined).toMatchObject({
      planOperationId: holes[0]!.planOperationId,
      tool: holes[0]!.tool.id,
      spindleSpeed: 3000,
    })
  })

  it('an end mill bores with helix: rampAngle 3° and climb by default', async () => {
    const inputs = await resolvedInputs()
    const helix = expectOk(toGeneratorInputs(byDesign(inputs, 'drill2'))) as SingleRequest
    const hole = (helix as Extract<GeneratorRequest, { kind: 'drilling' }>).inputs[0]!
    expect(hole.tool).toMatchObject({ type: 'flatEndMill', diameter: 4 })
    expect(hole.operation).toMatchObject({ bottom: { kind: 'flat', depth: 12 } })
    expect(hole.strategy).toMatchObject({ cycle: 'helix', rampAngle: 3, direction: 'climb' })
    expect(hole.strategy.cycle === 'helix' && hole.strategy.helixPitch).toBeGreaterThan(0)
  })
})
