/**
 * Main-process implementation of the `ProjectStorage` port: open, create, recover, save, close.
 * Doc: docs/architecture/persistence.md
 */
import { randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import type { Patch } from 'immer'
import type { Clock, HistoryView } from '../../core/commands/context'
import {
  ASSET_DIR,
  historyAssets,
  referencedAssets,
  type AssetRef,
} from '../../core/project/assets'
import type { ProjectDoc } from '../../core/project/document'
import { docToFiles, PROJECT_SCHEMA_VERSION, type FileMap } from '../../core/project/layout'
import type {
  OpenedProject,
  OpenOutcome,
  ProjectSession,
  ProjectStorage,
  RecoverableProject,
  RecoveryAction,
  SaveOptions,
  SaveOutcome,
} from '../../core/project/storage'
import { isProjectFileName, isProjectKey } from '../../core/project/storage'
import { AppError } from '../../shared/errors/app-error'
import type { Logger } from '../../shared/logging'
import { Err, fail, Ok, tryAsync, type AppResult, type AsyncAppResult } from '../../shared/result'
import { loadArchive, readArchive, type ArchiveAsset, type LoadedArchive } from './archive'
import { assetFileIn, importAssetFile, removeUnreferencedAssets } from './assets'
import { canonicalPath, nodeFs, samePath, type PersistFs } from './fs'
import {
  acquireLock,
  isPidAlive as realIsPidAlive,
  LOCK_HEARTBEAT_MS,
  type Lock,
  type LockDeps,
  type LockObservations,
  type LockOwner,
} from './lock'
import { candidateKey, projectPaths, projectsRoot, type ProjectPaths } from './paths'
import { loadWork, scanRecoverable } from './recovery'
import { applyRetention } from './retention'
import { addToHistory, writeVerifiedArchive } from './save'
import { readState, unpack, WorkingFolder, type ProjectState } from './working-folder'

export interface StorageOptions {
  readonly appData: string
  readonly appVersion: string
  /** This instance (same id as the log's `instance` field). */
  readonly owner: LockOwner
  readonly log: Logger
  readonly fs?: PersistFs
  readonly clock?: Clock
  readonly isPidAlive?: (pid: number) => boolean
  readonly debounceMs?: number
  readonly heartbeatMs?: number
  /** Id of a new project (default `project-<uuid>`). */
  readonly newProjectId?: () => string
  /** Persistent warnings for the UI ("unsaved changes are not protected", lost lock, …). */
  readonly onWarning?: (key: string, message: string) => void
}

const MAX_KEYS = 1000

export function createProjectStorage(o: StorageOptions): ProjectStorage {
  return new MainProjectStorage(o)
}

class MainProjectStorage implements ProjectStorage {
  private readonly fs: PersistFs
  private readonly clock: Clock
  private readonly log: Logger
  private readonly sessions = new Map<string, MainSession>()
  private readonly observed: LockObservations = new Map()

  constructor(private readonly o: StorageOptions) {
    this.fs = o.fs ?? nodeFs
    this.clock = o.clock ?? { now: () => Date.now() }
    this.log = o.log.child({ scope: 'persist' })
  }

  lockDeps(paths: ProjectPaths): LockDeps {
    return {
      fs: this.fs,
      path: paths.lock,
      owner: this.o.owner,
      clock: this.clock,
      isPidAlive: this.o.isPidAlive ?? realIsPidAlive,
      log: this.log,
      observed: this.observed,
    }
  }

  private async lock(paths: ProjectPaths): AsyncAppResult<Lock> {
    const made = await tryAsync(
      () => this.fs.mkdir(paths.folder),
      'persist.io',
      'creating the project folder failed',
    )
    if (made.isErr()) return Err(made.unwrapErr())
    return acquireLock(this.lockDeps(paths))
  }

  async create(doc: ProjectDoc): AsyncAppResult<OpenedProject> {
    const projectId = this.o.newProjectId?.() ?? `project-${randomUUID()}`
    let paths: ProjectPaths | undefined
    for (let n = 1; n <= MAX_KEYS && paths === undefined; n++) {
      const p = projectPaths(this.o.appData, candidateKey(projectId, n))
      const exists = await tryAsync(() => this.fs.stat(p.folder), 'persist.io', 'stat failed')
      if (exists.isErr()) return Err(exists.unwrapErr())
      if (exists.unwrap() === undefined) paths = p
    }
    if (paths === undefined)
      return fail('persist.io', 'no free project folder', { where: 'storage.create' })
    const files = docToFiles(doc)
    if (files.isErr()) return Err(files.unwrapErr())
    const state: ProjectState = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      filePath: null,
      dirty: false,
      workingRevision: 0,
      savedRevision: null,
      savedSha256: null,
    }
    const lock = await this.lock(paths)
    if (lock.isErr()) return Err(lock.unwrapErr().withContext('storage.create'))
    const opened = await this.start(paths, files.unwrap(), state, doc, lock.unwrap())
    if (opened.isOk()) this.log.info({ project: projectId, key: paths.key }, 'project created')
    return opened
  }

  async open(filePath: string): AsyncAppResult<OpenOutcome> {
    const where = 'storage.open'
    // One file, one folder and lock: symlinks, `..` and letter case must not open it twice.
    const canonical = await tryAsync(
      () => canonicalPath(this.fs, resolve(filePath)),
      'persist.io',
      'resolving the project file path failed',
    )
    if (canonical.isErr()) return Err(canonical.unwrapErr().withContext(where, { file: filePath }))
    const path = canonical.unwrap()
    // Step 1: stream and verify the whole archive (assets only hashed); nothing is written yet.
    const loaded = await loadArchive(this.fs, path)
    if (loaded.isErr()) return Err(loaded.unwrapErr().withContext(where, { file: path }))
    const archive = loaded.unwrap()
    const found = await this.folderFor(archive.manifest.projectId, path)
    if (found.isErr()) return Err(found.unwrapErr().withContext(where, { file: path }))
    const { paths, state } = found.unwrap()
    const lock = await this.lock(paths)
    if (lock.isErr())
      return Err(lock.unwrapErr().withContext(where, { file: path, key: paths.key }))
    if (state?.dirty === true) {
      await lock.unwrap().release()
      return Ok({ kind: 'recoverable', recoverable: recoverable(paths.key, state) })
    }
    const opened = await this.openArchive(paths, path, archive, lock.unwrap(), state)
    return opened.map((project) => ({ kind: 'opened', project }) as const)
  }

  /** Folder whose state names this file, else the first free `<id>`, `<id>~2`, …. */
  private async folderFor(
    projectId: string,
    filePath: string,
  ): AsyncAppResult<{ paths: ProjectPaths; state: ProjectState | undefined }> {
    for (let n = 1; n <= MAX_KEYS; n++) {
      const paths = projectPaths(this.o.appData, candidateKey(projectId, n))
      const exists = await tryAsync(() => this.fs.stat(paths.folder), 'persist.io', 'stat failed')
      if (exists.isErr()) return Err(exists.unwrapErr())
      if (exists.unwrap() === undefined) return Ok({ paths, state: undefined })
      const state = await readState(this.fs, paths)
      if (state.isErr()) {
        // Never reuse (and overwrite) a folder we cannot read.
        this.log.warn(
          { key: paths.key, err: state.unwrapErr().toJSON() },
          'unreadable project folder skipped',
        )
        continue
      }
      const s = state.unwrap()
      if (s.isNone()) {
        if (!this.sessions.has(paths.key)) return Ok({ paths, state: undefined })
        continue
      }
      const known = s.unwrap().filePath
      if (known !== null && samePath(known, filePath)) return Ok({ paths, state: s.unwrap() })
    }
    return fail('persist.io', 'no free project folder', {
      where: 'storage.folderFor',
      data: { projectId },
    })
  }

  /**
   * Unpacks a verified archive into a fresh `work/` and starts the session. With a previous
   * state of this folder, the revision starts above every revision it handed out (discarded
   * changes included), so a revision number never names two different documents.
   */
  private async openArchive(
    paths: ProjectPaths,
    filePath: string,
    archive: LoadedArchive,
    lock: Lock,
    prior: ProjectState | undefined,
  ): AsyncAppResult<OpenedProject> {
    const { manifest } = archive
    const sha = archive.sha256
    const revision =
      prior === undefined
        ? manifest.revision
        : Math.max(manifest.revision, prior.workingRevision) + 1
    const state: ProjectState = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId: manifest.projectId,
      filePath,
      dirty: false,
      workingRevision: revision,
      savedRevision: manifest.revision,
      savedSha256: sha,
    }
    const opened = await this.start(paths, archive.files, state, archive.doc, lock, {
      fill: this.assetFill(filePath, archive),
    })
    if (opened.isOk())
      this.log.info(
        { project: manifest.projectId, key: paths.key, rev: revision },
        'project opened',
      )
    return opened
  }

  /**
   * Unpack step for the assets of a verified archive: streams it a second time and writes only
   * the assets a record references (open starts with an empty undo history, so the others are
   * unreferenced and dropped). The archive must still be the one verified (same sha256).
   * `undefined` when there is nothing to extract (e.g. every v0.1 project): one pass only.
   */
  private assetFill(
    filePath: string,
    archive: LoadedArchive,
  ): ((fresh: string) => Promise<void>) | undefined {
    const keep = referencedAssets(archive.doc)
    if (!archive.manifest.files.some((f) => keep.has(f.path))) return undefined
    return async (fresh) => {
      const r = await readArchive(this.fs, filePath, {
        extract: { dir: fresh, want: (p) => keep.has(p) },
      })
      if (r.isErr()) throw r.unwrapErr()
      if (r.unwrap().sha256 !== archive.sha256)
        throw new AppError('input.malformed', 'the project file changed while opening', {
          where: 'storage.unpackAssets',
          data: { file: filePath },
        })
      await this.fs.fsyncDir(join(fresh, ASSET_DIR))
    }
  }

  /** With the lock held: unpacks `files` into `work/` (unless restoring it), starts the session. */
  private async start(
    paths: ProjectPaths,
    files: FileMap,
    state: ProjectState,
    doc: ProjectDoc,
    lock: Lock,
    opts: {
      readonly unpack?: boolean
      readonly fill?: ((fresh: string) => Promise<void>) | undefined
    } = {},
  ): AsyncAppResult<OpenedProject> {
    if (opts.unpack !== false) {
      const unpacked = await unpack(this.fs, paths, files, state, opts.fill)
      if (unpacked.isErr()) {
        await lock.release()
        return Err(unpacked.unwrapErr())
      }
    }
    const session = new MainSession(this, paths, lock, state, files)
    this.sessions.set(paths.key, session)
    lock.startHeartbeat((lost) => {
      const e = lost.unwrapErr()
      this.log.error({ key: paths.key, err: e.toJSON() }, 'project lock lost')
      this.o.onWarning?.(paths.key, 'the project was opened by another instance')
    }, this.o.heartbeatMs ?? LOCK_HEARTBEAT_MS)
    return Ok({ session, doc, revision: state.workingRevision })
  }

  async listRecoverable(): AsyncAppResult<readonly RecoverableProject[]> {
    const found = await scanRecoverable({
      fs: this.fs,
      appData: this.o.appData,
      log: this.log,
      lockDeps: (p) => this.lockDeps(p),
    })
    return found.map((list) => list.filter((r) => !this.sessions.has(r.key)))
  }

  async recover(key: string, action: RecoveryAction): AsyncAppResult<OpenedProject | undefined> {
    const where = `storage.recover.${action}`
    const root = resolve(projectsRoot(this.o.appData))
    if (
      !isProjectKey(key) ||
      !resolve(projectPaths(this.o.appData, key).folder).startsWith(root + sep)
    )
      return fail('input.malformed', 'not a project folder key', { where, data: { key } })
    if (this.sessions.has(key))
      return fail('persist.locked', 'the project is open', { where, data: { key } })
    const paths = projectPaths(this.o.appData, key)
    const state = await readState(this.fs, paths)
    if (state.isErr()) return Err(state.unwrapErr().withContext(where))
    if (state.unwrap().isNone() || !state.unwrap().unwrap().dirty)
      return fail('input.malformed', 'no unsaved changes to recover', { where, data: { key } })
    const s = state.unwrap().unwrap()
    const locked = await this.lock(paths)
    if (locked.isErr()) return Err(locked.unwrapErr().withContext(where))
    const lock = locked.unwrap()
    const abort = async (e: AppError) => {
      await lock.release()
      return Err(e.withContext(where, { key }))
    }

    if (action === 'restore') {
      const work = await loadWork(this.fs, paths)
      if (work.isErr()) return abort(work.unwrapErr())
      const { doc, files } = work.unwrap()
      // The undo history starts empty: assets only an undone or redone entry named go.
      await removeUnreferencedAssets(this.fs, paths.work, referencedAssets(doc), this.log)
      // Commits after the last flush were lost with their revisions: start above them.
      const restored = { ...s, workingRevision: s.workingRevision + 1 }
      const opened = await this.start(paths, files, restored, doc, lock, { unpack: false })
      if (opened.isOk())
        this.log.info(
          { project: s.projectId, key, rev: restored.workingRevision },
          'project restored',
        )
      return opened
    }

    // discard: check the project file first, so a broken file never costs the working folder.
    if (s.filePath === null) {
      const removed = await tryAsync(
        async () => {
          await this.fs.rm(paths.work)
          await this.fs.rm(paths.state)
          await lock.release().then((r) => r.unwrap())
          await this.removeIfEmpty(paths)
        },
        'persist.io',
        'discarding the working folder failed',
      )
      if (removed.isErr()) return abort(removed.unwrapErr())
      this.log.info({ project: s.projectId, key }, 'unsaved changes discarded')
      return Ok(undefined)
    }
    const archive = await loadArchive(this.fs, s.filePath)
    if (archive.isErr()) return abort(archive.unwrapErr())
    const opened = await this.openArchive(paths, s.filePath, archive.unwrap(), lock, s)
    if (opened.isOk()) this.log.info({ project: s.projectId, key }, 'unsaved changes discarded')
    return opened
  }

  private async removeIfEmpty(paths: ProjectPaths): Promise<void> {
    const saves = await this.fs.stat(paths.saves)
    if (saves !== undefined && (await this.fs.readdir(paths.saves)).length > 0) return
    await this.fs.rm(paths.folder)
  }

  async close(key: string): AsyncAppResult<void> {
    const session = this.sessions.get(key)
    if (session === undefined)
      return fail('input.malformed', 'no open project with this key', {
        where: 'storage.close',
        data: { key },
      })
    const r = await session.close()
    this.sessions.delete(key)
    return r
  }

  // --- used by sessions -----------------------------------------------------

  get deps() {
    return { fs: this.fs, clock: this.clock, log: this.log, o: this.o }
  }

  async afterClose(paths: ProjectPaths, state: ProjectState): Promise<void> {
    if (state.filePath === null && !state.dirty) {
      await this.fs.rm(paths.work)
      await this.fs.rm(paths.state)
      await this.removeIfEmpty(paths)
    }
  }
}

