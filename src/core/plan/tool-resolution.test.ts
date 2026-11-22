// Tool resolution from the design tool field (v0.2 E4): the assignment table, toolSource, the
// designToolChanged stale flag, the plan.tool.suggest reasons and the derived findings.
// Doc: docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { fakeIds } from '../commands/testing'
import { deg, libraryInput } from '../library/library.fixture'
import { rebuildPlan } from './build'
import type { PlanWarning } from './checks'
import { drill6, expectUndoRedo, planSetup, stale, type PlanSetup } from './plan.fixture'
import type { PlanDTO, PlanOperationDTO } from './plan.dto'

const allOps = (p: PlanDTO) => p.setups.flatMap((x) => x.operations)
const planOp = (p: PlanDTO, designId: string): PlanOperationDTO =>
  allOps(p).find((o) => o.designOperationIds.includes(designId))!
const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings
/** The design's tool snapshot id of an operation (specific tools only). */
const designSnapshot = (s: PlanSetup, operationId: string) => {
  const t = s.d.doc.parts[s.partId]!.operations.find((o) => o.id === operationId)!.tool
  return t?.kind === 'specific' ? t.snapshotId : undefined
}
const toolName = (s: PlanSetup, planId: string, designId: string) => {
  const p = s.plan(planId)
  const id = planOp(p, designId).tool
  const snap = p.snapshots.find((x) => x.id === id)
  return (snap?.values as { name?: string } | undefined)?.name
}

interface Suggestion {
  toolLibraryItemId: string
  designTool: boolean
  matchesDesign: boolean
  reasons: string[]
}
const suggest = (s: PlanSetup, planId: string, designId: string) =>
  (
    s.query('plan.tool.suggest', {
      planId,
      planOperationId: planOp(s.plan(planId), designId).id,
    }) as { tools: Suggestion[] }
  ).tools

/** A 6 mm drill with a 135° point: fits the 118° hole in design, fails the plan's angle check. */
async function withDrill135(s: PlanSetup): Promise<string> {
  const values = { ...drill6(), name: 'Drill 6 135', pointAngle: deg('135') }
  return ((await s.run('library.tool.add', { values: libraryInput(values) })) as { id: string }).id
}

async function setTool(s: PlanSetup, operationId: string, tool: object, lock = true) {
  await s.run('design.operation.tool.set', { partId: s.partId, operationId, tool })
  if (!lock) await s.run('design.operation.tool.unlock', { partId: s.partId, operationId })
  await s.run('project.apply', {})
}

