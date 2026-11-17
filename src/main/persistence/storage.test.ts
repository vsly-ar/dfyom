import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renameProject } from '../../core/commands/commands.fixture'
import { createDispatcher } from '../../core/commands/dispatcher'
import { inProcessWorkers } from '../../core/commands/jobs'
import { createRegistry } from '../../core/commands/registry'
import { fakeClock, uiSource } from '../../core/commands/testing'
import { projectSave } from '../../core/project/commands'
import { newProjectDoc } from '../../core/project/document'
import { docToFiles } from '../../core/project/layout'
import {
  attachSession,
  resolveRecovery,
  type OpenedProject,
  type OpenOutcome,
} from '../../core/project/storage'
import { noopLogger } from '../../shared/logging'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { buildArchive, loadArchive, sha256 } from './archive'
import { nodeFs } from './fs'
import { faultFs, useTempDir } from './fs.testing'
import { LOCK_STALE_MS, type LockOwner } from './lock'
import { projectPaths } from './paths'
import { readState } from './working-folder'
import { createProjectStorage, type StorageOptions } from './storage'

const tmp = useTempDir()
const T0 = Date.parse('2026-11-17T10:00:00.000Z')
const v1 = newProjectDoc({ name: 'Version 1', unitSystem: 'mm' })
const A: LockOwner = { instanceId: 'inst-a', pid: 100, host: 'h' }
const B: LockOwner = { instanceId: 'inst-b', pid: 200, host: 'h' }
const appData = () => join(tmp.dir, 'appdata')
const file = () => join(tmp.dir, 'docs', 'bracket.dfyom')

function storage(owner = A, over: Partial<StorageOptions> = {}) {
  let n = 0
  return createProjectStorage({
    fs: nodeFs,
    appData: appData(),
    appVersion: '0.0.8',
    owner,
    clock: fakeClock(T0),
    log: noopLogger,
    isPidAlive: () => true,
    debounceMs: 60_000,
    newProjectId: () => `project-${++n}`,
    ...over,
  })
}

async function projectFile(revision = 4): Promise<Uint8Array> {
  const a = buildArchive(expectOk(docToFiles(v1)), {
    projectId: 'project-x',
    appVersion: '0.0.1',
    savedAt: '2026-11-16T09:00:00.000Z',
    revision,
  })
  await mkdir(join(tmp.dir, 'docs'), { recursive: true })
  await writeFile(file(), a.bytes)
  return a.bytes
}

const opened = (o: OpenOutcome): OpenedProject => {
  if (o.kind !== 'opened') throw new Error(`expected opened, got ${o.kind}`)
  return o.project
}

/** A dispatcher wired like the app: session as service, commits fed to the working folder. */
function run(p: OpenedProject) {
  const d = createDispatcher({
    registry: expectOk(createRegistry({ commands: [renameProject, projectSave] })),
    doc: p.doc,
    revision: p.revision,
    services: { workers: inProcessWorkers, project: p.session },
  })
  attachSession(d, p.session)
  return d
}

