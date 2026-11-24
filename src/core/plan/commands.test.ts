// Spec: docs/modes/plan-v0.1.md (Plans are snapshots, Plan status, Commands and queries v0.1).
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry, createRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import type { ProjectDoc } from '../project/document'
import { docToFiles, loadProjectFiles } from '../project/layout'
import { libraryInput } from '../library/library.fixture'
import { PLAN_COMMANDS, PLAN_QUERIES } from './commands'
import type { PlanStatus } from './plan.dto'
import {
  designIds,
  expectUndoRedo,
  flat6,
  opsOf,
  planSetup,
  src,
  stale,
  type PlanSetup,
} from './plan.fixture'
import { TRANSITIONS } from './status'

const ui = uiSource()
const STATUSES: PlanStatus[] = ['draft', 'settledDesign', 'finalized', 'inUse', 'archived']

describe('plan commands: registry', () => {
  it('registers the plan commands as document commands and the queries', () => {
    const reg = expectOk(
      createRegistry({
        commands: PLAN_COMMANDS,
        queries: PLAN_QUERIES,
      }),
    )
    for (const c of PLAN_COMMANDS) expect(reg.command(c.name).unwrap().kind).toBe('document')
    expect(PLAN_COMMANDS.map((c) => c.name)).toEqual([
      'plan.create',
      'plan.duplicate',
      'plan.update',
      'plan.remove',
      'plan.status.set',
      'plan.rebuild',
      'plan.libraryItem.update',
      'plan.design.operation.update',
      'plan.design.operation.revert',
      'plan.machine.set',
      'plan.setup.update',
      'plan.setup.split',
      'plan.setup.merge',
      'plan.setup.move',
      'plan.operation.update',
      'plan.operation.move',
      'plan.tool.assign',
      'plan.workholding.set',
    ])
    expect(PLAN_QUERIES.map((q) => q.name)).toEqual([
      'plan.list',
      'plan.get',
      'plan.operation.list',
      'plan.operation.feeds.get',
      'plan.stale.list',
      'plan.tool.suggest',
      'plan.warning.list',
    ])
  })
})

describe('plan.create', () => {
  it('snapshots the design and the stock, groups equal holes, suggests tools, orders by group', async () => {
    const s = await planSetup()
    const { planId, setupIds } = (await expectUndoRedo(s, 'plan.create', {
      partId: s.partId,
      machineLibraryItemId: s.machineId,
    })) as { planId: string; setupIds: string[] }
    const p = s.plan(planId)
    expect(p).toMatchObject({ name: 'Plan 1', status: 'draft' })
    expect(p.design.taken).toEqual(s.part())
    expect(p.design.part).toEqual(s.part())
    expect(p.design.hash).toMatch(/^[0-9a-f]{14}$/)
    expect(p.snapshots.find((x) => x.id === s.part().stock)).toEqual(
      s.d.doc.snapshots[s.part().stock],
    )
    expect(p.snapshots.find((x) => x.id === p.machine)).toMatchObject({ kind: 'machine' })
    // top operations only: one setup, as in v0.1 (no direction, no rotation stored)
    expect(setupIds).toHaveLength(1)
    expect(p.setups).toHaveLength(1)
    expect(p.setups[0]).toMatchObject({ id: setupIds[0], name: 'Top', workOffset: 'G54' })
    expect(p.setups[0]).not.toHaveProperty('direction')
    expect(p.setups[0]).not.toHaveProperty('rotation')
    expect(src(p.setups[0]!.clearanceHeight)).toBe('10 mm')
    expect(src(p.setups[0]!.retractHeight)).toBe('2 mm')
    // facing, drillings (same tool adjacent), pocket, profile
    expect(designIds(p)).toEqual([
      'facing1',
      'drill1',
      'drill3+drill4',
      'drill2',
      'pocket1',
      'profile1',
    ])
    const tools = (
      s.query('plan.operation.list', { planId }) as {
        operations: { tool: { libraryItemId: string } | null }[]
      }
    ).operations.map((o) => o.tool?.libraryItemId)
    const t = s.tools
    expect(tools).toEqual([t.flat6, t.drill6, t.drill6, t.flat4, t.bull6, t.flat6])
    // one copy per tool, shared by its plan operations
    expect(p.snapshots.filter((x) => x.kind === 'tool')).toHaveLength(4)
  })

  it('without a library or without fitting tools, operations have no tool (a plan.check error)', async () => {
    const s = await planSetup()
    // flat6 is the only profile tool: a 2 mm slot fits none
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      slotWidth: '2',
    })
    const planId = await s.create()
    const profile = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'profile1')!
    expect(profile.tool).toBeUndefined()
    const w = s.query('plan.warning.list', { planId }) as {
      warnings: { rule: string; planOperationId?: string }[]
    }
    expect(w.warnings).toContainEqual(
      expect.objectContaining({ rule: 'noTool', planOperationId: profile.id }),
    )
  })

  it('a project has several plans; unknown part → input.malformed', async () => {
    const s = await planSetup()
    await s.create()
    await s.create({ name: 'Second' })
    const list = s.query('plan.list', {}) as { plans: { name: string }[] }
    expect(list.plans.map((p) => p.name)).toEqual(['Plan 1', 'Second'])
    await s.failWith('plan.create', { partId: 'nope' }, 'input.malformed')
  })
})

