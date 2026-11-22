// Spec: docs/modes/plan-v0.1.md (Plan status, Plans are snapshots, Implementation (task 2.13)):
// inUse has no way back, library follow races and failures, rebuild validity and order, stale
// detection by value, the draft auto-rebuild hook, the toolpath input hash, undo laws.
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { DocumentCommand } from '../commands/define'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import { DESIGN_COMMANDS } from '../design/commands'
import { testStock } from '../design/design.fixture'
import { len, libraryInput } from '../library/library.fixture'
import type { ProjectDoc } from '../project/document'
import { PLAN_COMMANDS, PLAN_QUERIES } from './commands'
import { followLibraryChanges } from './follow'
import { planOperationInputs } from './inputs'
import type { PlanDTO } from './plan.dto'
import {
  designIds,
  expectPatchLaw,
  expectUndoRedo,
  flat6,
  opsOf,
  planSetup,
  stale,
  type PlanSetup,
} from './plan.fixture'

const ui = uiSource()
type Warnings = {
  warnings: { code: string; rule: string; message: string; planOperationId?: string }[]
}
const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as Warnings).warnings

async function setStockThickness(s: PlanSetup, thickness: string) {
  const id = s
    .plan(Object.keys(s.d.doc.plans)[0]!)
    .snapshots.find((x) => x.kind === 'stock')!.libraryItemId
  const item = s.query('library.stock.get', { id }) as { revision: number }
  await s.run('library.stock.update', { id, revision: item.revision, values: testStock(thickness) })
}

async function changeTool(s: PlanSetup) {
  const item = s.query('library.tool.get', { id: s.tools.flat6 }) as { revision: number }
  await s.run('library.tool.update', {
    id: s.tools.flat6,
    revision: item.revision,
    values: { ...libraryInput(flat6()), name: 'Flat 6 reground', diameter: '5.9' },
  })
}

describe('inUse has no way back', () => {
  it('inUse → finalized → settledDesign → operation.update is refused at the first step', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'inUse')
    await s.failWith('plan.status.set', { planId, status: 'finalized' }, 'plan.status')
    await s.failWith('plan.status.set', { planId, status: 'settledDesign' }, 'plan.status')
    await s.failWith(
      'plan.operation.update',
      { planId, planOperationId: opsOf(s.plan(planId))[0]!.id, overrides: { feedRate: '100' } },
      'plan.status',
    )
    expect(s.plan(planId).status).toBe('inUse')
    // archive is the only exit; un-archive returns to inUse, not further back
    await s.run('plan.status.set', { planId, status: 'archived' })
    await s.failWith('plan.status.set', { planId, status: 'finalized' }, 'plan.status')
    await s.run('plan.status.set', { planId })
    expect(s.plan(planId).status).toBe('inUse')
  })
})

describe('library follow: only draft plans, races, failures', () => {
  it('followOnly re-checks the status inside the command: a non-draft plan is left unchanged', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await changeTool(s)
    const snapshotId = stale(s, planId).libraryCopies[0]!.snapshotId
    const before = s.plan(planId)
    expect(
      await s.run('plan.libraryItem.update', { planId, snapshotId, followOnly: true }),
    ).toEqual({ updated: false })
    expect(s.plan(planId)).toEqual(before)
  })

  it('a UI status change queued before the follow runs wins: the plan is not touched', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await changeTool(s)
    const before = s.plan(planId).snapshots
    const settle = s.d.dispatch('plan.status.set', { planId, status: 'settledDesign' }, ui)
    const follow = followLibraryChanges(s.d, s.library.lookup)
    expectOk(await settle)
    const r = expectOk(await follow)
    expect(r).toEqual({ updated: 0, failed: [] })
    expect(s.plan(planId).snapshots).toEqual(before)
    expect(s.plan(planId).status).toBe('settledDesign')
  })

  it('a conflicting unrelated edit is retried: the draft still follows', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await changeTool(s)
    const rename = s.d.dispatch('plan.update', { planId, name: 'Renamed' }, ui)
    const follow = followLibraryChanges(s.d, s.library.lookup)
    expectOk(await rename)
    expect(expectOk(await follow)).toEqual({ updated: 1, failed: [] })
    expect(stale(s, planId).libraryCopies).toEqual([])
    expect(s.plan(planId).name).toBe('Renamed')
  })

  it('a copy that cannot be applied does not block the others; it stays a notice with the reason', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await changeTool(s)
    await setStockThickness(s, '10') // drill2 is 12.5 mm deep: the part no longer fits
    const r = expectOk(await followLibraryChanges(s.d, s.library.lookup))
    expect(r.updated).toBe(1)
    expect(r.failed).toEqual([
      expect.objectContaining({ planId, snapshotId: s.plan(planId).design.part.stock }),
    ])
    const copies = stale(s, planId).libraryCopies
    expect(copies).toEqual([
      expect.objectContaining({
        kind: 'stock',
        status: 'libraryChanged',
        blocked: expect.any(String),
      }),
    ])
    expect(copies[0]!.blocked).toContain("can't be applied")
    expect(warnings(s, planId).map((w) => w.code)).toContain('plan.libraryBlocked')
  })
})