describe('open', () => {
  it('unpacks the project into <appData>/projects/<id>/work and starts at the manifest revision', async () => {
    await projectFile(4)
    const p = opened(expectOk(await storage().open(file())))
    expect(p.doc).toEqual(v1)
    expect(p.revision).toBe(4)
    expect(p.session.key).toBe('project-x')
    expect(p.session.dirty).toBe(false)
    const paths = projectPaths(appData(), 'project-x')
    expect(await readdir(paths.work)).toEqual(['project.json'])
    expect(expectOk(await readState(nodeFs, paths)).unwrap()).toMatchObject({
      filePath: file(),
      dirty: false,
      workingRevision: 4,
      savedRevision: 4,
    })
    expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toMatchObject({ instanceId: 'inst-a' })
  })

  it('refuses a project another live instance has open (persist.locked)', async () => {
    await projectFile()
    opened(expectOk(await storage(A).open(file())))
    const e = expectErrCode(await storage(B).open(file()), 'persist.locked')
    expect(e.frames[0]?.data).toMatchObject({ holder: 'inst-a' })
  })

  it('opens a project whose lock is stale (holder dead)', async () => {
    await projectFile()
    opened(expectOk(await storage(A).open(file())))
    const p = opened(expectOk(await storage(B, { isPidAlive: (pid) => pid !== 100 }).open(file())))
    expect(p.doc).toEqual(v1)
  })

  it('a second file with the same project id gets its own folder <id>~2', async () => {
    const bytes = await projectFile()
    const copy = join(tmp.dir, 'docs', 'copy.dfyom')
    await writeFile(copy, bytes)
    const s = storage()
    opened(expectOk(await s.open(file())))
    expect(opened(expectOk(await s.open(copy))).session.key).toBe('project-x~2')
  })

  it('refuses a newer schema version and never touches the file', async () => {
    const newer = buildArchive(expectOk(docToFiles(v1)), {
      projectId: 'p',
      appVersion: '9',
      savedAt: '2026-11-16T09:00:00.000Z',
      revision: 1,
    })
    // Rewrite the manifest with schemaVersion 2 via a fresh zip.
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import('fflate')
    const entries = unzipSync(newer.bytes)
    const m = JSON.parse(strFromU8(entries['manifest.json'] as Uint8Array))
    entries['manifest.json'] = strToU8(JSON.stringify({ ...m, schemaVersion: 2 }))
    await mkdir(join(tmp.dir, 'docs'), { recursive: true })
    const bytes = zipSync(entries)
    await writeFile(file(), bytes)
    expectErrCode(await storage().open(file()), 'persist.migration')
    expect(new Uint8Array(await readFile(file()))).toEqual(bytes)
  })
})

