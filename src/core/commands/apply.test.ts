// Apply core (task P1): pending changes by value, baseline markers through undo/redo,
// `project.apply` with hooks and jobs, implicit apply, auto-apply, stale-write exemption.
// Spec: docs/architecture/apply.md#testing
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { fail, Ok } from '../../shared/result'
import { testStock } from '../design/design.fixture'
import { LIBRARY_COMMANDS, LIBRARY_QUERIES } from '../library/commands'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc } from '../project/document'
import type { ActionEvent } from './action-log'
import { pendingChanges, type ApplyOutcome } from './apply'
import type { Source } from './context'
import { defineCommand, type AnyCommand, type ApplyHook, type ApplyJob } from './define'
import { createDispatcher, type CommandOutcome } from './dispatcher'
import type { HistoryLimits } from './history'
import { inProcessWorkers } from './jobs'
import {
  APP_HOOKS,
  APPLY_HOOKS,
  APPLY_JOBS,
  createProjectRegistry,
  createRegistry,
  designApplyWarnings,
  PROJECT_COMMANDS,
  PROJECT_QUERIES,
} from './registry'
import { agentSource, fakeClock, fakeIds, uiSource } from './testing'

const ui = uiSource()
const agent = agentSource()

const rect = (length: string, width: string) => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  cornerRadius: '3',
})

/**
 * Derived document work: writes "applied #<run>: <pending count>" into the project name (a field
 * no pending key tracks), so every Apply changes the document.
 */
function nameHook(log: string[] = [], name = 'test.name'): ApplyHook {
  let runs = 0
  return {
    name,
    apply(draft, pending) {
      log.push(name)
      draft.name = `applied #${++runs}: ${pending.length}`
      return Ok({ plans: [{ planId: 'plan-x', status: 'rebuilt' as const }] })
    },
  }
}

async function setup(
  opts: {
    applyHooks?: readonly ApplyHook[]
    applyJobs?: readonly ApplyJob[]
    commands?: readonly AnyCommand[]
    historyLimits?: HistoryLimits
  } = {},
) {
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const registry = expectOk(
    createRegistry({
      commands: [...PROJECT_COMMANDS, ...LIBRARY_COMMANDS, ...(opts.commands ?? [])],
      queries: [...PROJECT_QUERIES, ...LIBRARY_QUERIES],
      applyHooks: opts.applyHooks ?? [],
      applyJobs: opts.applyJobs ?? [],
      applyWarnings: designApplyWarnings,
    }),
  )
  const d = createDispatcher({
    registry,
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 10, 21)),
    services: { workers: inProcessWorkers, library },
    ...(opts.historyLimits === undefined ? {} : { historyLimits: opts.historyLimits }),
  })
  const events: ActionEvent[] = []
  d.log.subscribe({}, (e) => events.push(e))
  const run = async (name: string, args: object, source: Source = ui) =>
    expectOk(await d.dispatch(name, args, source))
  const stock = (await run('library.stock.add', { values: testStock() })).value as { id: string }
  const { partId } = (
    await run('design.part.add', { name: 'Bracket', stockLibraryItemId: stock.id })
  ).value as { partId: string }
  await run('design.pocket.add', { partId, shape: rect('40', '25'), depth: '5' })
  const apply = async (source: Source = ui) =>
    (await run('project.apply', {}, source)).value as ApplyOutcome
  // start clean: the part and the pocket are applied
  await apply()
  const pending = (source: Source = ui) =>
    expectOk(d.query('project.pending.get', {}, source)).value as {
      count: number
      changes: { field?: string; operationId?: string; label: string; source: Source }[]
    }
  const depth = (value: string, source: Source = ui) =>
    run('design.pocket.update', { partId, operationId: 'pocket1', depth: value }, source)
  return { d, events, run, apply, pending, depth, partId, library }
}