function recoverable(key: string, s: ProjectState): RecoverableProject {
  return {
    key,
    projectId: s.projectId,
    filePath: s.filePath,
    workingRevision: s.workingRevision,
    savedRevision: s.savedRevision,
  }
}

class MainSession implements ProjectSession {
  private readonly wf: WorkingFolder
  private revision: number
  private historyChecked = false
  private history: (() => HistoryView) | undefined

  constructor(
    private readonly storage: MainProjectStorage,
    private readonly paths: ProjectPaths,
    private readonly lock: Lock,
    state: ProjectState,
    files: FileMap,
  ) {
    const { fs, log, o } = storage.deps
    this.revision = state.workingRevision
    this.wf = new WorkingFolder({
      fs,
      paths,
      state,
      files,
      log,
      ...(o.debounceMs === undefined ? {} : { debounceMs: o.debounceMs }),
      onWarning: (m) => o.onWarning?.(paths.key, m),
    })
  }

  get key(): string {
    return this.paths.key
  }

  get projectId(): string {
    return this.wf.state.projectId
  }

  get filePath(): string | null {
    return this.wf.state.filePath
  }

  get dirty(): boolean {
    return this.wf.state.dirty
  }

  changed(patches: readonly Patch[], doc: ProjectDoc, revision: number): void {
    this.revision = revision
    this.wf.changed(patches, doc, revision)
  }

