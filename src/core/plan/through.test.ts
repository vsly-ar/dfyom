// Material removed by earlier setups (hardening DF50): a top outline over a bottom pocket cuts only
// the material left, its tabs stand on it and the checks measure it, in the plan's setup order.
// DF61: through holes too, and passes over the material earlier cuts left.
// Spec: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups,
// docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { noSteps } from '../workers/steps'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { toGeneratorInputs } from '../toolpath/inputs'
import { generateRequest } from '../toolpath/request'
import type { Toolpath } from '../toolpath/model'
import { Heightmap } from '../toolpath/testing/oracles'
import type { PlanWarning } from './checks'
import { planOperationInputs } from './inputs'
import { planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()

/**
 * The test part's outline (84 × 44, slot 6, tabs 3 thick) on the 100 × 60 × 20 block, plus a
 * 5 mm relief pocket on the bottom over the whole underside: setups Bottom, Top.
 */
async function relieved(): Promise<{ s: PlanSetup; planId: string }> {
  const s = await planSetup({ part: false, services: { region2d } })
  const partId = s.partId
  await s.run('design.pocket.add', {
    partId,
    on: 'stock.bottom',
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '100',
      width: '60',
      cornerRadius: '4',
    },
    depth: '5',
    floorRadius: '0',
  })
  await s.run('design.profile.add', {
    partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '84',
      width: '44',
      cornerRadius: '5',
    },
    slotWidth: '6',
    tabs: { count: '4', width: '8', thickness: '3' },
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  return { s, planId }
}

const profileOp = (s: PlanSetup, planId: string) =>
  s
    .plan(planId)
    .setups.flatMap((x) => x.operations)
    .find((o) => o.designOperationIds[0] === 'profile1')!

const profileToolpath = (s: PlanSetup, planId: string): Toolpath => {
  const [input] = expectOk(
    planOperationInputs(s.d.doc, planId, [profileOp(s, planId).id], region2d),
  )
  return expectOk(generateRequest(expectOk(toGeneratorInputs(input!, region2d))))
}

const zs = (tp: Toolpath) =>
  tp.passes.flatMap((p) => p.moves.flatMap((m) => (m.kind === 'drill' ? [m.bottom] : [m.to[2]])))

const listed = (s: PlanSetup, planId: string) =>
  (
    s.query('plan.operation.list', { planId }) as {
      operations: { designOperationIds: string[]; throughDepth: number | null }[]
    }
  ).operations.find((o) => o.designOperationIds[0] === 'profile1')!.throughDepth

const reach = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
    (w) => w.rule === 'reach' && w.planOperationId === profileOp(s, planId).id,
  )

describe('through profiles after an earlier setup (DF50)', () => {
  it('cuts the material the bottom setup left, tabs standing on it', async () => {
    const { s, planId } = await relieved()
    expect(s.plan(planId).setups.map((x) => x.name)).toEqual(['Bottom', 'Top'])
    const [input] = expectOk(
      planOperationInputs(s.d.doc, planId, [profileOp(s, planId).id], region2d),
    )
    expect(input!.throughDepths?.get('profile1')).toBe(15)
    const z = zs(profileToolpath(s, planId))
    // 15 mm of material + 0.5 breakthrough, no passes below; the tool lifts to 3 above the floor
    expect(Math.min(...z)).toBeCloseTo(-15.5, 9)
    expect(z.some((v) => Math.abs(v - -12) < 1e-9)).toBe(true)
    expect(listed(s, planId)).toBe(15)
  })

  it('the tool checks measure the material left: a shorter stickout reaches', async () => {
    const { s, planId } = await relieved()
    const op = profileOp(s, planId)
    await s.run('plan.operation.update', { planId, planOperationId: op.id, stickout: '18' })
    expect(reach(s, planId)).toEqual([])
  })

  it('in the plan’s setup order: the top first cuts the whole stock', async () => {
    const { s, planId } = await relieved()
    const top = s.plan(planId).setups.find((x) => x.name === 'Top')!.id
    await s.run('plan.setup.move', { planId, setupId: top, toIndex: 0 })
    expect(listed(s, planId)).toBe(20)
    expect(Math.min(...zs(profileToolpath(s, planId)))).toBeCloseTo(-20.5, 9)
    await s.run('plan.operation.update', {
      planId,
      planOperationId: profileOp(s, planId).id,
      stickout: '18',
    })
    expect(reach(s, planId)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ depth: 20.5 }) }),
    ])
  })

  it('design: dfm.tabsThick when the tabs reach the stock face', async () => {
    const { s } = await relieved()
    const out = (await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      tabs: { thickness: '16' },
    })) as { warnings: { code: string; params: Record<string, unknown> }[] }
    expect(out.warnings.filter((w) => w.code === 'dfm.tabsThick')).toEqual([
      expect.objectContaining({ params: { thickness: 16, material: 15 } }),
    ])
  })
})

const opOf = (s: PlanSetup, planId: string, id: string) =>
  s
    .plan(planId)
    .setups.flatMap((x) => x.operations)
    .find((o) => o.designOperationIds.includes(id))!

const inputOf = (s: PlanSetup, planId: string, id: string) =>
  expectOk(planOperationInputs(s.d.doc, planId, [opOf(s, planId, id).id], region2d))[0]!

const toolpathOf = (s: PlanSetup, planId: string, id: string): Toolpath =>
  expectOk(
    generateRequest(expectOk(toGeneratorInputs(inputOf(s, planId, id), region2d)), noSteps, () =>
      Ok(region2d),
    ),
  )