describe('pending changes', () => {
  it('counts changed fields by value: retyping, repeated edits and editing back', async () => {
    const t = await setup()
    expect(t.pending().count).toBe(0)
    await t.depth('5.0 mm') // same value, other notation
    expect(t.pending().count).toBe(0)
    for (const v of ['6', '7', '8', '9', '8']) await t.depth(v)
    expect(t.pending().changes).toEqual([
      expect.objectContaining({
        kind: 'design',
        partId: t.partId,
        operationId: 'pocket1',
        field: 'depth',
        label: 'Pocket 1: depth',
        source: ui,
      }),
    ])
    await t.depth('5')
    expect(t.pending().count).toBe(0)
  })

  it('keys nested fields apart, ignores names, and keys added / removed / moved operations', async () => {
    const t = await setup()
    await t.run('design.pocket.update', {
      partId: t.partId,
      operationId: 'pocket1',
      name: 'Renamed',
      shape: { ...rect('40', '25'), cornerRadius: '4' },
      floorRadius: '1',
    })
    expect(t.pending().changes.map((c) => c.field)).toEqual(['shape.cornerRadius', 'floorRadius'])
    await t.run('design.drilling.add', { partId: t.partId, center: ['15', '15'], diameter: '6' })
    await t.run('design.operation.move', { partId: t.partId, operationId: 'drill1', toIndex: 0 })
    expect(t.pending().changes.map((c) => c.label)).toEqual([
      'Drilling 1 added',
      'Renamed: shape.cornerRadius',
      'Renamed: floorRadius',
    ])
    await t.apply()
    await t.run('design.operation.move', { partId: t.partId, operationId: 'drill1', toIndex: 1 })
    expect(t.pending().changes.map((c) => c.label)).toEqual(['Drilling 1 moved'])
    await t.run('design.operation.remove', { partId: t.partId, operationId: 'pocket1' })
    expect(t.pending().changes.map((c) => c.label)).toEqual(['Renamed removed'])
  })

  it('a new part is pending through its operations only: an empty part (or a reference) is not', async () => {
    const t = await setup()
    const empty = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
    const doc = t.d.doc
    const part = doc.parts[t.partId]!
    // the part with its pocket against a project without it: the pocket, not the part
    expect(pendingChanges(doc, empty)).toEqual([
      expect.objectContaining({ partId: t.partId, field: 'added', label: 'Pocket 1 added' }),
    ])
    // the part alone (as right after "Create part", or with only a reference imported): nothing
    const bare = { ...doc, parts: { [t.partId]: { ...part, operations: [] } } }
    expect(pendingChanges(bare, empty)).toEqual([])
    // removing a part stays pending (its plans follow on Apply)
    expect(pendingChanges(empty, doc).map((c) => c.label)).toEqual(['Bracket removed'])
  })

  it('is computed from the documents alone (pure function)', () => {
    const doc = newProjectDoc({ name: 'A', unitSystem: 'mm' })
    expect(pendingChanges(doc, doc)).toEqual([])
    expect(pendingChanges({ ...doc, name: 'B' }, doc)).toEqual([])
  })
})

