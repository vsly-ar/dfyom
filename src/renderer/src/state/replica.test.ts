import { describe, expect, it, vi } from 'vitest'
import type { ActionEvent } from '../../../core/commands/action-log'
import type { ProjectSnapshot } from '../../../shared/preload-api'
import { expectOk } from '../../../shared/testing/result'
import { createFakeBridge, fixtureDispatcher, WINDOW_SOURCE } from '../test/bridge'
import { createReplica, isDirty, type ReplicaState } from './replica'

const flush = () => new Promise((r) => setTimeout(r, 0))

function open(s: ReplicaState) {
  if (s.status !== 'open') throw new Error(`replica is ${s.status}`)
  return s
}

describe('document replica', () => {
  it('is empty without a bound project, and follows a binding', async () => {
    const bridge = createFakeBridge()
    const replica = createReplica(bridge)
    replica.start()
    expect(replica.getState().status).toBe('loading')
    await flush()
    expect(replica.getState()).toEqual({ status: 'none' })

    const d = fixtureDispatcher('Bracket')
    bridge.bind(d, 'p1', { file: '/tmp/bracket.dfyom' })
    await flush()
    expect(open(replica.getState())).toMatchObject({
      key: 'p1',
      file: '/tmp/bracket.dfyom',
      revision: 0,
      doc: { name: 'Bracket', unitSystem: 'mm' },
    })

    bridge.bind(null)
    await flush()
    expect(replica.getState()).toEqual({ status: 'none' })
  })

  it('follows edits, undo and redo from the patch stream, and tracks unsaved changes', async () => {
    const bridge = createFakeBridge()
    const d = fixtureDispatcher()
    bridge.bind(d)
    const replica = createReplica(bridge)
    const seen = vi.fn()
    replica.onEvent(seen)
    replica.start()
    await flush()
    expect(isDirty(open(replica.getState()))).toBe(false)

    expectOk(await d.dispatch('project.name.update', { name: 'Plate' }, WINDOW_SOURCE))
    expectOk(await d.dispatch('project.unitSystem.update', { unitSystem: 'inch' }, WINDOW_SOURCE))
    expectOk(await d.dispatch('history.undo', {}, WINDOW_SOURCE))
    const s = open(replica.getState())
    expect(s.doc).toEqual(d.doc)
    expect(s.doc).toMatchObject({ name: 'Plate', unitSystem: 'mm' })
    expect(s.revision).toBe(d.revision)
    expect(isDirty(s)).toBe(true)
    expect(seen).toHaveBeenCalledTimes(3)
  })

  it('keeps events that arrive while the snapshot is on its way', async () => {
    const bridge = createFakeBridge()
    const d = fixtureDispatcher()
    let release: () => void = () => {}
    const snapshot = bridge.project.snapshot
    bridge.project.snapshot = () =>
      new Promise<ProjectSnapshot | null>((resolve) => {
        // the snapshot is taken now; events after it arrive before the answer
        const taken = snapshot()
        release = () => void taken.then(resolve)
      })
    bridge.bind(d)
    const replica = createReplica(bridge)
    replica.start()
    expectOk(await d.dispatch('project.name.update', { name: 'Late' }, WINDOW_SOURCE))
    release()
    await flush()
    // the snapshot predates the edit: the buffered event is applied after it
    expect(open(replica.getState())).toMatchObject({ doc: { name: 'Late' }, seq: d.log.lastSeq })
  })

  it('resynchronizes on a gap in the event sequence or a patch that does not apply', async () => {
    const bridge = createFakeBridge()
    const d = fixtureDispatcher()
    bridge.bind(d)
    const { project, emit } = manualEvents(bridge)
    const snapshot = vi.spyOn(project, 'snapshot')
    const replica = createReplica({ project })
    replica.start()
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(1)
    // an edit the replica never hears about, then the next event: seq jumps by 2
    expectOk(await d.dispatch('project.name.update', { name: 'A' }, WINDOW_SOURCE))
    expectOk(await d.dispatch('project.name.update', { name: 'B' }, WINDOW_SOURCE))
    emit(lastEvent(d))
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(open(replica.getState())).toMatchObject({ doc: { name: 'B' }, seq: d.log.lastSeq })

    const s = open(replica.getState())
    emit({ ...save(s.seq + 1, s.revision + 1), patches: [{ op: 'remove', path: ['nope', 'x'] }] })
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(3)
  })

  it('marks the document saved after a successful project.save', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher(), 'p1', { dirty: true })
    const { project, emit } = manualEvents(bridge)
    const replica = createReplica({ project })
    replica.start()
    await flush()
    const s = open(replica.getState())
    expect(isDirty(s)).toBe(true)
    emit(save(s.seq + 1, s.revision))
    expect(isDirty(open(replica.getState()))).toBe(false)
    // Save as names the new file
    emit({
      ...save(s.seq + 2, s.revision),
      outcome: { ok: true, value: { filePath: '/p/b.dfyom' } },
    })
    expect(open(replica.getState()).file).toBe('/p/b.dfyom')
  })
})

/** The bridge's project API with events pushed by the test only. */
function manualEvents(bridge: ReturnType<typeof createFakeBridge>) {
  const listeners = new Set<(e: ActionEvent) => void>()
  const project = {
    ...bridge.project,
    onEvent: (l: (e: ActionEvent) => void) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
  return { project, emit: (e: ActionEvent) => listeners.forEach((l) => l(e)) }
}

function lastEvent(d: ReturnType<typeof fixtureDispatcher>): ActionEvent {
  const e = d.log.since(d.log.lastSeq - 1, { withPatches: true }).at(-1)
  if (e === undefined) throw new Error('no event')
  return e
}

/** A save event as the log carries it (the fixture registry has no project.save). */
function save(seq: number, revision: number): Extract<ActionEvent, { type: 'command' }> {
  return {
    type: 'command',
    name: 'project.save',
    args: {},
    outcome: { ok: true, value: {} },
    seq,
    at: '',
    source: WINDOW_SOURCE,
    revision,
  }
}