describe('plan.create resolves tools from the design tool field', () => {
  it('a specific tool that passes: the plan copy of the design snapshot (same id)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const p = s.plan(planId)
    const facing = planOp(p, 'facing1')
    expect(facing.toolSource).toBe('design')
    expect(facing.tool).toBe(designSnapshot(s, 'facing1'))
    // every operation resolved from the design; the copies are the design's own ids
    expect(allOps(p).every((o) => o.toolSource === 'design')).toBe(true)
    for (const o of p.design.part.operations)
      if (o.tool?.kind === 'specific')
        expect(p.snapshots.map((x) => x.id)).toContain(o.tool.snapshotId)
    expect(warnings(s, planId).filter((w) => w.code.startsWith('plan.designTool'))).toEqual([])
  })

  it('an unlocked specific tool that fails a plan check is replaced, with info', async () => {
    const s = await planSetup()
    const d135 = await withDrill135(s)
    await setTool(s, 'drill4', { kind: 'specific', toolLibraryItemId: d135 }, false)
    // the auto choice keeps it: the design's fit table does not check the point angle
    expect(designSnapshot(s, 'drill4')).toBeDefined()
    const planId = (await expectUndoRedo(s, 'plan.create', { partId: s.partId })) as {
      planId: string
    }
    const id = planId.planId
    expect(toolName(s, id, 'drill4')).toBe('Drill 6')
    expect(planOp(s.plan(id), 'drill4').toolSource).toBe('design')
    expect(warnings(s, id)).toContainEqual(
      expect.objectContaining({
        code: 'plan.designToolReplaced',
        severity: 'info',
        field: 'tool',
        rule: 'pointAngle',
        params: expect.objectContaining({ designTool: 'Drill 6 135', tool: 'Drill 6' }),
      }),
    )
  })

  it('a locked specific tool stays even when it fails; plan.designToolFailed lists alternatives', async () => {
    const s = await planSetup()
    const d135 = await withDrill135(s)
    await setTool(s, 'drill4', { kind: 'specific', toolLibraryItemId: d135 })
    const planId = await s.create()
    const op = planOp(s.plan(planId), 'drill4')
    expect(op.tool).toBe(designSnapshot(s, 'drill4'))
    const w = warnings(s, planId).filter((x) => x.planOperationId === op.id)
    expect(w).toContainEqual(
      expect.objectContaining({
        code: 'plan.designToolFailed',
        severity: 'error',
        rule: 'pointAngle',
        params: expect.objectContaining({
          designTool: 'Drill 6 135',
          alternativeIds: s.tools.drill6,
        }),
      }),
    )
    // generation stays blocked by the check itself
    expect(w).toContainEqual(expect.objectContaining({ code: 'plan.check', rule: 'pointAngle' }))
  })

  it('a locked generalized tool takes the matching library tool, else none and plan.toolUnresolved', async () => {
    const s = await planSetup()
    await setTool(s, 'drill1', { kind: 'generalized', type: 'drill', diameter: '6' })
    await setTool(s, 'profile1', { kind: 'generalized', type: 'flatEndMill', diameter: '3' })
    const planId = await s.create()
    const p = s.plan(planId)
    expect(toolName(s, planId, 'drill1')).toBe('Drill 6')
    expect(planOp(p, 'profile1').tool).toBeUndefined()
    expect(warnings(s, planId)).toContainEqual(
      expect.objectContaining({
        code: 'plan.toolUnresolved',
        severity: 'error',
        planOperationId: planOp(p, 'profile1').id,
        params: expect.objectContaining({
          designTool: '3 mm flat end mill',
          alternatives: 'Flat 6, Flat 4',
        }),
      }),
    )
  })

  it('an unlocked generalized tool: the first suggestion, matching tools first', async () => {
    const s = await planSetup()
    await setTool(s, 'profile1', { kind: 'generalized', type: 'flatEndMill', diameter: '4' }, false)
    const planId = await s.create()
    // Flat 6 has the aluminum preset, but Flat 4 matches the design's 4 mm end mill
    expect(toolName(s, planId, 'profile1')).toBe('Flat 4')
    const t = suggest(s, planId, 'profile1')
    expect(t.map((x) => x.toolLibraryItemId)).toEqual([s.tools.flat4, s.tools.flat6])
    expect(t[0]).toMatchObject({ designTool: false, matchesDesign: true })
    expect(t[0]!.reasons[0]).toBe("matches the design's 4 mm flat end mill")
    // nothing matches: the first suggestion as v0.1, no finding
    const s2 = await planSetup()
    await setTool(
      s2,
      'profile1',
      { kind: 'generalized', type: 'flatEndMill', diameter: '3' },
      false,
    )
    const p2 = await s2.create()
    expect(toolName(s2, p2, 'profile1')).toBe('Flat 6')
    expect(warnings(s2, p2).filter((w) => w.code === 'plan.toolUnresolved')).toEqual([])
  })

  it("plan.tool.suggest marks the design's specific tool", async () => {
    const s = await planSetup()
    const planId = await s.create()
    const t = suggest(s, planId, 'drill1')
    expect(t[0]).toMatchObject({
      toolLibraryItemId: s.tools.drill6,
      designTool: true,
      matchesDesign: true,
    })
    expect(t[0]!.reasons[0]).toBe("the design's tool")
  })
})