describe('plan status', () => {
  async function planIn(status: PlanStatus) {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, status)
    return { s, planId }
  }

  for (const from of STATUSES)
    for (const to of STATUSES) {
      const allowed =
        from === to || TRANSITIONS[from].includes(to) || (from === 'archived' && to === 'draft') // archived from draft restores draft
      it(`${from} → ${to}: ${allowed ? 'allowed' : 'plan.status'}`, async () => {
        const { s, planId } = await planIn(from)
        if (!allowed) {
          const e = await s.failWith('plan.status.set', { planId, status: to }, 'plan.status')
          expect(e.issues[0]?.params).toEqual({ status: from, command: 'plan.status.set' })
          expect(s.plan(planId).status).toBe(from)
          return
        }
        if (from === to) {
          const before = s.d.doc
          await s.run('plan.status.set', { planId, status: to }) // no-op, no undo step
          expect(s.d.doc).toBe(before)
          return
        }
        await expectUndoRedo(s, 'plan.status.set', { planId, status: to })
        expect(s.plan(planId).status).toBe(to)
      })
    }

  it('archive stores the previous status; un-archive restores it and clears the field', async () => {
    const { s, planId } = await planIn('inUse')
    await expectUndoRedo(s, 'plan.status.set', { planId, status: 'archived' })
    expect(s.plan(planId)).toMatchObject({ status: 'archived', statusBeforeArchive: 'inUse' })
    expect((s.query('plan.list', {}) as { plans: unknown[] }).plans).toEqual([])
    expect(
      (s.query('plan.list', { includeArchived: true }) as { plans: unknown[] }).plans,
    ).toHaveLength(1)
    await s.failWith('plan.status.set', { planId, status: 'finalized' }, 'plan.status')
    await expectUndoRedo(s, 'plan.status.set', { planId })
    expect(s.plan(planId).status).toBe('inUse')
    expect(s.plan(planId).statusBeforeArchive).toBeUndefined()
    await s.failWith('plan.status.set', { planId }, 'plan.status') // not archived
  })

  it('finalized and inUse are read-only; inUse changes only by duplicate', async () => {
    for (const status of ['finalized', 'inUse', 'archived'] as const) {
      const { s, planId } = await planIn(status)
      const op = opsOf(s.plan(planId))[0]!.id
      for (const [name, args] of [
        ['plan.update', { planId, name: 'X' }],
        ['plan.rebuild', { planId }],
        ['plan.tool.assign', { planId, planOperationId: op, toolLibraryItemId: s.tools.flat4 }],
        ['plan.operation.update', { planId, planOperationId: op, overrides: { feedRate: '100' } }],
        ['plan.operation.move', { planId, planOperationId: op, toIndex: 1 }],
        ['plan.machine.set', { planId, machineLibraryItemId: s.machineId }],
        [
          'plan.setup.update',
          { planId, setupId: s.plan(planId).setups[0]!.id, retractHeight: '3' },
        ],
        ['plan.design.operation.update', { planId, operationId: 'facing1', depth: '1' }],
      ] as const) {
        const e = await s.failWith(name, args, 'plan.status')
        expect(e.message).toContain(status)
        expect(e.message).toContain(name)
      }
      const { planId: copy } = (await s.run('plan.duplicate', { planId })) as { planId: string }
      expect(s.plan(copy).status).toBe('settledDesign')
    }
    const { s, planId } = await planIn('inUse')
    await s.failWith('plan.remove', { planId, confirm: true }, 'plan.status')
  })

  it('plan.design.operation.update is for settledDesign only', async () => {
    const { s, planId } = await planIn('draft')
    await s.failWith(
      'plan.design.operation.update',
      { planId, operationId: 'facing1', depth: '1' },
      'plan.status',
    )
  })
})