describe('through holes after an earlier setup (DF61)', () => {
  it('a top through hole over the relief drills the material left', async () => {
    const { s } = await relieved()
    await s.run('design.drilling.add', { partId: s.partId, center: ['50', '30'], diameter: '6' })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opOf(s, planId, 'drill1').id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
    expect(inputOf(s, planId, 'drill1').throughDepths?.get('drill1')).toBe(15)
    const drill = toolpathOf(s, planId, 'drill1')
      .passes.flatMap((p) => p.moves)
      .find((m) => m.kind === 'drill')
    // 15 mm of material + breakthrough + the drill tip, not the 20 mm stock
    if (drill?.kind !== 'drill') throw new Error('no drill cycle')
    expect(drill.bottom).toBeGreaterThan(-20)
    expect(drill.bottom).toBeLessThan(-15)
  })
})

describe('passes over the material earlier cuts left (DF61)', () => {
  it('a step below a facing starts at the facing floor; the floor stays', async () => {
    const s = await planSetup({ part: false, services: { region2d } })
    await s.run('design.facing.add', { partId: s.partId, depth: '2' })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '84',
        width: '44',
        cornerRadius: '5',
      },
      slotWidth: '6',
      depth: '5',
      tabs: { count: '0', width: '8', thickness: '3' },
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    expect(inputOf(s, planId, 'profile1').material).toEqual({ top: -2 })
    const z = zs(toolpathOf(s, planId, 'profile1'))
    // no move between the stock face and the facing floor; down to the step's floor
    expect(z.filter((v) => v < 0 && v > -2 + 1e-9)).toEqual([])
    expect(Math.min(...z)).toBeCloseTo(-5, 9)
  })
})

describe('partial coverage and holes on cleared material (DF61 follow-ups)', () => {
  /** Pocket 1 (30 × 30, 6 deep) first, then pocket 2 (60 × 40, 8 deep) round it, both on top. */
  async function stacked(): Promise<{ s: PlanSetup; planId: string }> {
    const s = await planSetup({ part: false, services: { region2d } })
    const pocket = (length: string, width: string, depth: string) =>
      s.run('design.pocket.add', {
        partId: s.partId,
        shape: { kind: 'rectangle', center: ['50', '30'], length, width, cornerRadius: '4' },
        depth,
        floorRadius: '0',
      })
    await pocket('30', '30', '6')
    await pocket('60', '40', '8')
    await s.run('project.apply', {})
    return { s, planId: await s.create({ machineLibraryItemId: s.machineId }) }
  }

  it('a pocket partly over a deeper earlier one cuts the rest down to its floor first', async () => {
    const { s, planId } = await stacked()
    const input = inputOf(s, planId, 'pocket2')
    expect(input.material?.partial?.level).toBe(-6)
    const request = expectOk(toGeneratorInputs(input, region2d))
    expect(request.kind).toBe('regionPocket')
    expect(request.inputs).toHaveLength(2)
    const split = toolpathOf(s, planId, 'pocket2')
    const { material: _, ...plain } = input
    const whole = expectOk(
      generateRequest(expectOk(toGeneratorInputs(plain, region2d)), noSteps, () => Ok(region2d)),
    )
    expect(split.stats.estimatedSeconds).toBeLessThan(whole.stats.estimatedSeconds)
    // heightmap oracle: pocket 1 then pocket 2 leaves what pocket 1 then the unsplit pocket leaves
    const first = toolpathOf(s, planId, 'pocket1')
    const tool = expectOk(toGeneratorInputs(input, region2d)).inputs[0]!.tool
    const after = (tp: Toolpath) => {
      const map = new Heightmap(100, 60, 0.25)
      map.sweep(tool, first)
      map.sweep(tool, tp)
      return map
    }
    const a = after(split)
    const b = after(whole)
    let worst = 0
    for (let k = 0; k < a.z.length; k++) worst = Math.max(worst, a.z[k]! - b.z[k]!)
    expect(worst).toBeLessThan(1e-6)
  })

  it('a hole on top inside a deeper earlier pocket starts its cycle on the pocket floor', async () => {
    const { s } = await stacked()
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['50', '30'],
      diameter: '6',
      bottom: 'flat',
      depth: '10',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opOf(s, planId, 'drill1').id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
    // the plan drills first; after the pockets the hole meets their floor
    await s.run('plan.operation.move', {
      planId,
      planOperationId: opOf(s, planId, 'drill1').id,
      toIndex: 2,
    })
    expect(inputOf(s, planId, 'drill1').materials?.get('drill1')).toEqual({ top: -8 })
    // the 6 mm end mill bores it: every feed move on or below the pocket floor, the retract
    // plane above it
    const moves = toolpathOf(s, planId, 'drill1').passes.flatMap((p) => p.moves)
    const ends = moves.map((m) => (m.kind === 'drill' ? m.bottom : m.to[2]))
    const feeds = moves.filter((m) => m.kind !== 'rapid' && m.kind !== 'drill')
    expect(feeds.length).toBeGreaterThan(0)
    expect(Math.max(...feeds.map((m) => m.to[2]))).toBe(-8)
    expect(Math.min(...ends)).toBeCloseTo(-10, 9)
    const rapids = moves.filter((m) => m.kind === 'rapid').map((m) => m.to[2])
    expect(Math.min(...rapids)).toBeLessThan(0)
  })
})