describe('rebuild validity against the plan’s own stock copy', () => {
  async function thinStockDraft() {
    const s = await planSetup()
    const planId = await s.create()
    await setStockThickness(s, '15')
    expect(expectOk(await followLibraryChanges(s.d, s.library.lookup)).updated).toBe(1)
    return { s, planId }
  }

  it('an auto-rebuild that would not fit leaves the draft unchanged and reports why; the design edit succeeds', async () => {
    const { s, planId } = await thinStockDraft()
    const before = s.plan(planId)
    // fits the design's 20 mm stock, not the plan's 15 mm copy
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '15' })
    expect(s.plan(planId)).toEqual(before)
    expect(stale(s, planId).rebuildBlocked).toContain('rebuild blocked')
    expect(warnings(s, planId).map((w) => w.code)).toContain('plan.rebuildBlocked')
  })

  it('plan.rebuild of such a design fails with model.invariant', async () => {
    const { s, planId } = await thinStockDraft()
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '15' })
    await s.failWith('plan.rebuild', { planId }, 'model.invariant')
  })

  it('plan.warning.list reports a part that does not fit the plan’s stock copy', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const doc = JSON.parse(JSON.stringify(s.d.doc)) as ProjectDoc
    const stock = doc.plans[planId]!.snapshots.find((x) => x.kind === 'stock')!
    ;(stock.values as { thickness: unknown }).thickness = len('5')
    const q = PLAN_QUERIES.find((x) => x.name === 'plan.warning.list')!
    const r = expectOk(
      q.run(doc, { planId }, { source: ui, services: { workers: inProcessWorkers } }),
    ) as Warnings
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ code: 'plan.check', rule: 'stockFit' }),
    )
  })
})

describe('plan.design.operation.revert against the plan’s own stock copy', () => {
  it('fails when the taken version no longer fits the stock copy; the edit stays', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    // drill2–4 are 12.5 mm deep: make them fit a 10 mm stock in the plan, then thin the plan's copy
    for (const operationId of ['drill2', 'drill3', 'drill4'])
      await s.run('plan.design.operation.update', { planId, operationId, depth: '8' })
    await setStockThickness(s, '10')
    const stockCopy = s.plan(planId).design.part.stock
    await s.run('plan.libraryItem.update', { planId, snapshotId: stockCopy })
    const before = s.plan(planId)
    const planOperationId = opsOf(before).find((o) => o.designOperationIds.includes('drill2'))!.id
    expectErrCode(
      await s.d.dispatch('plan.design.operation.revert', { planId, planOperationId }, ui),
      'model.invariant',
    )
    expect(s.plan(planId)).toEqual(before)
  })
})

describe('rebuild order', () => {
  it('kept operations move after the operations whose surfaces they now start from', async () => {
    for (const status of ['draft', 'settledDesign'] as const) {
      const s = await planSetup()
      const planId = await s.create()
      await s.toStatus(planId, status)
      const partId = s.partId
      await s.run('design.pocket.add', {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['15', '15'],
          length: '12',
          width: '12',
          cornerRadius: '4',
        },
        depth: '2',
      })
      const drill1 = s.part().operations.findIndex((o) => o.id === 'drill1')
      await s.run('design.operation.move', { partId, operationId: 'pocket2', toIndex: drill1 })
      await s.run('design.drilling.update', { partId, operationId: 'drill1', on: 'pocket2.floor' })
      if (status === 'settledDesign') await s.run('plan.rebuild', { planId })
      const ids = designIds(s.plan(planId))
      expect(ids.indexOf('drill1')).toBeGreaterThan(ids.indexOf('pocket2'))
      expect(warnings(s, planId).filter((w) => w.code === 'plan.order')).toEqual([])
    }
  })
})

describe('stale detection by value', () => {
  it('part-level changes (general tolerance, name) are stale: partChanged', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.part.update', { partId: s.partId, generalTolerance: { length: '0.1 mm' } })
    expect(stale(s, planId).partChanged).toEqual(['generalTolerance'])
  })

  it('retyped identical values are neither changed in the design nor edited in the plan', async () => {
    const s = await planSetup()
    const draft = await s.create()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const draftBefore = s.plan(draft)
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      depth: '8.0 mm',
    })
    expect(stale(s, planId).operations).toEqual([])
    expect(s.plan(draft)).toEqual(draftBefore) // nothing to rebuild
    await s.run('plan.design.operation.update', { planId, operationId: 'facing1', depth: '0.50' })
    expect(stale(s, planId).operations).toEqual([])
    await s.run('plan.status.set', { planId, status: 'draft' }) // no plan edits: no flag needed
  })
})