describe('edit, flush and save', () => {
  it('commits reach work/ on flush; save replaces the file, adds history and clears dirty', async () => {
    await projectFile(4)
    const s = storage()
    const p = opened(expectOk(await s.open(file())))
    const d = run(p)
    expectOk(await d.dispatch('project.name.update', { name: 'Version 2' }, uiSource()))
    expectOk(await p.session.flush())
    const paths = projectPaths(appData(), 'project-x')
    expect(JSON.parse(await readFile(join(paths.work, 'project.json'), 'utf8')).name).toBe(
      'Version 2',
    )
    expect(p.session.dirty).toBe(true)

    const out = expectOk(await d.dispatch('project.save', {}, uiSource())).value as {
      revision: number
      warnings: string[]
    }
    expect(out).toMatchObject({ revision: 5, warnings: [] })
    const saved = expectOk(loadArchive(await readFile(file())))
    expect(saved.doc.name).toBe('Version 2')
    expect(saved.manifest.revision).toBe(5)
    expect(p.session.dirty).toBe(false)
    // The opened file (not in saves/ yet) and the new save are both in the history.
    expect((await readdir(paths.saves)).sort()).toEqual([
      '2026-11-16T09-00-00.000Z-r4.dfyom',
      '2026-11-17T10-00-00.000Z-r5.dfyom',
    ])
    expect(expectOk(await readState(nodeFs, paths)).unwrap()).toMatchObject({
      dirty: false,
      savedRevision: 5,
      savedSha256: sha256(await readFile(file())),
    })
  })

  it('Save As writes the new file and keeps the original; an untitled project saves via a target', async () => {
    const s = storage()
    const p = expectOk(await s.create(newProjectDoc({ name: 'New', unitSystem: 'inch' })))
    expect(p.session.filePath).toBeNull()
    const d = run(p)
    expectErrCode(await d.dispatch('project.save', {}, uiSource()), 'input.malformed')
    await mkdir(join(tmp.dir, 'docs'))
    const target = join(tmp.dir, 'docs', 'new.dfyom')
    expectOk(await d.dispatch('project.save', { target }, uiSource()))
    expect(p.session.filePath).toBe(target)
    expect(expectOk(loadArchive(await readFile(target))).doc.name).toBe('New')
  })

  it('a failing save step leaves the project file untouched and the project dirty', async () => {
    const before = await projectFile(4)
    for (const op of ['writeFile', 'fsync', 'readFile', 'rename'] as const) {
      let armed = false
      const fs = faultFs((o, path) =>
        armed && o === op && path.includes('.tmp-') ? 'fail' : undefined,
      )
      const s = storage(A, { fs })
      const p = opened(expectOk(await s.open(file())))
      const d = run(p)
      expectOk(await d.dispatch('project.name.update', { name: 'Version 2' }, uiSource()))
      armed = true
      expectErrCode(await d.dispatch('project.save', {}, uiSource()), 'persist.io')
      expect(new Uint8Array(await readFile(file())), op).toEqual(before)
      expect(p.session.dirty, op).toBe(true)
      armed = false
      expectOk(await s.close(p.session.key))
      // Unsaved changes stay recoverable after close.
      expect(expectOk(await s.listRecoverable()).map((r) => r.key)).toEqual(['project-x'])
      expectOk(await resolveRecovery(s, { key: 'project-x', action: 'discard', confirm: true }))
      expectOk(await s.close('project-x'))
    }
  })

  it('a crash (kill) at any step of save leaves a loadable project file and recoverable changes', async () => {
    const before = await projectFile(4)
    for (let n = 1; ; n++) {
      let armed = false
      let count = 0
      const fs = faultFs(() => (armed && ++count === n ? 'crash' : undefined))
      const p = opened(expectOk(await storage(A, { fs }).open(file())))
      const d = run(p)
      expectOk(await d.dispatch('project.name.update', { name: 'Version 2' }, uiSource()))
      expectOk(await p.session.flush())
      armed = true
      await d.dispatch('project.save', {}, uiSource())
      const crashed = fs.crashed
      // The project file is the old or the new version, never broken.
      const now = expectOk(loadArchive(await readFile(file())))
      expect(['Version 1', 'Version 2']).toContain(now.doc.name)
      // "Restart": a new instance; the dead one's lock is stale.
      const s2 = storage(B, { isPidAlive: (pid) => pid !== 100 })
      const rec = expectOk(await s2.listRecoverable())
      if (rec.length > 0) {
        const r = expectOk(await resolveRecovery(s2, { key: 'project-x', action: 'restore' }))
        expect(r?.doc.name).toBe('Version 2')
        expectOk(await s2.close('project-x'))
        expectOk(await resolveRecovery(s2, { key: 'project-x', action: 'discard', confirm: true }))
      } else {
        // Nothing to recover only if the save completed: the file holds the change.
        expect(now.doc.name).toBe('Version 2')
        expect(opened(expectOk(await s2.open(file()))).doc.name).toBe('Version 2')
      }
      expectOk(await s2.close('project-x'))
      await writeFile(file(), before)
      if (!crashed) break
    }
  })
})