describe('snapshot independence and stale detection', () => {
  it('a design edit leaves a settled plan unchanged but shows its stale operations', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const before = s.plan(planId)
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'profile1' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['50', '50'], diameter: '8' })
    expect(s.plan(planId)).toEqual(before)
    const st = stale(s, planId)
    expect(st.operations).toEqual([
      {
        operationId: 'pocket1',
        changedInDesign: true,
        removedFromDesign: false,
        editedInPlan: false,
        designToolChanged: false,
      },
      {
        operationId: 'profile1',
        changedInDesign: false,
        removedFromDesign: true,
        editedInPlan: false,
        designToolChanged: false,
      },
    ])
    // the new hole is never reported or added
    expect(JSON.stringify(st)).not.toContain('drill5')
    expect(designIds(s.plan(planId))).not.toContain('drill5')
  })

  it('plan.rebuild takes the current design; matched operations keep tool and settings', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const pocketOp = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'pocket1')!
    await s.run('plan.operation.update', {
      planId,
      planOperationId: pocketOp.id,
      overrides: { feedRate: '500' },
    })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'profile1' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['50', '50'], diameter: '6' })
    await expectUndoRedo(s, 'plan.rebuild', { planId })
    const p = s.plan(planId)
    expect(p.design.taken).toEqual(s.part())
    expect(stale(s, planId).operations).toEqual([])
    const pocket = opsOf(p).find((o) => o.id === pocketOp.id)!
    expect(pocket.tool).toBe(pocketOp.tool)
    expect(src(pocket.overrides.feedRate)).toBe('500')
    expect(designIds(p)).not.toContain('profile1')
    // the new through hole gets its own plan operation with a suggested tool, among the drillings
    const ids = designIds(p)
    expect(ids).toContain('drill5')
    expect(ids.indexOf('drill5')).toBeLessThan(ids.indexOf('pocket1'))
    expect(opsOf(p)[ids.indexOf('drill5')]!.tool).toBeDefined()
  })

  it('a drilling group splits when its holes no longer match', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.drilling.update', { partId: s.partId, operationId: 'drill4', depth: '10' })
    await s.run('plan.rebuild', { planId })
    expect(designIds(s.plan(planId))).toEqual(expect.arrayContaining(['drill3', 'drill4']))
  })
})

describe('draft follow on Apply (plan.draftFollow)', () => {
  const pending = (s: PlanSetup) =>
    s.query('project.pending.get', {}) as { count: number; changes: { kind: string }[] }

  it('design commands leave draft plans pending; Apply rebuilds them in its own undo step; settled plans stay', async () => {
    const s = await planSetup()
    const draft = await s.create()
    const settled = await s.create()
    await s.toStatus(settled, 'settledDesign')
    const settledBefore = s.plan(settled)
    const pocketTool = opsOf(s.plan(draft)).find((o) => o.designOperationIds[0] === 'pocket1')!.tool
    const draftBefore = s.plan(draft)
    const undoDepth = s.d.history.undoable.length
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['50', '50'], diameter: '6' })
    expect(s.d.history.undoable.length).toBe(undoDepth + 2) // no extra steps
    // the draft waits for Apply: unchanged, marked pendingApply
    expect(s.plan(draft)).toEqual(draftBefore)
    expect(stale(s, draft)).toMatchObject({ pendingApply: true })
    expect(stale(s, settled)).toMatchObject({ pendingApply: false })
    expect(s.query('plan.warning.list', { planId: draft })).toMatchObject({ pendingApply: true })
    const afterEdits = s.d.doc
    const outcome = (await s.run('project.apply', {})) as { plans: unknown[] }
    expect(outcome.plans).toEqual([{ planId: draft, status: 'rebuilt' }])
    expect(s.d.history.undoable.length).toBe(undoDepth + 3)
    expect(s.d.history.undoable.at(-1)?.command).toBe('project.apply')
    const p = s.plan(draft)
    expect(p.design.taken).toEqual(s.part())
    expect(stale(s, draft)).toMatchObject({ pendingApply: false, operations: [] })
    expect(opsOf(p).find((o) => o.designOperationIds[0] === 'pocket1')!.tool).toBe(pocketTool)
    expect(designIds(p)).toContain('drill5')
    expect(s.plan(settled)).toEqual(settledBefore)
    // undoing the Apply reverts the automation and keeps the edits pending
    await s.undo()
    expect(s.d.doc).toEqual(afterEdits)
    expect(stale(s, draft)).toMatchObject({ pendingApply: true })
    expect(pending(s).count).toBeGreaterThan(0)
  })

  it('a draft that does not follow its part is pending without a design change (recovered file)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    // a working folder written before the Apply: the part changed, the draft did not
    const doc = JSON.parse(JSON.stringify(s.d.doc)) as ProjectDoc
    const pocket = doc.parts[s.partId]!.operations.find((o) => o.id === 'pocket1')!
    const depth = (pocket as { depth: Record<string, unknown> }).depth
    Object.assign(depth, { source: '6', exact: { num: '6', den: '1' } })
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc,
      ids: fakeIds(),
      clock: fakeClock(0),
      services: { workers: inProcessWorkers, library: s.library },
    })
    const pendingOf = () =>
      expectOk(d.query('project.pending.get', {}, ui)).value as { changes: unknown[] }
    expect(pendingOf().changes).toEqual([
      expect.objectContaining({ kind: 'plan', planId, field: 'design' }),
    ])
    expect(expectOk(d.query('plan.stale.list', { planId }, ui)).value).toMatchObject({
      pendingApply: true,
    })
    const out = expectOk(await d.dispatch('project.apply', {}, ui)).value as { plans: unknown[] }
    expect(out.plans).toEqual([{ planId, status: 'rebuilt' }])
    expect(pendingOf().changes).toEqual([])
  })

  it('settledDesign → draft rebuilds from the current design', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '6' })
    expect(stale(s, planId).operations).toHaveLength(1)
    await expectUndoRedo(s, 'plan.status.set', { planId, status: 'draft' })
    expect(stale(s, planId).operations).toEqual([])
  })
})