describe('draft auto-rebuild hook', () => {
  it('writes only what changed (small patches)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    const event = s.d.log.since(0, { withPatches: true }).at(-1)!
    const planPatches = (event.type === 'command' ? event.patches : [])!.filter(
      (p) => p.path[0] === 'plans',
    )
    expect(planPatches.length).toBeGreaterThan(0)
    for (const p of planPatches) expect(p.path.length).toBeGreaterThan(3)
    expect(planPatches.every((p) => p.path[1] === planId)).toBe(true)
  })

  it('holds the patch law through the hook', async () => {
    const s = await planSetup()
    await s.create()
    const def = DESIGN_COMMANDS.find((c) => c.name === 'design.drilling.add') as DocumentCommand
    expectPatchLaw(s, def, { partId: s.partId, center: ['50', '50'], diameter: '6' })
  })

  it('a broken draft never fails a design command: it is skipped and reported', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const doc = JSON.parse(JSON.stringify(s.d.doc)) as ProjectDoc
    const plan = doc.plans[planId] as PlanDTO
    plan.snapshots = plan.snapshots.filter((x) => x.id !== plan.machine) // missing machine copy
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc,
      ids: fakeIds(),
      clock: fakeClock(0),
      services: { workers: inProcessWorkers, library: s.library },
    })
    expectOk(
      await d.dispatch(
        'design.drilling.add',
        { partId: s.partId, center: ['50', '50'], diameter: '6' },
        ui,
      ),
    )
    expect(d.doc.plans[planId]).toEqual(plan)
    const w = expectOk(d.query('plan.warning.list', { planId }, ui)).value as Warnings
    expect(w.warnings.map((x) => x.code)).toContain('plan.broken')
  })
})

describe('toolpath input hash', () => {
  it('includes the start position: the previous operation and the order', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    for (const op of opsOf(s.plan(planId)).filter((o) =>
      o.designOperationIds[0]!.startsWith('drill'),
    ))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
    const ops = opsOf(s.plan(planId))
    const last = ops.at(-1)!.id
    const before = expectOk(planOperationInputs(s.d.doc, planId, [last]))[0]!
    expect(before.previousPlanOperationId).toBe(ops.at(-2)!.id)
    // swap two earlier operations without touching the last one
    await s.run('plan.operation.update', {
      planId,
      planOperationId: ops.at(-2)!.id,
      overrides: { feedRate: '700' },
    })
    const after = expectOk(planOperationInputs(s.d.doc, planId, [last]))[0]!
    expect(after.inputHash).not.toBe(before.inputHash)
    expectErrCode(planOperationInputs(s.d.doc, 'nope'), 'input.malformed')
  })
})

describe('undo law of every plan command', () => {
  it('holds for each command, including the hook path', async () => {
    const s = await planSetup()
    const { planId } = (await expectUndoRedo(s, 'plan.create', { partId: s.partId })) as {
      planId: string
    }
    const ops = opsOf(s.plan(planId))
    const setupId = s.plan(planId).setups[0]!.id
    const pocketOp = ops.find((o) => o.designOperationIds.includes('pocket1'))!.id
    await changeTool(s)
    const toolCopy = stale(s, planId).libraryCopies[0]!.snapshotId
    const cases: [string, object | (() => object)][] = [
      ['plan.update', { planId, name: 'A' }],
      ['plan.libraryItem.update', { planId, snapshotId: toolCopy }],
      ['plan.machine.set', { planId, machineLibraryItemId: s.machineId }],
      ['plan.setup.update', { planId, setupId, retractHeight: '3', name: 'A', rotation: 90 }],
      ['plan.setup.split', { planId, setupId, planOperationIds: [ops.at(-1)!.id] }],
      ['plan.setup.move', { planId, setupId, toIndex: 1 }],
      ['plan.setup.merge', () => ({ planId, setupIds: s.plan(planId).setups.map((x) => x.id) })],
      [
        'plan.operation.update',
        { planId, planOperationId: ops[0]!.id, overrides: { spindleSpeed: '9000' } },
      ],
      ['plan.operation.move', { planId, planOperationId: ops.at(-1)!.id, toIndex: 1 }],
      [
        'plan.tool.assign',
        { planId, planOperationId: ops[0]!.id, toolLibraryItemId: s.tools.flat4 },
      ],
      ['plan.status.set', { planId, status: 'settledDesign' }],
      ['plan.design.operation.update', { planId, operationId: 'pocket1', depth: '7' }],
      ['plan.design.operation.revert', { planId, planOperationId: pocketOp }],
      ['plan.design.operation.update', { planId, operationId: 'pocket1', depth: '7' }],
      ['plan.rebuild', { planId, discardPlanEdits: true }],
      ['plan.duplicate', { planId }],
      ['plan.status.set', { planId, status: 'archived' }],
      ['plan.status.set', { planId }],
      ['plan.remove', { planId, confirm: true }],
    ]
    const covered = new Set(['plan.create', ...cases.map(([n]) => n)])
    expect(PLAN_COMMANDS.map((c) => c.name).filter((n) => !covered.has(n))).toEqual([])
    for (const [name, args] of cases)
      await expectUndoRedo(s, name, typeof args === 'function' ? args() : args)
  })
})