describe('project.apply', () => {
  it('runs the hooks in order with the pending set as one "Apply N changes" entry', async () => {
    const order: string[] = []
    const seen: number[] = []
    const t = await setup({
      applyHooks: [
        nameHook(order, 'first'),
        {
          name: 'second',
          apply: (_draft, pending) => (
            order.push('second'),
            seen.push(pending.length),
            Ok(undefined)
          ),
        },
      ],
    })
    order.length = 0
    seen.length = 0
    await t.depth('8')
    await t.run('design.pocket.update', {
      partId: t.partId,
      operationId: 'pocket1',
      floorRadius: '1',
    })
    const before = t.d.history.undoable.length
    const out = await t.apply()
    expect(order).toEqual(['first', 'second'])
    expect(seen).toEqual([2])
    expect(out).toMatchObject({
      changes: 2,
      plans: [{ planId: 'plan-x', status: 'rebuilt' }],
      toolChanges: [],
      jobIds: [],
      warnings: [{ partId: t.partId, warnings: expect.any(Array) }],
    })
    expect(t.d.doc.name).toBe('applied #2: 2')
    expect(t.d.history.undoable).toHaveLength(before + 1)
    expect(t.d.history.undoable.at(-1)).toMatchObject({
      command: 'project.apply',
      title: 'Apply 2 changes',
      seq: out.entrySeq,
    })
    expect(t.pending().count).toBe(0)
    const last = expectOk(t.d.query('project.pending.get', {}, ui)).value as {
      lastApply: { entrySeq: number }
    }
    expect(last.lastApply.entrySeq).toBe(out.entrySeq)
  })

  it('undo of Apply reverts the derived work and the edits are pending again; redo re-applies', async () => {
    const t = await setup({ applyHooks: [nameHook()] })
    await t.depth('8')
    await t.apply()
    await t.run('history.undo', {})
    expect(t.d.doc.name).toBe('applied #1: 1') // the setup's Apply (the part) stays
    expect(t.pending().changes.map((c) => c.field)).toEqual(['depth'])
    await t.run('history.redo', {})
    expect(t.pending().count).toBe(0)
    // undo twice: the Apply, then the edit (pending shrinks back to nothing)
    await t.run('history.undo', {})
    await t.run('history.undo', {})
    expect(t.pending().count).toBe(0)
  })

  it('without document changes: no entry, the marker goes on the top edit; nothing pending is a no-op', async () => {
    const t = await setup()
    await t.depth('8')
    const n = t.d.history.undoable.length
    const rev = t.d.revision
    const out = await t.apply()
    expect(out).toMatchObject({ changes: 1, entrySeq: null })
    expect(t.d.history.undoable).toHaveLength(n)
    expect(t.d.revision).toBe(rev)
    expect(t.pending().count).toBe(0)
    // undoing the marked edit takes its marker along: the baseline falls back with it
    await t.run('history.undo', {})
    expect(t.pending().count).toBe(0)
    await t.run('history.redo', {})
    expect(t.pending().count).toBe(0)
    const events = t.events.length
    expect(await t.apply()).toMatchObject({ changes: 0, entrySeq: null, jobIds: [] })
    expect(t.events.slice(events)).toEqual([
      expect.objectContaining({ type: 'command', name: 'project.apply' }),
    ])
  })

  it('a hook Err or throw fails the Apply and leaves document, history and pending unchanged', async () => {
    let mode: 'ok' | 'err' | 'throw' = 'ok'
    const t = await setup({
      applyHooks: [
        {
          name: 'maybe',
          apply(draft) {
            draft.name = 'touched'
            if (mode === 'err') return fail('model.invariant', 'no')
            if (mode === 'throw') throw new TypeError('boom')
            return Ok(undefined)
          },
        },
      ],
    })
    await t.depth('8')
    for (const [m, code] of [
      ['err', 'model.invariant'],
      ['throw', 'internal.unexpected'],
    ] as const) {
      mode = m
      const doc = t.d.doc
      const n = t.d.history.undoable.length
      expectErrCode(await t.d.dispatch('project.apply', {}, ui), code)
      expect(t.d.doc).toBe(doc)
      expect(t.d.history.undoable).toHaveLength(n)
      expect(t.pending().count).toBe(1)
    }
  })

  it('a gesture does not merge across an Apply, and its cancel keeps the applied value', async () => {
    const t = await setup()
    const step = (v: string) =>
      t.d.dispatch(
        'design.pocket.update',
        { partId: t.partId, operationId: 'pocket1', depth: v },
        ui,
        { gesture: 'g1' },
      )
    expectOk(await step('6'))
    const n = t.d.history.undoable.length
    await t.apply() // no hook: marks the gesture entry
    expectOk(await step('7'))
    expect(t.d.history.undoable).toHaveLength(n + 1)
    expect(t.pending().changes.map((c) => c.field)).toEqual(['depth'])
  })

  it('the history cap keeps the newest dropped marker as the baseline', async () => {
    const t = await setup({ historyLimits: { maxEntries: 2, maxChars: 50_000_000 } })
    await t.depth('6')
    await t.apply()
    for (const v of ['7', '8', '9']) await t.depth(v) // drops the marked entry
    expect(t.pending().changes.map((c) => c.field)).toEqual(['depth'])
    await t.depth('6')
    expect(t.pending().count).toBe(0)
  })

  it('starts the apply jobs after the document phase; a newer Apply aborts the one it supersedes', async () => {
    const gates: (() => void)[] = []
    const job = defineCommand({
      kind: 'job',
      name: 'plan.toolpath.regenerate',
      summary: 'Test apply job.',
      title: () => 'Regenerate',
      machine: false,
      args: z.object({ planId: z.string() }),
      result: z.object({ name: z.string() }),
      async run(doc, _args, ctx) {
        await new Promise<void>((resolve) => {
          gates.push(resolve)
          ctx.signal.addEventListener('abort', () => resolve())
        })
        await ctx.checkpoint()
        return Ok({ name: doc.name })
      },
    })
    const t = await setup({
      commands: [job],
      applyHooks: [nameHook()],
      applyJobs: [
        {
          name: 'test.toolpaths',
          jobs: () => [
            { command: 'plan.toolpath.regenerate', args: { planId: 'p1' }, key: 'tp:p1' },
          ],
        },
      ],
    })
    await t.depth('8')
    const first = await t.apply()
    expect(first.jobIds).toHaveLength(1)
    const applying = () =>
      (expectOk(t.d.query('project.pending.get', {}, ui)).value as { applying: string[] }).applying
    expect(applying()).toEqual(first.jobIds)
    await t.depth('9')
    const second = await t.apply()
    const firstJob = t.d.job(first.jobIds[0]!).unwrap()
    expectErrCode(await firstJob.result, 'op.aborted')
    gates.splice(0).forEach((g) => g())
    const done = expectOk(await t.d.job(second.jobIds[0]!).unwrap().result)
    expect(done).toEqual({ name: 'applied #3: 1' }) // ran on the applied document
    expect(applying()).toEqual([])
    // the Apply event comes before its job's events
    const i = t.events.findIndex(
      (e) => e.type === 'command' && e.name === 'project.apply' && e.seq === second.entrySeq,
    )
    const j = t.events.findIndex((e) => e.type === 'job' && e.jobId === second.jobIds[0])
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })
})