describe('plan.design.operation.update (plan-only edits)', () => {
  it('edits the plan snapshot only; rebuild and → draft need discardPlanEdits', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const design = s.part()
    await expectUndoRedo(s, 'plan.design.operation.update', {
      planId,
      operationId: 'pocket1',
      depth: '7',
    })
    expect(s.part()).toEqual(design)
    const op = s.plan(planId).design.part.operations.find((o) => o.id === 'pocket1')!
    expect(src((op as { depth: unknown }).depth)).toBe('7')
    expect(stale(s, planId).operations).toEqual([
      {
        operationId: 'pocket1',
        changedInDesign: false,
        removedFromDesign: false,
        editedInPlan: true,
        designToolChanged: false,
      },
    ])
    for (const [name, args] of [
      ['plan.rebuild', { planId }],
      ['plan.status.set', { planId, status: 'draft' }],
    ] as const) {
      const e = await s.failWith(name, args, 'input.malformed')
      expect(e.issues[0]).toMatchObject({ path: ['discardPlanEdits'], rule: 'planEdits' })
    }
    await s.run('plan.rebuild', { planId, discardPlanEdits: true })
    expect(stale(s, planId).operations).toEqual([])
  })

  it('uses the design rules: wrong kind parameters, constraints and references', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const e = await s.failWith(
      'plan.design.operation.update',
      { planId, operationId: 'facing1', diameter: '3' },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['diameter'], rule: 'notForKind' })
    await s.failWith(
      'plan.design.operation.update',
      { planId, operationId: 'pocket1', depth: '-1' },
      'model.invariant',
    )
    await s.failWith(
      'plan.design.operation.update',
      { planId, operationId: 'nope1', depth: '1' },
      'input.malformed',
    )
  })
})

describe('plan.design.operation.revert (plan-v0.2)', () => {
  const planOpOf = (s: PlanSetup, planId: string, designId: string) =>
    opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(designId))!.id

  it('copies the taken version back for that plan operation only, one undo step', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await s.run('plan.design.operation.update', { planId, operationId: 'pocket1', depth: '7' })
    await s.run('plan.design.operation.update', { planId, operationId: 'facing1', depth: '1' })
    const r = await expectUndoRedo(s, 'plan.design.operation.revert', {
      planId,
      planOperationId: planOpOf(s, planId, 'pocket1'),
    })
    expect(r).toEqual({ reverted: ['pocket1'] })
    const p = s.plan(planId)
    expect(p.design.part.operations.find((o) => o.id === 'pocket1')).toEqual(
      p.design.taken.operations.find((o) => o.id === 'pocket1'),
    )
    expect(stale(s, planId).operations.map((o) => o.operationId)).toEqual(['facing1'])
    // the last edit reverted: the plan has no plan-only edits, a rebuild needs no discard
    await s.run('plan.design.operation.revert', {
      planId,
      planOperationId: planOpOf(s, planId, 'facing1'),
    })
    expect(s.plan(planId).design.part).toEqual(s.plan(planId).design.taken)
    await s.run('plan.rebuild', { planId })
  })

  it('an unedited plan operation reverts nothing and leaves no undo step', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    const before = s.d.doc
    const r = await s.run('plan.design.operation.revert', {
      planId,
      planOperationId: planOpOf(s, planId, 'pocket1'),
    })
    expect(r).toEqual({ reverted: [] })
    expect(s.d.doc).toBe(before)
  })

  it('is for settledDesign only and checks the plan operation', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const planOperationId = planOpOf(s, planId, 'pocket1')
    await s.failWith('plan.design.operation.revert', { planId, planOperationId }, 'plan.status')
    await s.toStatus(planId, 'finalized')
    await s.failWith('plan.design.operation.revert', { planId, planOperationId }, 'plan.status')
    await s.run('plan.status.set', { planId, status: 'settledDesign' })
    const e = await s.failWith(
      'plan.design.operation.revert',
      { planId, planOperationId: 'nope' },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'unknownPlanOperation' })
  })
})

