// The plan side of general shapes (v0.3 T3): tool checks by the region's width, corner warnings
// and the helix check (shape-checks.ts), order checks by the placed bounding box (order.ts), the
// shape checks in the rebuild and blocker checks (validity.ts) and plan-only edits of shape
// operations (decision T-F). Doc: docs/modes/plan-v0.3.md#plan-side
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { ProjectDoc } from '../project/document'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { PLAN_COMMANDS } from './commands'
import { planOperationInputs } from './inputs'
import { testStock } from '../design/design.fixture'
import { planSetup, stale, type PlanSetup } from './plan.fixture'
import { rebuildBlocker } from './validity'

const region2d = nodeRegion2d()
const ui = uiSource()
const services = () => ({
  region2d,
  toolpaths: createToolpathCache(),
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
})

const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings

const ofOp = (w: PlanWarning[], planOperationId: string) =>
  w.filter((x) => x.planOperationId === planOperationId && x.code === 'plan.check')

/** A part with one named shape (`items`) used by one operation; a plan with the 6 mm flat on it. */
async function onePlan(
  items: object[],
  op: { kind: 'pocket' | 'profile'; args: object },
  tool: 'flat6' | 'flat4' = 'flat6',
) {
  const s = await planSetup({ part: false, services: services() })
  await s.run('design.shape.add', { partId: s.partId, items })
  await s.run(`design.${op.kind}.add`, {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
    ...op.args,
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const planOp = s.plan(planId).setups[0]!.operations[0]!.id
  await s.run('plan.tool.assign', {
    planId,
    planOperationId: planOp,
    toolLibraryItemId: s.tools[tool],
  })
  return { s, planId, planOp }
}

const rect = (length: string, width: string, cornerRadius = '0', center = ['0', '0']) => ({
  kind: 'rectangle',
  center,
  length,
  width,
  cornerRadius,
})

describe('tool checks of general shapes', () => {
  it('a tool wider than the region fails plan.check (pocketSize), and is not suggested', async () => {
    // 5 mm wide slot with round ends: the 6 mm tool does not fit, the 4 mm one does
    const { s, planId, planOp } = await onePlan([rect('30', '5', '2.5')], {
      kind: 'pocket',
      args: { depth: '2' },
    })
    const found = ofOp(warnings(s, planId), planOp)
    expect(found.map((f) => [f.severity, f.field, f.rule])).toEqual([
      ['error', 'tool', 'pocketSize'],
    ])
    expect(found[0]!.params).toMatchObject({ operation: 'pocket1', diameter: 6 })
    expect(Number(found[0]!.params['pocket'])).toBeCloseTo(5, 2)
    // generation is refused with the same finding
    const e = expectErrCode(planOperationInputs(s.d.doc, planId, undefined, region2d), 'plan.check')
    expect(e.issues.map((i) => i.rule)).toEqual(['pocketSize'])
    // suggestions leave the 6 mm tools out (the bull nose fails the sharp-floor rule anyway)
    const tools = (
      s.query('plan.tool.suggest', { planId, planOperationId: planOp }) as {
        tools: { name: string }[]
      }
    ).tools.map((t) => t.name)
    expect(tools).toEqual(['Flat 4'])
    // the 4 mm flat fits: no width finding (its radius fits the 2.5 mm ends)
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: planOp,
      toolLibraryItemId: s.tools.flat4,
    })
    expect(ofOp(warnings(s, planId), planOp)).toEqual([])
  })

  it('a corner below the tool radius is a warning that never blocks', async () => {
    const { s, planId, planOp } = await onePlan([rect('40', '20', '1')], {
      kind: 'pocket',
      args: { depth: '2' },
    })
    const found = ofOp(warnings(s, planId), planOp)
    expect(found.map((f) => [f.severity, f.field, f.rule, f.params])).toEqual([
      ['warning', 'tool', 'cornerRadius', { operation: 'pocket1', radius: 3, cornerRadius: 1 }],
    ])
    expect(found[0]!.message).toContain('keeps the tool radius')
    expectOk(planOperationInputs(s.d.doc, planId, undefined, region2d))
  })

  it('an inside profile checks its opening; outside and on profiles have no width rule', async () => {
    const inside = await onePlan([rect('5', '5', '0')], {
      kind: 'profile',
      args: { side: 'inside', slotWidth: '6', tabs: { count: '0' } },
    })
    const found = ofOp(warnings(inside.s, inside.planId), inside.planOp)
    expect(found.map((f) => [f.severity, f.rule])).toEqual([['error', 'openingSize']])
    expect(found[0]!.message).toContain('opening')
    const outside = await onePlan([rect('5', '5', '0')], {
      kind: 'profile',
      args: { side: 'outside', slotWidth: '6', tabs: { count: '0' } },
    })
    expect(ofOp(warnings(outside.s, outside.planId), outside.planOp)).toEqual([])
  })

  it('a set helix diameter must fit the region’s narrowest width', async () => {
    const { s, planId, planOp } = await onePlan([rect('40', '12', '3')], {
      kind: 'pocket',
      args: { depth: '2' },
    })
    expect(ofOp(warnings(s, planId), planOp)).toEqual([])
    await s.run('plan.operation.update', {
      planId,
      planOperationId: planOp,
      strategy: { helixDiameter: '7' },
    })
    const found = ofOp(warnings(s, planId), planOp)
    expect(found.map((f) => [f.severity, f.field, f.rule])).toEqual([
      ['error', 'strategy.helixDiameter', 'fits'],
    ])
    expect(Number(found[0]!.params['max'])).toBeCloseTo(6, 2)
  })

  it('a blind on groove is checked at its depth, not the stock thickness (flute, stickout)', async () => {
    // a 30 mm board: deeper than the 25 mm flute of the 6 mm flat
    const s = await planSetup({ part: false, services: services(), stock: testStock('30') })
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          closed: false,
          segments: [{ kind: 'line', to: ['40', '0'] }],
        },
      ],
    })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      side: 'on',
      slotWidth: '6',
      depth: '2',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const planOp = s.plan(planId).setups[0]!.operations[0]!.id
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: planOp,
      toolLibraryItemId: s.tools.flat6,
    })
    expect(ofOp(warnings(s, planId), planOp)).toEqual([])
    // through again: 30 mm + breakthrough exceeds the flute
    await s.run('plan.status.set', { planId, status: 'settledDesign' })
    await s.run('plan.design.operation.update', { planId, operationId: 'profile1', depth: null })
    expect(ofOp(warnings(s, planId), planOp).map((f) => f.rule)).toContain('fluteLength')
  })
})

