import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Ok, fail } from '../../shared/result'
import { newProjectDoc, type ProjectDoc } from '../project/document'
import type { ActionEvent } from './action-log'
import {
  crashCommand,
  generateName,
  getProject,
  jogMachine,
  makeExportEffect,
  renameProject,
  setUnitSystem,
} from './commands.fixture'
import type { Source } from './context'
import type { AnyCommand, DocumentHook } from './define'
import { createDispatcher, type DispatcherOptions } from './dispatcher'
import { applyDocPatches } from './history'
import { createAppRegistry, createRegistry } from './registry'
import { runCommand } from './testing'
import { agentSource, fakeClock, fakeIds, uiSource } from './testing'

const initial = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })
const ui = uiSource()
const agent = agentSource()
const otherAgent = agentSource('agent-2')

function setup(extra: readonly AnyCommand[] = [], opts: Partial<DispatcherOptions> = {}) {
  const registry = expectOk(
    createRegistry({
      commands: [renameProject, setUnitSystem, generateName, crashCommand, jogMachine, ...extra],
      queries: [getProject],
    }),
  )
  const d = createDispatcher({
    registry,
    doc: initial,
    ids: fakeIds(),
    clock: fakeClock(Date.UTC(2026, 0, 1)),
    ...opts,
  })
  const events: ActionEvent[] = []
  d.log.subscribe({ withPatches: true }, (e) => events.push(e))
  return { d, events }
}

const rename = (d: ReturnType<typeof setup>['d'], name: string, source: Source = ui) =>
  d.dispatch('project.name.update', { name }, source)

describe('dispatch: document commands', () => {
  it('commits, increments revision, records history and logs one event', async () => {
    const { d, events } = setup()
    const out = expectOk(await rename(d, 'Plate'))
    expect(out).toEqual({ value: { name: 'Plate' }, revision: 1 })
    expect(d.doc).toEqual({ name: 'Plate', unitSystem: 'mm', parts: {}, snapshots: {}, plans: {} })
    expect(d.revision).toBe(1)
    expect(d.history.undoable).toHaveLength(1)
    expect(d.history.undoable[0]).toMatchObject({
      seq: 1,
      command: 'project.name.update',
      args: { name: 'Plate' },
      source: ui,
      title: 'Rename project',
      revisionBefore: 0,
      revisionAfter: 1,
      at: '2026-01-01T00:00:00.000Z',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      seq: 1,
      type: 'command',
      name: 'project.name.update',
      source: ui,
      revision: 1,
      outcome: { ok: true, value: { name: 'Plate' } },
      patches: [{ op: 'replace', path: ['name'], value: 'Plate' }],
    })
  })

  it('Err → doc, revision and history unchanged, no patches; failure is logged', async () => {
    const { d, events } = setup()
    expectErrCode(await rename(d, ' '), 'model.invariant')
    expect(d.doc).toBe(initial)
    expect(d.revision).toBe(0)
    expect(d.history.undoable).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'command', revision: 0, outcome: { ok: false } })
    expect(events[0]).not.toHaveProperty('patches')
  })

  it('a stray throw → internal.unexpected, nothing committed', async () => {
    const { d } = setup()
    expectErrCode(await d.dispatch('project.name.crash', {}, ui), 'internal.unexpected')
    expect(d.doc).toBe(initial)
    expect(d.revision).toBe(0)
  })

  it('unknown names and malformed args fail early and are logged', async () => {
    const { d, events } = setup()
    expectErrCode(await d.dispatch('project.nope.update', {}, ui), 'command.unknown')
    expectErrCode(await d.dispatch('project.name.update', { name: 1 }, ui), 'input.malformed')
    expect(events.map((e) => e.type === 'command' && e.outcome.ok)).toEqual([false, false])
  })

  it('unknown arg keys → input.malformed naming the key; nothing runs (commands and queries)', async () => {
    const { d, events } = setup()
    const e = expectErrCode(
      await d.dispatch('project.name.update', { name: 'Plate', nmae: 'x' }, ui),
      'input.malformed',
    )
    expect(e.issues).toEqual([
      expect.objectContaining({ path: ['nmae'], rule: 'unrecognized_keys' }),
    ])
    expect(d.revision).toBe(0)
    expect(events).toHaveLength(1)
    const j = expectErrCode(
      await d.dispatch('run.machine.jog', { dxMm: 1, dy: 2 }, ui),
      'input.malformed',
    )
    expect(j.issues[0]?.path).toEqual(['dy'])
    const q = expectErrCode(d.query('project.doc.get', { extra: true }, ui), 'input.malformed')
    expect(q.issues[0]?.path).toEqual(['extra'])
    // also without a dispatcher
    expectErrCode(runCommand(initial, renameProject, { name: 'P', x: 1 }).result, 'input.malformed')
  })

  it('every registered app command rejects unknown keys (e.g. library and project.save)', async () => {
    const d = createDispatcher({ registry: expectOk(createAppRegistry()), doc: initial })
    const save = expectErrCode(
      await d.dispatch('project.save', { confirm: true, force: 1 }, ui),
      'input.malformed',
    )
    expect(save.issues[0]?.path).toEqual(['force'])
    const lib = expectErrCode(
      await d.dispatch('library.stock.remove', { id: 's', confirm: true, purge: true }, ui),
      'input.malformed',
    )
    expect(lib.issues[0]?.path).toEqual(['purge'])
  })

  it('empty patches = no-op: no revision, no history entry', async () => {
    const { d, events } = setup()
    expectOk(await d.dispatch('project.unitSystem.update', { unitSystem: 'mm' }, ui))
    expect(d.revision).toBe(0)
    expect(d.history.undoable).toEqual([])
    expect(events).toHaveLength(1)
  })

  it('committed documents are frozen', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'Plate'))
    expect(Object.isFrozen(d.doc)).toBe(true)
  })
})