describe('implicit apply (applyFirst)', () => {
  it('runs project.apply in the same queue turn before the command', async () => {
    const effect = defineCommand({
      kind: 'effect',
      name: 'project.file.export',
      summary: 'Test export.',
      title: () => 'Export',
      machine: false,
      applyFirst: true,
      args: z.object({}),
      result: z.object({ name: z.string() }),
      run: async (doc) => Ok({ name: doc.name }),
    })
    const t = await setup({ commands: [effect], applyHooks: [nameHook()] })
    await t.depth('8')
    const from = t.events.length
    const out = await t.run('project.file.export', {})
    expect(out.value).toEqual({ name: 'applied #2: 1' })
    expect(t.events.slice(from).map((e) => ('name' in e ? e.name : e.type))).toEqual([
      'project.apply',
      'project.file.export',
    ])
    expect(t.events[from]).toMatchObject({ args: { before: 'project.file.export' } })
    expect(t.pending().count).toBe(0)
  })

  it('plan.create applies first; plan.status.set only into draft or un-archiving', async () => {
    const t = await setup({ applyHooks: [nameHook()] })
    await t.depth('8')
    const { planId } = (await t.run('plan.create', { partId: t.partId })).value as {
      planId: string
    }
    expect(t.pending().count).toBe(0)
    expect(t.d.history.undoable.at(-2)).toMatchObject({ command: 'project.apply' })
    await t.depth('9')
    await t.run('plan.status.set', { planId, status: 'settledDesign' })
    expect(t.pending().count).toBe(1)
    await t.run('plan.status.set', { planId, status: 'draft' })
    expect(t.pending().count).toBe(0)
    // un-archiving may restore draft (it then rebuilds): it applies first too (P2)
    await t.run('plan.status.set', { planId, status: 'archived' })
    await t.depth('10')
    expect(t.pending().count).toBe(1)
    await t.run('plan.status.set', { planId })
    expect(t.pending().count).toBe(0)
  })

  it('a failing Apply fails the command, which does not run', async () => {
    let broken = false
    const t = await setup({
      applyHooks: [
        { name: 'maybe', apply: () => (broken ? fail('model.invariant', 'no') : Ok(undefined)) },
      ],
    })
    await t.depth('8')
    broken = true
    const plans = Object.keys(t.d.doc.plans).length
    expectErrCode(await t.d.dispatch('plan.create', { partId: t.partId }, ui), 'model.invariant')
    expect(Object.keys(t.d.doc.plans)).toHaveLength(plans)
  })

  it('the app registry marks exactly the commands apply.md lists', () => {
    const reg = expectOk(createProjectRegistry())
    const flagged = reg.commands.filter((c) => c.applyFirst !== undefined).map((c) => c.name)
    expect(flagged.sort()).toEqual(
      [
        'plan.create',
        'plan.export',
        'plan.rebuild',
        'plan.status.set',
        'project.save',
        'run.job.start',
      ].sort(),
    )
    // P2: the deferred reactions, in apply.md's order; the one document hook is the instant
    // Clones expansion (v0.4 F5)
    expect(APPLY_HOOKS.map((h) => h.name)).toEqual([
      'design.toolAutoChoice',
      'design.clonesFollow',
      'plan.draftFollow',
    ])
    expect(APPLY_JOBS.map((j) => j.name)).toEqual(['plan.toolpaths'])
    expect(APP_HOOKS.map((h) => h.name)).toEqual(['design.clonesFollow'])
  })
})