describe('library copies', () => {
  async function changeTool(s: PlanSetup, id: string) {
    const item = s.query('library.tool.get', { id }) as { revision: number }
    await s.run('library.tool.update', {
      id,
      revision: item.revision,
      values: { ...libraryInput(flat6()), name: 'Flat 6 reground', diameter: '5.9' },
    })
  }

  it('a changed library item is a notice; plan.libraryItem.update re-imports one copy', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await s.toStatus(planId, 'settledDesign')
    await changeTool(s, s.tools.flat6)
    const copies = stale(s, planId).libraryCopies
    expect(copies).toEqual([expect.objectContaining({ kind: 'tool', status: 'libraryChanged' })])
    const snapshotId = copies[0]!.snapshotId
    await expectUndoRedo(s, 'plan.libraryItem.update', { planId, snapshotId })
    expect(stale(s, planId).libraryCopies).toEqual([])
    const copy = s.plan(planId).snapshots.find((x) => x.id === snapshotId)!
    expect(copy.values).toMatchObject({ name: 'Flat 6 reground' })
    expect(copy.takenAt).toBe('2026-11-17T10:00:00.000Z')
  })

  it('a removed item is a notice; its copy stays and cannot be re-imported', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const item = s.query('library.tool.get', { id: s.tools.flat4 }) as { revision: number }
    await s.run('library.tool.remove', {
      id: s.tools.flat4,
      revision: item.revision,
      confirm: true,
    })
    const copies = stale(s, planId).libraryCopies
    expect(copies).toEqual([expect.objectContaining({ status: 'libraryRemoved' })])
    await s.failWith(
      'plan.libraryItem.update',
      { planId, snapshotId: copies[0]!.snapshotId },
      'input.malformed',
    )
  })

  it('draft plans follow library changes on Apply (in its undo step); others only notify', async () => {
    const s = await planSetup()
    const draft = await s.create()
    const settled = await s.create()
    await s.toStatus(settled, 'settledDesign')
    await changeTool(s, s.tools.flat6)
    const pending = s.query('project.pending.get', {}) as { changes: unknown[] }
    expect(pending.changes).toEqual([
      expect.objectContaining({
        kind: 'library',
        libraryItemId: s.tools.flat6,
        label: 'Flat 6 reground changed in the library',
      }),
    ])
    expect(stale(s, draft)).toMatchObject({ pendingApply: true })
    expect(stale(s, settled)).toMatchObject({ pendingApply: false })
    const depth = s.d.history.undoable.length
    const outcome = (await s.run('project.apply', {})) as { plans: unknown[] }
    expect(outcome.plans).toEqual([{ planId: draft, status: 'followed' }])
    expect(s.d.history.undoable.length).toBe(depth + 1)
    expect(s.d.history.undoable.at(-1)?.command).toBe('project.apply')
    expect(stale(s, draft).libraryCopies).toEqual([])
    expect(stale(s, settled).libraryCopies).toHaveLength(1)
    expect((s.query('project.pending.get', {}) as { count: number }).count).toBe(0)
    // undo brings the change back as pending
    await s.undo()
    expect(stale(s, draft).libraryCopies).toHaveLength(1)
    expect((s.query('project.pending.get', {}) as { count: number }).count).toBe(1)
  })

  it('assigning a tool reuses an equal copy and drops unused ones; resets the preset', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const facing = opsOf(s.plan(planId))[0]!
    await s.run('plan.operation.update', {
      planId,
      planOperationId: facing.id,
      presetName: 'Alu finish',
    })
    await expectUndoRedo(s, 'plan.tool.assign', {
      planId,
      planOperationId: facing.id,
      toolLibraryItemId: s.tools.flat4,
    })
    const p = s.plan(planId)
    const after = opsOf(p)[0]!
    expect(after.presetName).toBeUndefined()
    // flat4 was already copied for drill2: reused
    const drill2 = opsOf(p).find((o) => o.designOperationIds[0] === 'drill2')!
    expect(after.tool).toBe(drill2.tool)
    expect(p.snapshots.filter((x) => x.kind === 'tool')).toHaveLength(4) // flat6 still used by profile
    await s.failWith(
      'plan.tool.assign',
      { planId, planOperationId: facing.id, toolLibraryItemId: 'nope' },
      'input.malformed',
    )
  })

  it('plan.machine.set takes a copy and replaces the previous one', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await expectUndoRedo(s, 'plan.machine.set', { planId, machineLibraryItemId: s.machineId })
    const p = s.plan(planId)
    expect(p.snapshots.filter((x) => x.kind === 'machine').map((x) => x.id)).toEqual([p.machine])
  })
})