describe('order checks of general shapes', () => {
  it('a named-shape profile before a pocket inside its bounding box: plan.loosePiece', async () => {
    const s = await planSetup({ part: false, services: services() })
    const partId = s.partId
    await s.run('design.shape.add', { partId, items: [rect('60', '40', '5')] })
    await s.run('design.shape.add', { partId, items: [rect('10', '10', '3')] })
    // a pocket inside the profile, and one outside its bounding box
    await s.run('design.pocket.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape2', center: ['45', '30'], rotation: '10' },
      depth: '2',
    })
    await s.run('design.profile.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], rotation: '90' },
      slotWidth: '6',
      tabs: { count: '0' },
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const ops = s.plan(planId).setups[0]!.operations
    const profile = ops.find((o) => o.designOperationIds[0] === 'profile1')!.id
    const pocket = ops.find((o) => o.designOperationIds[0] === 'pocket1')!.id
    const loose = () => warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')
    expect(loose()).toEqual([])
    await s.run('plan.operation.move', { planId, planOperationId: profile, toIndex: 0 })
    expect(loose()).toEqual([
      expect.objectContaining({
        severity: 'warning',
        planOperationId: pocket,
        params: { profile: 'profile1', operation: 'pocket1' },
      }),
    ])
    // moved outside the profile's placed box (rotated 90°: 40 wide along u, 60 along v)
    await s.run('plan.operation.move', { planId, planOperationId: profile, toIndex: 1 })
    await s.run('plan.status.set', { planId, status: 'settledDesign' })
    await s.run('plan.design.operation.update', {
      planId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape2', center: ['74', '30'], rotation: '10' },
    })
    await s.run('plan.operation.move', { planId, planOperationId: profile, toIndex: 0 })
    expect(loose()).toEqual([])
  })
})