describe('robustness', () => {
  const titleCrash: AnyCommand = {
    ...renameProject,
    name: 'project.title.crash',
    title: () => {
      throw new Error('title bug')
    },
  }
  const leakDraft: AnyCommand = {
    ...renameProject,
    name: 'project.draft.leak',
    run(draft: { name: string }, args: { name: string }) {
      draft.name = args.name
      return Ok({ leaked: draft })
    },
  }
  const noteCommand: AnyCommand = {
    ...setUnitSystem,
    name: 'project.note.update',
    args: z.object({ unitSystem: z.enum(['mm', 'inch']), note: z.string() }),
  }
  const throwingSchema: AnyCommand = {
    ...renameProject,
    name: 'project.schema.crash',
    args: z.object({}).refine(() => {
      throw new Error('refine bug')
    }),
  }

  it('a throwing title → internal.unexpected, nothing committed, dispatch resolves', async () => {
    const { d, events } = setup([titleCrash])
    expectErrCode(await d.dispatch('project.title.crash', { name: 'X' }, ui), 'internal.unexpected')
    expect(d.doc).toBe(initial)
    expect(d.revision).toBe(0)
    expect(d.history.undoable).toEqual([])
    expect(events).toHaveLength(1)
  })

  it('a throwing log listener does not break dispatch, state or other listeners', async () => {
    const reported: unknown[] = []
    const { d, events } = setup([], { onListenerError: (e) => reported.push(e.code) })
    d.log.subscribe({}, () => {
      throw new Error('listener bug')
    })
    const after: number[] = []
    d.log.subscribe({}, (e) => after.push(e.seq))
    expectOk(await rename(d, 'A'))
    expect(d.revision).toBe(1)
    expect(d.history.undoable).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(after).toEqual([1])
    expect(reported).toEqual(['internal.unexpected'])
  })

  it('dispatch and query never reject/throw, even when a schema throws', async () => {
    const { d } = setup([throwingSchema])
    expectErrCode(await d.dispatch('project.schema.crash', {}, ui), 'internal.unexpected')
    expectOk(await rename(d, 'still works'))
  })

  it('stored args and patches are deeply frozen and cannot corrupt undo/redo', async () => {
    const { d } = setup()
    let mutated = true
    d.log.subscribe({ withPatches: true }, (e) => {
      if (e.type !== 'command' || e.patches === undefined) return
      try {
        ;(e.patches[0] as { value: unknown }).value = 'evil'
      } catch {
        mutated = false
      }
    })
    expectOk(await rename(d, 'A'))
    expect(mutated).toBe(false)
    const entry = d.history.undoable[0]
    expect(Object.isFrozen(entry?.args)).toBe(true)
    expect(() => {
      ;(entry?.inversePatches[0] as { value: unknown }).value = 'evil'
    }).toThrow(TypeError)
    expectOk(await d.dispatch('history.undo', {}, ui))
    expect(d.doc).toEqual(initial)
    expectOk(await d.dispatch('history.redo', {}, ui))
    expect(d.doc.name).toBe('A')
  })

  it('a result containing draft proxies → internal.unexpected, no commit, log stays JSON', async () => {
    const { d } = setup([leakDraft])
    expectErrCode(await d.dispatch('project.draft.leak', { name: 'X' }, ui), 'internal.unexpected')
    expect(d.doc).toBe(initial)
    expect(d.revision).toBe(0)
    expect(() => JSON.stringify(d.log.since(0, { withPatches: true }))).not.toThrow()
  })

  it('history size counts args, not only patches', async () => {
    const { d } = setup([noteCommand], { historyLimits: { maxEntries: 100, maxChars: 1500 } })
    const note = 'n'.repeat(1000)
    expectOk(await d.dispatch('project.note.update', { unitSystem: 'inch', note }, ui))
    expectOk(await d.dispatch('project.note.update', { unitSystem: 'mm', note }, ui))
    expect(d.history.undoable).toHaveLength(1)
  })
})

