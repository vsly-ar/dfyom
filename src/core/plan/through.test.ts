// Material removed by earlier setups (hardening DF50): a top outline over a bottom pocket cuts only
// the material left, its tabs stand on it and the checks measure it, in the plan's setup order.
// Spec: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { toGeneratorInputs } from '../toolpath/inputs'
import { generateRequest } from '../toolpath/request'
import type { Toolpath } from '../toolpath/model'
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
    expect(input!.throughDepth).toBe(15)
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