describe('plan.duplicate, plan.update, plan.remove', () => {
  it('duplicate deep-copies the plan with its copies; the two are independent', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.toStatus(planId, 'finalized')
    const { planId: copy } = (await expectUndoRedo(s, 'plan.duplicate', { planId })) as {
      planId: string
    }
    const a = s.plan(planId)
    const b = s.plan(copy)
    expect(b).toEqual({ ...a, id: copy, name: 'Plan 1 (copy)', status: 'settledDesign' })
    await s.run('plan.operation.update', {
      planId: copy,
      planOperationId: opsOf(b)[0]!.id,
      overrides: { spindleSpeed: '12000' },
    })
    expect(s.plan(planId)).toEqual(a)
  })

  it('rename and remove (remove needs confirm: true)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    await expectUndoRedo(s, 'plan.update', { planId, name: 'Roughing' })
    expect(s.plan(planId).name).toBe('Roughing')
    await s.failWith('plan.remove', { planId, confirm: false }, 'input.malformed')
    await expectUndoRedo(s, 'plan.remove', { planId, confirm: true })
    expect(s.d.doc.plans).toEqual({})
    await s.failWith('plan.update', { planId, name: 'X' }, 'input.malformed')
  })
})

describe('setup, operations and order', () => {
  it('plan.setup.update checks clearance > retract > 0', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const setupId = s.plan(planId).setups[0]!.id
    await expectUndoRedo(s, 'plan.setup.update', { planId, setupId, clearanceHeight: '15' })
    const e = await s.failWith(
      'plan.setup.update',
      { planId, setupId, retractHeight: '20' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['aboveRetract'])
    await s.failWith(
      'plan.setup.update',
      { planId, setupId, retractHeight: '0' },
      'model.invariant',
    )
  })

  it('plan.operation.update sets preset, stickout, overrides and strategy, with sources', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const pocket = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'pocket1')!
    await expectUndoRedo(s, 'plan.operation.update', {
      planId,
      planOperationId: pocket.id,
      stickout: '30',
      overrides: { stepover: '2', feedRate: '600' },
      strategy: { entry: 'ramp', rampAngle: '5' },
    })
    const list = s.query('plan.operation.list', { planId }) as {
      operations: {
        id: string
        stickout: number
        feeds: Record<string, { value: number; source: string } | null>
        strategy: Record<string, unknown>
      }[]
    }
    const op = list.operations.find((o) => o.id === pocket.id)!
    expect(op.stickout).toBe(30)
    expect(op.feeds['stepover']).toMatchObject({ value: 2, source: 'override' })
    expect(op.feeds['feedRate']).toMatchObject({ value: 600, source: 'override' })
    expect(op.feeds['spindleSpeed']).toMatchObject({ source: 'preset' })
    expect(op.strategy).toMatchObject({ entry: 'ramp', rampAngle: 5 })
    expect(op.strategy['helixDiameter']).toBeCloseTo(0.8 * 6, 9)
    // null clears back to the default
    await s.run('plan.operation.update', {
      planId,
      planOperationId: pocket.id,
      overrides: { stepover: null },
      strategy: { entry: null },
    })
    const cleared = s.plan(planId).setups[0]!.operations.find((o) => o.id === pocket.id)!
    expect(cleared.overrides.stepover).toBeUndefined()
    expect(cleared.strategy.entry).toBeUndefined()
  })

  it('plan.operation.list gives a through profile its material depth (DF23)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const list = s.query('plan.operation.list', { planId }) as {
      operations: { designOperationIds: string[]; throughDepth: number | null }[]
    }
    const of = (id: string) => list.operations.find((o) => o.designOperationIds[0] === id)!
    // the test stock is 20 mm thick (design.fixture.ts)
    expect(of('profile1').throughDepth).toBe(20)
    expect(of('pocket1').throughDepth).toBeNull()
  })

  it('plan.operation.update rejects invalid values', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const ops = opsOf(s.plan(planId))
    const pocket = ops.find((o) => o.designOperationIds[0] === 'pocket1')!.id
    const drill = ops.find((o) => o.designOperationIds[0] === 'drill1')!.id
    const bad = async (
      planOperationId: string,
      args: object,
      code: 'model.invariant' | 'input.malformed',
    ) =>
      (
        await s.failWith('plan.operation.update', { planId, planOperationId, ...args }, code)
      ).issues.map((i) => i.rule)
    expect(await bad(pocket, { overrides: { stepover: '6' } }, 'model.invariant')).toEqual([
      'stepoverMax',
    ])
    expect(await bad(pocket, { stickout: '70' }, 'model.invariant')).toEqual(['stickoutRange'])
    expect(await bad(pocket, { strategy: { rampAngle: '45' } }, 'model.invariant')).toEqual([
      'range',
    ])
    expect(await bad(pocket, { strategy: { cycle: 'peck' } }, 'input.malformed')).toEqual([
      'notForKind',
    ])
    expect(await bad(drill, { overrides: { stepdown: '1' } }, 'model.invariant')).toEqual([
      'notForKind',
    ])
    expect(await bad(drill, { strategy: { cycle: 'helix' } }, 'model.invariant')).toEqual([
      'toolType',
    ])
    expect(await bad(pocket, { presetName: 'Nope' }, 'input.malformed')).toEqual(['unknownPreset'])
    await s.failWith(
      'plan.operation.update',
      { planId, planOperationId: pocket, overrides: { feedRate: '5 rpm' } },
      'quantity.unit',
    )
  })

  it('plan.operation.move keeps operations after the surfaces they start from (plan.order)', async () => {
    const s = await planSetup()
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      center: ['50', '30'],
      diameter: '6',
      bottom: 'flat',
      depth: '2',
    })
    const planId = await s.create()
    const ids = designIds(s.plan(planId))
    expect(ids.indexOf('drill5')).toBeGreaterThan(ids.indexOf('pocket1')) // default order respects it
    const drill5 = opsOf(s.plan(planId))[ids.indexOf('drill5')]!.id
    const e = await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: drill5, toIndex: 0 },
      'plan.order',
    )
    expect(e.issues[0]?.rule).toBe('onBefore')
    const profile = opsOf(s.plan(planId)).at(-1)!.id
    await expectUndoRedo(s, 'plan.operation.move', { planId, planOperationId: profile, toIndex: 1 })
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: { code: string }[] })
      .warnings
    expect(warnings.map((w) => w.code)).toContain('plan.loosePiece')
    await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: profile, toIndex: 99 },
      'input.malformed',
    )
    // DF66: a block from drill5 to the end refuses as its first operation does
    const at = designIds(s.plan(planId)).indexOf('drill5')
    const block = { planId, planOperationId: drill5, count: ids.length - at }
    await s.failWith('plan.operation.move', { ...block, toIndex: 0 }, 'plan.order')
  })

  it('plan.operation.move { count } moves a block (a tool run) in one undo step (DF66)', async () => {
    const s = await planSetup()
    const planId = await s.create()
    expect(designIds(s.plan(planId))).toEqual([
      'facing1',
      'drill1',
      'drill3+drill4',
      'drill2',
      'pocket1',
      'profile1',
    ])
    const drill2 = opsOf(s.plan(planId))[3]!.id
    await expectUndoRedo(s, 'plan.operation.move', {
      planId,
      planOperationId: drill2,
      count: 2,
      toIndex: 1,
    })
    expect(designIds(s.plan(planId))).toEqual([
      'facing1',
      'drill2',
      'pocket1',
      'drill1',
      'drill3+drill4',
      'profile1',
    ])
    // back down: toIndex is the block's first position after the move (at most length − count)
    await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: drill2, count: 2, toIndex: 5 },
      'input.malformed',
    )
    await s.run('plan.operation.move', { planId, planOperationId: drill2, count: 2, toIndex: 3 })
    expect(designIds(s.plan(planId)).slice(3, 5)).toEqual(['drill2', 'pocket1'])
    const profile = opsOf(s.plan(planId)).at(-1)!.id
    const e = await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: profile, count: 2, toIndex: 0 },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['count'], rule: 'range', params: { max: 1 } })
  })
})