describe('undo / redo', () => {
  it('undo applies inverse patches; redo re-applies patches without re-running the handler', async () => {
    const { d, events } = setup()
    expectOk(await d.dispatch('project.name.generate', {}, ui))
    const generated = d.doc.name
    expectOk(d.query('project.doc.get', {}, agent))
    expect(expectOk(await d.dispatch('history.undo', {}, agent))).toEqual({
      value: { entrySeq: 1 },
      revision: 2,
    })
    expect(d.doc).toEqual(initial)
    expectOk(await d.dispatch('history.redo', {}, ui))
    expect(d.doc.name).toBe(generated)
    expect(d.revision).toBe(3)
    expect(events.map((e) => [e.type, e.source.kind, e.revision])).toEqual([
      ['command', 'ui', 1],
      ['undo', 'agent', 2],
      ['redo', 'ui', 3],
    ])
    expect(events[1]).toMatchObject({ entrySeq: 1, patches: d.history.undoable[0]?.inversePatches })
  })

  it('anyone undoes the top entry, whoever made it; history ops create no entry of their own', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'A'))
    expectOk(await d.dispatch('project.unitSystem.update', { unitSystem: 'inch' }, ui))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expect(d.doc).toEqual(initial)
    expect(d.history.undoable).toEqual([])
    expect(d.history.redoable.map((e) => e.command)).toEqual([
      'project.unitSystem.update',
      'project.name.update',
    ])
  })

  it('a new commit clears the redo stack (redo invalidation)', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'A'))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectOk(await rename(d, 'B'))
    expect(d.history.redoable).toEqual([])
    expect(expectOk(await d.dispatch('history.redo', {}, ui)).value).toEqual({ entrySeq: null })
    expect(d.doc.name).toBe('B')
  })

  it('nothing to undo → Ok no-op, logged as a plain command event', async () => {
    const { d, events } = setup()
    expect(expectOk(await d.dispatch('history.undo', {}, ui))).toEqual({
      value: { entrySeq: null },
      revision: 0,
    })
    expect(events[0]).toMatchObject({ type: 'command', name: 'history.undo' })
  })

  it('caps the history by entry count', async () => {
    const { d } = setup([], { historyLimits: { maxEntries: 2, maxChars: 1e9 } })
    for (const n of ['A', 'B', 'C']) expectOk(await rename(d, n))
    expect(d.history.undoable.map((e) => e.args)).toEqual([{ name: 'B' }, { name: 'C' }])
  })
})

