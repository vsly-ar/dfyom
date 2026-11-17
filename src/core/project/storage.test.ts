import type { Patch } from 'immer'
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { renameProject } from '../commands/commands.fixture'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry, createRegistry } from '../commands/registry'
import { uiSource } from '../commands/testing'
import { newProjectDoc, type ProjectDoc } from './document'
import { projectSave } from './commands'
import {
  attachSession,
  resolveRecovery,
  type ProjectSession,
  type ProjectStorage,
  type RecoveryAction,
} from './storage'

const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })

function fakeSession(filePath: string | null = '/p/a.dfyom') {
  const changes: { patches: readonly Patch[]; doc: ProjectDoc; revision: number }[] = []
  const saves: { doc: ProjectDoc; target: string | undefined }[] = []
  const session: ProjectSession = {
    key: 'project-1',
    projectId: 'project-1',
    filePath,
    dirty: false,
    changed: (patches, d, revision) => void changes.push({ patches, doc: d, revision }),
    flush: async () => Ok(undefined),
    save: async (d, target) => {
      saves.push({ doc: d, target })
      return Ok({
        filePath: target ?? filePath ?? '',
        revision: 7,
        savedAt: 'now',
        sha256: 'h',
        warnings: [],
      })
    },
  }
  return { session, changes, saves }
}

function fakeStorage() {
  const calls: [string, RecoveryAction][] = []
  const storage = {
    recover: async (key: string, action: RecoveryAction) => {
      calls.push([key, action])
      return Ok(undefined)
    },
  } as unknown as ProjectStorage
  return { storage, calls }
}

describe('resolveRecovery', () => {
  it('restores without confirmation', async () => {
    const { storage, calls } = fakeStorage()
    expectOk(await resolveRecovery(storage, { key: 'k', action: 'restore' }))
    expect(calls).toEqual([['k', 'restore']])
  })

  it('refuses to discard without confirm: true and deletes nothing', async () => {
    const { storage, calls } = fakeStorage()
    const e = expectErrCode(
      await resolveRecovery(storage, { key: 'k', action: 'discard' }),
      'input.malformed',
    )
    expect(e.issues[0]?.path).toEqual(['confirm'])
    expect(calls).toEqual([])
    expectOk(await resolveRecovery(storage, { key: 'k', action: 'discard', confirm: true }))
    expect(calls).toEqual([['k', 'discard']])
  })
})

describe('attachSession', () => {
  it('feeds commits, undo and redo with their patches and revision to the session', async () => {
    const { session, changes } = fakeSession()
    const d = createDispatcher({
      registry: expectOk(createRegistry({ commands: [renameProject] })),
      doc,
      revision: 5,
    })
    attachSession(d, session)
    expectOk(await d.dispatch('project.name.update', { name: 'B2' }, uiSource()))
    expectOk(await d.dispatch('history.undo', {}, uiSource()))
    await d.dispatch('project.name.update', { name: '' }, uiSource()) // fails: no commit
    expect(changes.map((c) => [c.revision, c.doc.name])).toEqual([
      [6, 'B2'],
      [7, 'Bracket'],
    ])
    expect(changes[0]?.patches).toEqual([{ op: 'replace', path: ['name'], value: 'B2' }])
  })
})

describe('project.save', () => {
  const dispatcher = (session?: ProjectSession) =>
    createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc,
      revision: 3,
      services:
        session === undefined
          ? { workers: inProcessWorkers }
          : { workers: inProcessWorkers, project: session },
    })

  it('is an effect command registered in the app registry', () => {
    expect(projectSave.kind).toBe('effect')
  })

  it('saves the current document through the session; target = Save As', async () => {
    const { session, saves } = fakeSession()
    const d = dispatcher(session)
    expect(expectOk(await d.dispatch('project.save', {}, uiSource())).value).toMatchObject({
      revision: 7,
    })
    expectOk(await d.dispatch('project.save', { target: '/q/b.dfyom' }, uiSource()))
    expect(saves).toEqual([
      { doc, target: undefined },
      { doc, target: '/q/b.dfyom' },
    ])
  })

  it('an untitled project needs a target', async () => {
    const { session, saves } = fakeSession(null)
    expectErrCode(
      await dispatcher(session).dispatch('project.save', {}, uiSource()),
      'input.malformed',
    )
    expect(saves).toEqual([])
  })

  it('fails without a storage service', async () => {
    expectErrCode(
      await dispatcher().dispatch('project.save', {}, uiSource()),
      'internal.unexpected',
    )
  })
})
