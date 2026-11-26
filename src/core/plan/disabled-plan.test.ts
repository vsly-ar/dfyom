// Disabled items in plans (hardening DF106): a design-disabled pocket and its chamfer leave the
// draft plan and its program on Apply and come back byte-equal when enabled (the headless
// check); the plan's own disabled list (plan.update) is one-way, kept across rebuilds and never
// takes design changes.
// Spec: docs/modes/design.md#disabling-operations-and-features-df106,
// docs/modes/plan-v0.4.md#disabling-in-a-plan-df106
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeIds, uiSource } from '../commands/testing'
import type { ExportFiles } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { hasPlanEdits } from './snapshot'
import { deg, len, libraryInput } from '../library/library.fixture'
import { flat6, planSetup, type PlanSetup } from './plan.fixture'

const ui = uiSource()

/** The program of the plan's first setup, exported from the current document. */
async function exportText(s: PlanSetup, planId: string): Promise<string> {
  const written: string[] = []
  const files: ExportFiles = {
    write(target, text) {
      written.push(text)
      return Promise.resolve(Ok({ filePath: target }))
    },
  }
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: createInProcessWorkers(),
      library: s.library,
      toolpaths: createToolpathCache(),
      exportFiles: files,
    },
  })
  expectOk(await d.dispatch('plan.export', { planId, target: '/out/p.nc' }, ui))
  return written[0]!
}

const designIdsOf = (s: PlanSetup, planId: string) =>
  s.plan(planId).setups.flatMap((x) => x.operations.flatMap((o) => o.designOperationIds))

async function setupWithChamfer(): Promise<{ s: PlanSetup; planId: string }> {
  // every tool with an aluminum preset, so re-added plan operations resolve their feeds alone
  const s = await planSetup({ part: false })
  await s.run('library.tool.add', {
    values: libraryInput({
      ...flat6(),
      name: 'Chamfer 12',
      type: 'chamferMill',
      diameter: len('12'),
      angle: deg('90'),
      fluteLength: len('8'),
    }),
  })
  await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['70', '30'],
      length: '30',
      width: '20',
      cornerRadius: '4',
    },
    depth: '4',
    floorRadius: '0',
  })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'circle', center: ['30', '30'], diameter: '10' },
    depth: '3',
    floorRadius: '0',
  })
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket2' })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  return { s, planId }
}

describe('design-disabled items in plans (DF106)', () => {
  it('a disabled pocket with its chamfer leaves the plan and the program; enabling restores both byte-equal', async () => {
    const { s, planId } = await setupWithChamfer()
    const before = await exportText(s, planId)
    const plan = s.plan(planId)
    expect(designIdsOf(s, planId)).toEqual(expect.arrayContaining(['pocket2', 'chamfer1']))

    await s.run('design.part.update', { partId: s.partId, disabled: ['pocket2'] })
    await s.run('project.apply', {})
    expect(designIdsOf(s, planId)).not.toContain('pocket2')
    expect(designIdsOf(s, planId)).not.toContain('chamfer1')
    const ops = s.plan(planId).design.part.operations.map((o) => o.id)
    expect(ops).not.toContain('pocket2')
    expect(s.plan(planId).design.part).not.toHaveProperty('disabled')
    const without = await exportText(s, planId)
    expect(without).not.toBe(before)
    expect(without).not.toMatch(/Pocket 2|Chamfer 1/)

    await s.run('design.part.update', { partId: s.partId, disabled: [] })
    await s.run('project.apply', {})
    expect(s.plan(planId).design).toEqual({ ...plan.design, takenAt: expect.any(String) })
    expect(await exportText(s, planId)).toBe(before)
  })
})

describe('disabling in a plan only (DF106)', () => {
  it('leaves the design alone, survives a draft follow, and enables back', async () => {
    const { s, planId } = await setupWithChamfer()
    const record = s.part()
    await s.run('plan.update', { planId, disabled: ['pocket2'] })
    expect(s.part()).toEqual(record)
    expect(s.plan(planId).disabled).toEqual(['pocket2'])
    expect(designIdsOf(s, planId)).not.toContain('pocket2')
    expect(designIdsOf(s, planId)).not.toContain('chamfer1')
    // the snapshot still has it: Design state flows in, the plan's own list stays
    expect(s.plan(planId).design.taken.operations.map((o) => o.id)).toContain('pocket2')
    expect(hasPlanEdits(s.plan(planId))).toBe(false)
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '7' })
    await s.run('project.apply', {})
    expect(s.plan(planId).disabled).toEqual(['pocket2'])
    expect(designIdsOf(s, planId)).not.toContain('pocket2')
    await s.run('plan.update', { planId, disabled: [] })
    expect(s.plan(planId)).not.toHaveProperty('disabled')
    expect(designIdsOf(s, planId)).toEqual(expect.arrayContaining(['pocket2', 'chamfer1']))
  })

  it('in a settled plan takes no design change; refuses unknown and owned ids', async () => {
    const { s, planId } = await setupWithChamfer()
    await s.toStatus(planId, 'settledDesign')
    const depth = s.plan(planId).design.part.operations.find((o) => o.id === 'pocket1')
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '7' })
    await s.run('project.apply', {})
    await s.run('plan.update', { planId, disabled: ['chamfer1'] })
    const plan = s.plan(planId)
    expect(plan.design.part.operations.find((o) => o.id === 'pocket1')).toEqual(depth)
    expect(designIdsOf(s, planId)).not.toContain('chamfer1')
    expect(designIdsOf(s, planId)).toContain('pocket2')
    const e = await s.fail('plan.update', { planId, disabled: ['pocket9'] }, 'input.malformed')
    expect(e.issues.map((i) => i.rule)).toEqual(['unknownItem'])
  })
})