describe('auto-apply and stale writes', () => {
  it('dispatch { apply: true } applies in the same turn and returns applied', async () => {
    const t = await setup({ applyHooks: [nameHook()] })
    const out = expectOk(
      await t.d.dispatch(
        'design.pocket.update',
        { partId: t.partId, operationId: 'pocket1', depth: '8' },
        ui,
        { apply: true },
      ),
    ) as CommandOutcome
    expect(out.applied).toMatchObject({ changes: 1 })
    expect(out.revision).toBe(t.d.revision)
    expect(t.d.history.undoable.slice(-2).map((e) => e.command)).toEqual([
      'design.pocket.update',
      'project.apply',
    ])
    expect(t.events.at(-1)).toMatchObject({ name: 'project.apply', args: { auto: true } })
  })

  it('an Apply error leaves the edit committed and pending, the call Ok with applied.error', async () => {
    let broken = false
    const t = await setup({
      applyHooks: [
        { name: 'maybe', apply: () => (broken ? fail('model.invariant', 'no') : Ok(undefined)) },
      ],
    })
    broken = true
    const out = expectOk(
      await t.d.dispatch(
        'design.pocket.update',
        { partId: t.partId, operationId: 'pocket1', depth: '8' },
        ui,
        { apply: true },
      ),
    ) as CommandOutcome
    expect(out.applied).toMatchObject({ error: { code: 'model.invariant' } })
    expect(t.pending().count).toBe(1)
  })

  it('project.apply is exempt from the baseline rule and never counts as a read', async () => {
    const t = await setup({ applyHooks: [nameHook()] })
    await t.depth('8') // the user's edit; the agent never read the project
    const out = expectOk(await t.d.dispatch('project.apply', {}, agent))
    expect((out.value as ApplyOutcome).changes).toBe(1)
    const edit = { partId: t.partId, operationId: 'pocket1', depth: '9' }
    expectErrCode(await t.d.dispatch('design.pocket.update', edit, agent), 'command.conflict')
    // expectedRevision still applies
    expectErrCode(
      await t.d.dispatch('project.apply', {}, agent, { expectedRevision: 0 }),
      'command.conflict',
    )
  })
})