  flush(): AsyncAppResult<void> {
    return this.wf.flush()
  }

  importAsset(source: string, opts: { readonly maxBytes?: number } = {}): AsyncAppResult<AssetRef> {
    const { fs, log } = this.storage.deps
    return importAssetFile(fs, this.paths.work, source, opts).then((r) => {
      if (r.isOk())
        log.info(
          { project: this.projectId, asset: r.unwrap().path, size: r.unwrap().size },
          'asset imported',
        )
      return r
    })
  }

  assetFile(path: string): AppResult<string> {
    return assetFileIn(this.paths.work, path)
  }

  useHistory(history: () => HistoryView): void {
    this.history = history
  }

  /** Assets a save stores: named by a record or by an undo/redo entry (redo after reopen). */
  private savedAssets(doc: ProjectDoc): ArchiveAsset[] {
    const keep = referencedAssets(doc)
    const h = this.history?.()
    if (h !== undefined) historyAssets(h, keep)
    return [...keep].map((path) => ({ path, source: join(this.paths.work, path) }))
  }

  async save(doc: ProjectDoc, opts: SaveOptions = {}): AsyncAppResult<SaveOutcome> {
    const { fs, clock, log, o } = this.storage.deps
    const where = 'project.save'
    const current = this.wf.state.filePath
    const target = await this.resolveTarget(opts)
    if (target.isErr()) return Err(target.unwrapErr().withContext(where, { key: this.key }))
    const file = target.unwrap()
    const isCurrent = current !== null && samePath(file, current)
    const started = clock.now()
    // 1. Flush the working folder.
    const flushed = await this.flush()
    if (flushed.isErr()) return Err(flushed.unwrapErr().withContext(where))
    const warnings: string[] = []
    const warn = (e: AppError, message: string) => {
      log.warn({ project: this.projectId, err: e.toJSON() }, message)
      warnings.push(message)
    }
    if (!isCurrent) {
      // Another file is replaced only with confirm and after a copy into the history.
      const guarded = await this.guardForeignTarget(file, opts.confirm === true)
      if (guarded.isErr()) return Err(guarded.unwrapErr().withContext(where, { key: this.key }))
    } else if (!this.historyChecked) {
      // Keep the opened file before the first replace, unless it is in saves/ already.
      const kept = await this.keepOpenedFile(file)
      if (kept.isErr()) warn(kept.unwrapErr(), 'previous version not added to the save history')
    }
    if (isCurrent) this.historyChecked = true
    // 2.–4. Build, verify, replace.
    const files = docToFiles(doc)
    if (files.isErr()) return Err(files.unwrapErr().withContext(where))
    const savedAt = new Date(clock.now()).toISOString()
    const revision = this.revision
    const built = await writeVerifiedArchive({
      fs,
      target: file,
      files: files.unwrap(),
      assets: this.savedAssets(doc),
      info: { projectId: this.projectId, appVersion: o.appVersion, savedAt, revision },
      log,
    })
    if (built.isErr()) return Err(built.unwrapErr().withContext(where, { key: this.key }))
    const archive = built.unwrap()
    // 5. Save history and retention (warnings only).
    const copied = await addToHistory({
      fs,
      saves: this.paths.saves,
      source: file,
      manifest: archive.manifest,
      onlyIfNew: false,
    })
    if (copied.isErr()) warn(copied.unwrapErr(), 'save not added to the save history')
    const trimmed = await applyRetention({ fs, appData: o.appData, log })
    if (trimmed.isErr()) warn(trimmed.unwrapErr(), 'save-history limits not applied')
    // 6. state.json.
    const updated = await this.wf.updateState({
      filePath: file,
      dirty: false,
      workingRevision: revision,
      savedRevision: revision,
      savedSha256: archive.sha256,
    })
    if (updated.isErr()) warn(updated.unwrapErr(), 'project state not updated')
    log.info(
      {
        project: this.projectId,
        rev: revision,
        ms: clock.now() - started,
        size: archive.size,
      },
      'project saved',
    )
    return Ok({ filePath: file, revision, savedAt, sha256: archive.sha256, warnings })
  }