describe('plan-only edits of shape operations (T-F)', () => {
  it('change placement, shape reference and parameters; never shape definitions', async () => {
    const s = await planSetup({ part: false, services: services() })
    const partId = s.partId
    await s.run('design.shape.add', { partId, items: [rect('30', '20', '4')] })
    await s.run('design.shape.add', { partId, items: [rect('20', '20', '4')] })
    await s.run('design.pocket.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      depth: '2',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.toStatus(planId, 'settledDesign')
    const before = structuredClone(s.plan(planId).design.part.shapes)
    // placement, then another shape of the snapshot, then a parameter
    await s.run('plan.design.operation.update', {
      planId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape1', center: ['40', '25'], rotation: '30' },
    })
    await s.run('plan.design.operation.update', {
      planId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape2', center: ['40', '25'] },
      depth: '3',
    })
    const op = s.plan(planId).design.part.operations.find((o) => o.id === 'pocket1')!
    expect(op.kind === 'pocket' && op.shape).toMatchObject({ kind: 'named', shapeId: 'shape2' })
    // the shapes of the snapshot are untouched, and so is the design
    expect(s.plan(planId).design.part.shapes).toEqual(before)
    const design = s.d.doc.parts[partId]!.operations.find((o) => o.id === 'pocket1')!
    expect(design.kind === 'pocket' && design.shape).toMatchObject({ shapeId: 'shape1' })
    expect(stale(s, planId).operations).toEqual([
      expect.objectContaining({
        operationId: 'pocket1',
        editedInPlan: true,
        changedInDesign: false,
      }),
    ])
    // the plan generates from its own edit
    const input = expectOk(planOperationInputs(s.d.doc, planId, undefined, region2d)).find((i) =>
      i.operations.some((o) => o.id === 'pocket1'),
    )!
    const placed = input.operations[0]!
    expect(placed.kind === 'pocket' && placed.shape).toMatchObject({ shapeId: 'shape2' })
    // a shape that is not in the snapshot is refused; no plan command edits definitions
    await s.failWith(
      'plan.design.operation.update',
      {
        planId,
        operationId: 'pocket1',
        shape: { kind: 'named', shapeId: 'shape9', center: ['40', '25'] },
      },
      'input.malformed',
    )
    expect(PLAN_COMMANDS.map((c) => c.name).filter((n) => /shape/.test(n))).toEqual([])
    expectErrCode(
      await s.d.dispatch(
        'plan.design.operation.update',
        { planId, operationId: 'pocket1', items: [rect('5', '5')] },
        ui,
      ),
      'input.malformed',
    )
  })
})

describe('rebuild and blocker checks with the 2D port', () => {
  it('a design whose tab positions leave the loop blocks the rebuild only with the port', async () => {
    const s = await planSetup({ part: false, services: services() })
    const partId = s.partId
    await s.run('design.shape.add', { partId, items: [rect('60', '30', '5')] })
    await s.run('design.profile.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      side: 'on',
      slotWidth: '6',
      tabs: { width: '6', thickness: '3', positions: ['20', '150'] },
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    // the design's shape shrinks behind the commands' back: its loop (≈ 111 mm) ends before 150
    const doc = structuredClone(s.d.doc) as ProjectDoc
    const item = doc.parts[partId]!.shapes![0]!.items[0]!
    if (item.kind !== 'rectangle') throw new Error('rectangle expected')
    item.length = structuredClone(item.width)
    const plan = doc.plans[planId]!
    expect(rebuildBlocker(plan, doc)).toBeUndefined()
    const blocked = rebuildBlocker(plan, doc, region2d)
    expect(blocked?.reason).toMatch(/rebuild blocked.*tab/i)
    // DF43: the profile by name and the field in words; the path stays in `fields` for agents
    expect(blocked?.reason).toContain('Profile 1 tab 2 position')
    expect(blocked?.reason).not.toMatch(/profile1|operations\.|tabs\.positions/)
    expect(blocked?.fields).toContain('operations.profile1.tabs.positions.1')
  })
})