/** The plan operation machining design operation `id`, with its setup and index. */
function opOf(s: PlanSetup, planId: string, id: string) {
  for (const setup of s.plan(planId).setups) {
    const index = setup.operations.findIndex((o) => o.designOperationIds.includes(id))
    if (index >= 0) return { setupId: setup.id, index, op: setup.operations[index]! }
  }
  return undefined
}

describe('plan operations of switched-off items are kept (DF106 follow-up)', () => {
  it('a design-disabled pocket keeps its plan operation settings and place when enabled', async () => {
    const { s, planId } = await setupWithChamfer()
    const before = opOf(s, planId, 'pocket2')!
    await s.run('plan.operation.update', {
      planId,
      planOperationId: before.op.id,
      overrides: { feedRate: '444 mm/min' },
      strategy: { direction: 'conventional' },
    })
    const edited = opOf(s, planId, 'pocket2')!
    await s.run('design.part.update', { partId: s.partId, disabled: ['pocket2'] })
    await s.run('project.apply', {})
    expect(opOf(s, planId, 'pocket2')).toBeUndefined()
    expect(s.plan(planId).parked?.map((p) => p.operation.id)).toEqual(
      expect.arrayContaining([edited.op.id]),
    )
    // its tool copy stays for it
    const tool = edited.op.tool
    expect(s.plan(planId).snapshots.some((x) => x.id === tool)).toBe(true)

    await s.run('design.part.update', { partId: s.partId, disabled: [] })
    await s.run('project.apply', {})
    expect(opOf(s, planId, 'pocket2')).toEqual(edited)
    expect(s.plan(planId)).not.toHaveProperty('parked')
  })

  it('a plan-only disable keeps the plan operation and its plan edits', async () => {
    const { s, planId } = await setupWithChamfer()
    await s.toStatus(planId, 'settledDesign')
    const before = opOf(s, planId, 'pocket2')!
    await s.run('plan.operation.update', {
      planId,
      planOperationId: before.op.id,
      overrides: { plungeRate: '111 mm/min' },
    })
    await s.run('plan.design.operation.update', { planId, operationId: 'pocket2', depth: '2.5' })
    const edited = opOf(s, planId, 'pocket2')!
    const part = s.plan(planId).design.part
    await s.run('plan.update', { planId, disabled: ['pocket2'] })
    expect(opOf(s, planId, 'pocket2')).toBeUndefined()
    await s.run('plan.update', { planId, disabled: [] })
    expect(opOf(s, planId, 'pocket2')).toEqual(edited)
    expect(s.plan(planId).design.part).toEqual(part)
    expect(hasPlanEdits(s.plan(planId))).toBe(true)
  })

  it('drops a parked plan operation on the next rebuild after its item left the design', async () => {
    const { s, planId } = await setupWithChamfer()
    await s.run('design.part.update', { partId: s.partId, disabled: ['chamfer1'] })
    await s.run('project.apply', {})
    expect(s.plan(planId).parked).toHaveLength(1)
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'chamfer1' })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '5' })
    await s.run('project.apply', {})
    expect(s.plan(planId)).not.toHaveProperty('parked')
  })

  it('a settled plan reports a design-disabled item as off in design, not removed', async () => {
    const { s, planId } = await setupWithChamfer()
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.part.update', { partId: s.partId, disabled: ['pocket2'] })
    await s.run('project.apply', {})
    const st = s.query('plan.stale.list', { planId }) as {
      operations: { operationId: string; removedFromDesign: boolean; disabledInDesign: boolean }[]
    }
    const pocket = st.operations.find((o) => o.operationId === 'pocket2')!
    expect(pocket).toMatchObject({ removedFromDesign: false, disabledInDesign: true })
    // its chamfer follows it off
    const chamfer = st.operations.find((o) => o.operationId === 'chamfer1')!
    expect(chamfer).toMatchObject({ removedFromDesign: false, disabledInDesign: true })
  })
})