  /** Canonical target: the current file, or a `.dfyom` Save As path. */
  private async resolveTarget(opts: SaveOptions): AsyncAppResult<string> {
    const current = this.wf.state.filePath
    if (opts.target === undefined)
      return current === null
        ? fail('input.malformed', 'an untitled project needs a target file', {
            issues: [{ path: ['target'], rule: 'required', message: 'choose a file' }],
          })
        : Ok(current)
    if (!isProjectFileName(opts.target))
      return fail('input.malformed', 'the target must be a .dfyom file', {
        issues: [{ path: ['target'], rule: 'extension', message: 'must end with .dfyom' }],
      })
    const target = opts.target
    return tryAsync(
      () => canonicalPath(this.storage.deps.fs, resolve(target)),
      'persist.io',
      'resolving the target path failed',
    )
  }

  /**
   * An existing file that is not this project's: needs `confirm`, must be a DFYOM archive (any
   * other file is never replaced) and is copied into this project's history first.
   */
  private async guardForeignTarget(file: string, confirm: boolean): AsyncAppResult<void> {
    const { fs } = this.storage.deps
    const exists = await tryAsync(() => fs.stat(file), 'persist.io', 'stat failed')
    if (exists.isErr()) return Err(exists.unwrapErr())
    if (exists.unwrap() === undefined) return Ok(undefined)
    if (!confirm)
      return fail('input.malformed', 'the target exists; confirm to replace it', {
        data: { target: file },
        issues: [{ path: ['confirm'], rule: 'confirmOverwrite', message: 'set confirm: true' }],
      })
    const read = await readArchive(fs, file)
    if (read.isErr())
      return fail('input.malformed', 'refusing to replace a file that is not a DFYOM project', {
        data: { target: file },
        cause: read.unwrapErr(),
      })
    const added = await addToHistory({
      fs,
      saves: this.paths.saves,
      source: file,
      manifest: read.unwrap().manifest,
      onlyIfNew: true,
    })
    return added.map(() => undefined)
  }

