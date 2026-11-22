import type { Patch } from 'immer'
import { describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { renameProject } from '../commands/commands.fixture'
import type { HistoryView } from '../commands/context'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry, createRegistry } from '../commands/registry'
import { uiSource } from '../commands/testing'
import { newProjectDoc, type ProjectDoc } from './document'
import { projectSave } from './commands'
import {
  attachSession,
  isProjectKey,
  resolveRecovery,
  type ProjectSession,
  type ProjectStorage,
  type RecoveryAction,
  type SaveOptions,
} from './storage'

const doc = newProjectDoc({ name: 'Bracket', unitSystem: 'mm' })

function fakeSession(filePath: string | null = '/p/a.dfyom') {
  const changes: { patches: readonly Patch[]; doc: ProjectDoc; revision: number }[] = []
  const saves: { doc: ProjectDoc; opts: SaveOptions }[] = []
  const histories: (() => HistoryView)[] = []
  const session: ProjectSession = {
    key: 'project-1',
    projectId: 'project-1',
    filePath,
    dirty: false,
    changed: (patches, d, revision) => void changes.push({ patches, doc: d, revision }),
    flush: async () => Ok(undefined),
    save: async (d, opts = {}) => {
      const target = opts.target
      saves.push({ doc: d, opts })
      return Ok({
        filePath: target ?? filePath ?? '',
        revision: 7,
        savedAt: 'now',
        sha256: 'h',
        warnings: [],
      })
    },
    importAsset: async () => fail('persist.io', 'not in this fake'),
    assetFile: () => fail('persist.io', 'not in this fake'),
    useHistory: (h) => void histories.push(h),
  }
  return { session, changes, saves, histories }
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
  it('rejects keys that are not project folder names (path traversal)', async () => {
    const { storage, calls } = fakeStorage()
    for (const key of ['../../victim', '..', 'a/b', 'a\\b', '', 'p~', 'p~x', '.hidden'])
      expectErrCode(
        await resolveRecovery(storage, { key, action: 'discard', confirm: true }),
        'input.malformed',
      )
    expect(calls).toEqual([])
    expect(isProjectKey('project-1~2')).toBe(true)
  })

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
    const { session, changes, histories } = fakeSession()
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
    // The session sees the live undo history (save keeps the assets its entries name).
    expect(histories[0]?.().redoable.map((e) => e.command)).toEqual(['project.name.update'])
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
    expectOk(await d.dispatch('project.save', { target: '/q/c.DFYOM', confirm: true }, uiSource()))
    expect(saves).toEqual([
      { doc, opts: { confirm: false } },
      { doc, opts: { target: '/q/b.dfyom', confirm: false } },
      { doc, opts: { target: '/q/c.DFYOM', confirm: true } },
    ])
  })

  it('refuses a target that is not a .dfyom file', async () => {
    const { session, saves } = fakeSession()
    const d = dispatcher(session)
    for (const target of ['/q/notes.txt', '/q/dfyom', '/q/a.dfyom.bak'])
      expectErrCode(await d.dispatch('project.save', { target }, uiSource()), 'input.malformed')
    expect(saves).toEqual([])
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