describe('crash recovery', () => {
  async function crashWithChanges(): Promise<void> {
    await projectFile(4)
    const p = opened(expectOk(await storage(A).open(file())))
    const d = run(p)
    expectOk(await d.dispatch('project.name.update', { name: 'Unsaved' }, uiSource()))
    expectOk(await p.session.flush())
    // No close: the instance "dies" holding its lock.
  }
  const restarted = () => storage(B, { isPidAlive: (pid) => pid !== 100 })

  it('lists dirty projects without a live lock, including untitled ones', async () => {
    await crashWithChanges()
    expect(expectOk(await storage(B).listRecoverable())).toEqual([]) // A still alive
    const u = expectOk(await storage(A).create(newProjectDoc({ name: 'U', unitSystem: 'mm' })))
    const du = run(u)
    expectOk(await du.dispatch('project.name.update', { name: 'U2' }, uiSource()))
    expectOk(await u.session.flush())
    const list = expectOk(await restarted().listRecoverable())
    expect(list).toEqual([
      {
        key: 'project-1',
        projectId: 'project-1',
        filePath: null,
        workingRevision: 1,
        savedRevision: null,
      },
      {
        key: 'project-x',
        projectId: 'project-x',
        filePath: file(),
        workingRevision: 5,
        savedRevision: 4,
      },
    ])
  })

  it('open of a project with unsaved changes offers recovery instead of unpacking', async () => {
    await crashWithChanges()
    const s = restarted()
    const o = expectOk(await s.open(file()))
    expect(o).toEqual({
      kind: 'recoverable',
      recoverable: {
        key: 'project-x',
        projectId: 'project-x',
        filePath: file(),
        workingRevision: 5,
        savedRevision: 4,
      },
    })
    const paths = projectPaths(appData(), 'project-x')
    expect(JSON.parse(await readFile(join(paths.work, 'project.json'), 'utf8')).name).toBe(
      'Unsaved',
    )
  })

  it('restore continues as a dirty project at the working revision', async () => {
    await crashWithChanges()
    const r = expectOk(await resolveRecovery(restarted(), { key: 'project-x', action: 'restore' }))
    expect(r?.doc.name).toBe('Unsaved')
    expect(r?.revision).toBe(5)
    expect(r?.session.dirty).toBe(true)
  })

  it('discard (confirmed) deletes work/ and opens the project file', async () => {
    await crashWithChanges()
    const s = restarted()
    expectErrCode(
      await resolveRecovery(s, { key: 'project-x', action: 'discard' }),
      'input.malformed',
    )
    const r = expectOk(
      await resolveRecovery(s, { key: 'project-x', action: 'discard', confirm: true }),
    )
    expect(r?.doc).toEqual(v1)
    expect(r?.session.dirty).toBe(false)
  })

  it('discard of an untitled project removes its folder and opens nothing', async () => {
    const u = expectOk(await storage(A).create(newProjectDoc({ name: 'U', unitSystem: 'mm' })))
    const du = run(u)
    expectOk(await du.dispatch('project.name.update', { name: 'U2' }, uiSource()))
    expectOk(await u.session.flush())
    const s = restarted()
    expect(
      expectOk(await resolveRecovery(s, { key: 'project-1', action: 'discard', confirm: true })),
    ).toBeUndefined()
    expect(await readdir(join(appData(), 'projects'))).toEqual([])
  })

  it('a working folder that does not load fails with its error and is kept', async () => {
    await crashWithChanges()
    const paths = projectPaths(appData(), 'project-x')
    await writeFile(join(paths.work, 'project.json'), '{"name": 1}')
    const s = restarted()
    expectErrCode(
      await resolveRecovery(s, { key: 'project-x', action: 'restore' }),
      'input.malformed',
    )
    expect(await readFile(join(paths.work, 'project.json'), 'utf8')).toBe('{"name": 1}')
    // The lock was released again, so discarding is still possible.
    expectOk(await resolveRecovery(s, { key: 'project-x', action: 'discard', confirm: true }))
  })

  it('recovery of a project locked by a live instance is refused', async () => {
    await crashWithChanges()
    expectErrCode(
      await resolveRecovery(storage(B), { key: 'project-x', action: 'restore' }),
      'persist.locked',
    )
  })

  it('a heartbeat older than 2 minutes makes the lock stale even if the PID looks alive', async () => {
    await crashWithChanges()
    const later = storage(B, { clock: fakeClock(T0 + LOCK_STALE_MS + 1) })
    expect(expectOk(await later.listRecoverable()).map((r) => r.key)).toEqual(['project-x'])
  })
})

describe('close', () => {
  it('flushes, releases the lock and deletes an unchanged untitled project', async () => {
    const s = storage()
    const u = expectOk(await s.create(newProjectDoc({ name: 'U', unitSystem: 'mm' })))
    expectOk(await s.close(u.session.key))
    expect(await readdir(join(appData(), 'projects'))).toEqual([])
    await projectFile()
    const p = opened(expectOk(await s.open(file())))
    expectOk(await s.close(p.session.key))
    expect(await readdir(projectPaths(appData(), 'project-x').folder)).not.toContain('lock.json')
    opened(expectOk(await storage(B).open(file())))
  })

  it('unknown keys are reported', async () => {
    expectErrCode(await storage().close('nope'), 'input.malformed')
  })
})