describe('stale writes', () => {
  it('UI-source commands are never rejected by the check', async () => {
    const { d } = setup()
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(await rename(d, 'by agent', agent))
    expectOk(await rename(d, 'by ui, never read', ui))
  })

  it('an agent with no baseline is rejected', async () => {
    const { d } = setup()
    const e = expectErrCode(await rename(d, 'X', agent), 'command.conflict')
    expect(e.message).toMatch(/re-query/)
    expect(d.revision).toBe(0)
  })

  it("another source's change since the agent's read → conflict (retryable)", async () => {
    const { d } = setup()
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(await rename(d, 'by ui', ui))
    expectErrCode(await rename(d, 'X', agent), 'command.conflict')
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(await rename(d, 'X', agent))
    expect(d.doc.name).toBe('X')
  })

  it("the agent's own consecutive commits are accepted", async () => {
    const { d } = setup()
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(await rename(d, 'A', agent))
    expectOk(await rename(d, 'B', agent))
    expectOk(await d.dispatch('history.undo', {}, agent))
    expect(d.doc.name).toBe('A')
  })

  it("another agent's commit and an undo by the UI count as foreign changes", async () => {
    const { d } = setup()
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(d.query('project.doc.get', {}, otherAgent))
    expectOk(await rename(d, 'other', otherAgent))
    expectErrCode(await rename(d, 'X', agent), 'command.conflict')
    expectOk(d.query('project.doc.get', {}, agent))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectErrCode(await rename(d, 'X', agent), 'command.conflict')
  })

  it('expectedRevision must equal the current revision, for every source', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'A', ui))
    expectErrCode(
      await d.dispatch('project.name.update', { name: 'B' }, ui, { expectedRevision: 0 }),
      'command.conflict',
    )
    expectErrCode(
      await d.dispatch('project.name.update', { name: 'B' }, agent, { expectedRevision: 0 }),
      'command.conflict',
    )
    // A matching expectedRevision is an explicit baseline: no prior read needed.
    expectOk(await d.dispatch('project.name.update', { name: 'B' }, agent, { expectedRevision: 1 }))
  })

  it('queries return the revision they read', async () => {
    const { d, events } = setup()
    expectOk(await rename(d, 'A'))
    expect(expectOk(d.query('project.doc.get', {}, agent))).toEqual({
      value: { name: 'A', unitSystem: 'mm' },
      revision: 1,
    })
    expectErrCode(d.query('project.nope.get', {}, agent), 'command.unknown')
    expectErrCode(d.query('project.doc.get', 5, agent), 'input.malformed')
    expect(events).toHaveLength(1) // queries are not logged
  })
})