describe('queries', () => {
  it('plan.tool.suggest ranks fitting tools: preset → used in plan → diameter', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const facing = opsOf(s.plan(planId))[0]!.id
    const r = s.query('plan.tool.suggest', { planId, planOperationId: facing }) as {
      tools: {
        toolLibraryItemId: string
        hasPreset: boolean
        usedInPlan: boolean
        reasons: string[]
      }[]
    }
    expect(r.tools.map((t) => t.toolLibraryItemId)).toEqual([s.tools.flat6, s.tools.flat4])
    // the design's auto choice picked Flat 6: it ranks first for that reason too
    expect(r.tools[0]?.reasons.slice(0, 2)).toEqual([
      "the design's tool",
      'has a preset for aluminium',
    ])
    const drill1 = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'drill1')!.id
    const d = s.query('plan.tool.suggest', { planId, planOperationId: drill1 }) as {
      tools: { toolLibraryItemId: string }[]
    }
    // a drill of the hole's size, or helical boring with a 4 mm end mill
    expect(d.tools.map((t) => t.toolLibraryItemId)).toEqual([s.tools.drill6, s.tools.flat4])
  })

  it('plan.warning.list: unresolved feeds are plan.check errors; machine checks are warnings', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const w = (
      s.query('plan.warning.list', { planId }) as {
        warnings: { code: string; severity: string; field?: string; rule: string }[]
      }
    ).warnings
    // the drill has no preset and no calculator data
    expect(w).toContainEqual(
      expect.objectContaining({
        code: 'plan.check',
        severity: 'error',
        field: 'spindleSpeed',
        rule: 'unresolved',
        // DF43: the field in words ("Spindle speed"), its key only in `field`
        message: 'spindle speed has no entered, preset or calculator value',
      }),
    )
    const drill1 = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'drill1')!.id
    await s.run('plan.operation.update', {
      planId,
      planOperationId: drill1,
      overrides: { spindleSpeed: '40000', feedRate: '100', plungeRate: '9000' },
    })
    const after = (
      s.query('plan.warning.list', { planId }) as {
        warnings: { code: string; planOperationId?: string; rule: string }[]
      }
    ).warnings.filter((x) => x.planOperationId === drill1)
    expect(after.map((x) => `${x.code}:${x.rule}`)).toEqual([
      'plan.machine:maxFeedRate',
      'plan.machine:spindleRange',
    ])
  })

  it('plan.get returns the record; unknown plans are input.malformed', async () => {
    const s = await planSetup()
    const planId = await s.create()
    expect(s.query('plan.get', { planId })).toEqual({ plan: s.plan(planId) })
    expect(s.d.query('plan.get', { planId: 'nope' }, ui).isErr()).toBe(true)
  })
})