  private async keepOpenedFile(file: string): AsyncAppResult<void> {
    const { fs } = this.storage.deps
    const exists = await tryAsync(() => fs.stat(file), 'persist.io', 'stat failed')
    if (exists.isErr() || exists.unwrap() === undefined) return exists.map(() => undefined)
    const read = await readArchive(fs, file)
    // A file that is not a valid archive is not ours to keep; the save still replaces it.
    if (read.isErr()) return Ok(undefined)
    const added = await addToHistory({
      fs,
      saves: this.paths.saves,
      source: file,
      manifest: read.unwrap().manifest,
      onlyIfNew: true,
    })
    return added.map(() => undefined)
  }

  async close(): AsyncAppResult<void> {
    const { log } = this.storage.deps
    const flushed = await this.flush()
    this.wf.dispose()
    if (flushed.isErr())
      log.warn(
        { project: this.projectId, err: flushed.unwrapErr().toJSON() },
        'flush on close failed',
      )
    // Release first: only a lock holder (under the takeover mutex) may delete lock.json.
    const released = await this.lock.release()
    const tidy = await tryAsync(
      () => this.storage.afterClose(this.paths, this.wf.state),
      'persist.io',
      'cleanup failed',
    )
    if (tidy.isErr())
      log.warn(
        { project: this.projectId, err: tidy.unwrapErr().toJSON() },
        'project folder cleanup failed',
      )
    log.info({ project: this.projectId, key: this.key, dirty: this.dirty }, 'project closed')
    return flushed.isErr() ? flushed : released
  }
}