describe('permission policy for machine commands', () => {
  it('default policy: UI allowed, other sources denied', async () => {
    const { d } = setup()
    expectOk(await d.dispatch('run.machine.jog', { dxMm: 1 }, ui))
    expectOk(d.query('project.doc.get', {}, agent))
    expectErrCode(await d.dispatch('run.machine.jog', { dxMm: 1 }, agent), 'permission.denied')
  })

  it('uses the injected policy with the parsed args and source', async () => {
    const check = vi.fn(() => fail('permission.denied', 'no'))
    const { d, events } = setup([], { policy: { check } })
    expectErrCode(await d.dispatch('run.machine.jog', { dxMm: 2 }, ui), 'permission.denied')
    expect(check).toHaveBeenCalledWith(jogMachine, { dxMm: 2 }, ui)
    expect(events).toHaveLength(1)
    expectOk(await rename(d, 'A')) // non-machine commands skip the policy
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('an async allowing policy lets the command run', async () => {
    const { d } = setup([], { policy: { check: async () => Ok(undefined) } })
    expectOk(d.query('project.doc.get', {}, agent))
    expect(expectOk(await d.dispatch('run.machine.jog', { dxMm: 3 }, agent)).value).toEqual({
      moved: 3,
    })
  })
})

describe('concurrency', () => {
  it('serializes concurrent dispatches FIFO; effects hold the queue', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const exportEffect = makeExportEffect(() => gate)
    const { d, events } = setup([exportEffect])
    expectOk(d.query('project.doc.get', {}, agent))
    const p1 = d.dispatch('project.file.export', {}, ui)
    const p2 = rename(d, 'A', agent)
    const p3 = d.dispatch('project.unitSystem.update', { unitSystem: 'inch' }, ui)
    const p4 = rename(d, 'B', agent) // conflicts: the UI changed the doc after p2
    await Promise.resolve()
    await Promise.resolve()
    expect(d.revision).toBe(0) // the effect still holds the queue
    open()
    const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4])
    expect(expectOk(r1).value).toEqual({ name: 'Bracket' }) // saw the stable doc
    expectOk(r2)
    expectOk(r3)
    expectErrCode(r4, 'command.conflict')
    expect(events.map((e) => (e.type === 'command' ? e.name : e.type))).toEqual([
      'project.file.export',
      'project.name.update',
      'project.unitSystem.update',
      'project.name.update',
    ])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('a failing or throwing command does not block the queue', async () => {
    const { d } = setup()
    const results = await Promise.all([
      d.dispatch('project.name.crash', {}, ui),
      rename(d, ' '),
      rename(d, 'ok'),
    ])
    expect(results.map((r) => r.isOk())).toEqual([false, false, true])
  })
})

describe('action log replay', () => {
  it('a replica applying logged patches from since(0) reaches the authoritative doc', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'A'))
    expectOk(await d.dispatch('project.unitSystem.update', { unitSystem: 'inch' }, ui))
    expectErrCode(await rename(d, ' '), 'model.invariant') // failure: no patches
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectOk(await d.dispatch('project.name.generate', {}, ui))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectOk(await d.dispatch('history.redo', {}, ui))

    let replica: ProjectDoc = initial
    for (const e of d.log.since(0, { withPatches: true }))
      if (e.type !== 'job' && e.patches !== undefined)
        replica = expectOk(applyDocPatches(replica, e.patches))
    expect(replica).toEqual(d.doc)
    expect(d.log.since(0).at(-1)?.revision).toBe(d.revision)
  })

  it('a reconnecting subscriber resumes from its last seq', async () => {
    const { d } = setup()
    expectOk(await rename(d, 'A'))
    const seen = d.log.lastSeq
    expectOk(await rename(d, 'B'))
    expectOk(await rename(d, 'C'))
    expect(d.log.since(seen).map((e) => e.type === 'command' && e.args)).toEqual([
      { name: 'B' },
      { name: 'C' },
    ])
  })
})

describe('document hooks', () => {
  // Appends the unit system to the name after every rename; fails on an "x" name.
  const suffix: DocumentHook = {
    name: 'suffix',
    after(draft, command) {
      if (command.name !== 'project.name.update') return Ok(undefined)
      if (draft.name === 'x') return fail('model.invariant', 'no x', { where: 'suffix' })
      draft.name = `${draft.name} (${draft.unitSystem})`
      return Ok(undefined)
    },
  }
  const hooked = () =>
    createDispatcher({
      registry: expectOk(
        createRegistry({ commands: [renameProject, setUnitSystem], hooks: [suffix] }),
      ),
      doc: initial,
    })

  it('joins the hook changes to the command: one commit, one undo step', async () => {
    const d = hooked()
    expectOk(await d.dispatch('project.name.update', { name: 'A' }, ui))
    expect(d.doc.name).toBe('A (mm)')
    expect(d.revision).toBe(1)
    expect(d.history.undoable).toHaveLength(1)
    expectOk(await d.dispatch('project.unitSystem.update', { unitSystem: 'inch' }, ui))
    expect(d.doc.name).toBe('A (mm)') // other commands: the hook does nothing
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expect(d.doc).toEqual(initial)
  })

  it('a failing hook fails the command and leaves the document unchanged', async () => {
    const d = hooked()
    const e = expectErrCode(
      await d.dispatch('project.name.update', { name: 'x' }, ui),
      'model.invariant',
    )
    expect(e.frames.map((f) => f.where)).toContain('hook suffix')
    expect(d.doc).toEqual(initial)
    expect(d.revision).toBe(0)
  })
})
