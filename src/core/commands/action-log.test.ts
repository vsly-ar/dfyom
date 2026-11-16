import { describe, expect, it } from 'vitest'
import { createActionLog, type NewActionEvent } from './action-log'
import { agentSource, uiSource } from './testing'

const cmd = (name: string, source = uiSource()): NewActionEvent => ({
  type: 'command',
  at: '2026-01-01T00:00:00.000Z',
  source,
  revision: 1,
  name,
  args: {},
  outcome: { ok: true, value: null },
  patches: [{ op: 'replace', path: ['name'], value: name }],
})

describe('action log', () => {
  it('assigns increasing seq numbers starting at 1', () => {
    const log = createActionLog()
    expect(log.append(cmd('project.a.update')).seq).toBe(1)
    expect(log.append(cmd('project.b.update')).seq).toBe(2)
    expect(log.lastSeq).toBe(2)
  })

  it('since(seq) replays later events from a bounded ring buffer', () => {
    const log = createActionLog({ capacity: 3 })
    for (const n of ['a', 'b', 'c', 'd', 'e']) log.append(cmd(`project.${n}.update`))
    expect(log.since(0).map((e) => e.seq)).toEqual([3, 4, 5])
    expect(log.since(4).map((e) => e.seq)).toEqual([5])
    expect(log.since(5)).toEqual([])
  })

  it('omits patches unless asked', () => {
    const log = createActionLog()
    log.append(cmd('project.a.update'))
    expect(log.since(0)[0]).not.toHaveProperty('patches')
    expect(log.since(0, { withPatches: true })[0]).toHaveProperty('patches')
  })

  it('subscribe(filter) delivers matching events until unsubscribed', () => {
    const log = createActionLog()
    const all: number[] = []
    const agentOnly: number[] = []
    const renames: unknown[] = []
    const offAll = log.subscribe({}, (e) => all.push(e.seq))
    log.subscribe({ sources: [agentSource()] }, (e) => agentOnly.push(e.seq))
    log.subscribe({ names: ['project.name.update'], withPatches: true }, (e) =>
      renames.push(e.type === 'command' && e.patches),
    )
    log.append(cmd('project.name.update'))
    log.append(cmd('project.other.update', agentSource()))
    offAll()
    log.append(cmd('project.name.update', agentSource()))
    expect(all).toEqual([1, 2])
    expect(agentOnly).toEqual([2, 3])
    expect(renames).toEqual([
      [{ op: 'replace', path: ['name'], value: 'project.name.update' }],
      [{ op: 'replace', path: ['name'], value: 'project.name.update' }],
    ])
  })

  it('filters undo/redo events by the history command names', () => {
    const log = createActionLog()
    const got: string[] = []
    log.subscribe({ names: ['history.undo'] }, (e) => got.push(e.type))
    const base = { at: 'x', source: uiSource(), revision: 2 }
    log.append({ ...base, type: 'undo', entrySeq: 1, patches: [] })
    log.append({ ...base, type: 'redo', entrySeq: 1, patches: [] })
    expect(got).toEqual(['undo'])
  })
})