describe('rebuild and toolSource', () => {
  it('re-resolves design tools whose field changed; a plan assignment stays and is flagged', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    // the plan assigns Flat 4 to the profile deliberately
    const profile = planOp(s.plan(planId), 'profile1').id
    await expectUndoRedo(s, 'plan.tool.assign', {
      planId,
      planOperationId: profile,
      toolLibraryItemId: s.tools.flat4,
    })
    expect(planOp(s.plan(planId), 'profile1').toolSource).toBe('plan')
    // the design picks other tools for the facing and the profile
    await setTool(s, 'facing1', { kind: 'specific', toolLibraryItemId: s.tools.flat4 })
    await setTool(s, 'profile1', { kind: 'generalized', type: 'flatEndMill', diameter: '6' })
    const before = stale(s, planId).operations
    expect(before.filter((o) => o.designToolChanged).map((o) => o.operationId)).toEqual([
      'facing1',
      'profile1',
    ])
    await expectUndoRedo(s, 'plan.rebuild', { planId })
    const p = s.plan(planId)
    expect(toolName(s, planId, 'facing1')).toBe('Flat 4')
    expect(planOp(p, 'facing1').toolSource).toBe('design')
    expect(toolName(s, planId, 'profile1')).toBe('Flat 4')
    expect(planOp(p, 'profile1')).toMatchObject({ toolSource: 'plan', designToolChanged: true })
    // after the rebuild only the kept plan assignment is still flagged
    expect(
      stale(s, planId)
        .operations.filter((o) => o.designToolChanged)
        .map((o) => o.operationId),
    ).toEqual(['profile1'])
    // a new plan decision clears the flag
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: profile,
      toolLibraryItemId: s.tools.flat6,
    })
    expect(planOp(s.plan(planId), 'profile1').designToolChanged).toBeUndefined()
    expect(stale(s, planId).operations.some((o) => o.designToolChanged)).toBe(false)
  })

  it('an unchanged design tool field keeps the tool and its preset choice', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const facing = planOp(s.plan(planId), 'facing1')
    await s.run('plan.operation.update', {
      planId,
      planOperationId: facing.id,
      presetName: 'Alu finish',
    })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    await s.run('plan.rebuild', { planId })
    expect(planOp(s.plan(planId), 'facing1')).toMatchObject({
      tool: facing.tool,
      presetName: 'Alu finish',
    })
  })

  it('a record without toolSource (taken before E4) keeps its tool like a plan assignment', async () => {
    const s = await planSetup()
    const planId = await s.create()
    // an older record: no toolSource
    const older = structuredClone(s.plan(planId))
    for (const o of allOps(older)) delete o.toolSource
    const tool = planOp(older, 'facing1').tool
    await setTool(s, 'facing1', { kind: 'specific', toolLibraryItemId: s.tools.flat4 })
    const ctx = { ids: fakeIds(), now: '2026-11-21T00:00:00.000Z', units: 'mm' as const, tools: [] }
    const rebuilt = expectOk(rebuildPlan(older, s.d.doc, ctx, 'test'))
    expect(planOp(rebuilt, 'facing1')).toMatchObject({ tool, designToolChanged: true })
    expect(planOp(rebuilt, 'facing1').toolSource).toBeUndefined()
  })

  it('a draft plan follows a design tool change on Apply', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'facing1',
      tool: { kind: 'specific', toolLibraryItemId: s.tools.flat4 },
    })
    expect(toolName(s, planId, 'facing1')).toBe('Flat 6')
    await s.run('project.apply', {})
    expect(toolName(s, planId, 'facing1')).toBe('Flat 4')
    await s.undo()
    expect(toolName(s, planId, 'facing1')).toBe('Flat 6')
    await s.redo()
    expect(toolName(s, planId, 'facing1')).toBe('Flat 4')
  })

  it('drillings with different design tools are separate plan operations', async () => {
    const s = await planSetup()
    const d135 = await withDrill135(s)
    const planId = await s.create()
    expect(planOp(s.plan(planId), 'drill3').designOperationIds).toEqual(['drill3', 'drill4'])
    await setTool(s, 'drill4', { kind: 'specific', toolLibraryItemId: d135 })
    await s.run('plan.rebuild', { planId })
    const p = s.plan(planId)
    expect(planOp(p, 'drill3').designOperationIds).toEqual(['drill3'])
    expect(planOp(p, 'drill4').designOperationIds).toEqual(['drill4'])
    expect(planOp(p, 'drill4').tool).toBe(designSnapshot(s, 'drill4'))
  })
})