describe('persistence', () => {
  it('plans are records plans/<id>.json and round-trip through the files', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opsOf(s.plan(planId))[0]!.id,
      overrides: { feedRate: '700' },
      strategy: { overshoot: '2' },
    })
    await s.toStatus(planId, 'archived')
    const files = expectOk(docToFiles(s.d.doc))
    expect([...files.keys()]).toContain(`plans/${planId}.json`)
    expect(expectOk(loadProjectFiles(files))).toEqual(s.d.doc)
  })
})

describe('undo law of every plan command', () => {
  it('holds for representative args of each command', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const op = opsOf(s.plan(planId))[0]!.id
    const profile = opsOf(s.plan(planId)).at(-1)!.id
    const cases: [string, object][] = [
      ['plan.update', { planId, name: 'A' }],
      [
        'plan.operation.update',
        { planId, planOperationId: op, overrides: { spindleSpeed: '9000' } },
      ],
      ['plan.operation.move', { planId, planOperationId: profile, toIndex: 1 }],
      ['plan.tool.assign', { planId, planOperationId: op, toolLibraryItemId: s.tools.flat4 }],
      ['plan.setup.update', { planId, setupId: s.plan(planId).setups[0]!.id, retractHeight: '3' }],
      ['plan.status.set', { planId, status: 'settledDesign' }],
    ]
    for (const [name, args] of cases) await expectUndoRedo(s, name, args)
  })
})
