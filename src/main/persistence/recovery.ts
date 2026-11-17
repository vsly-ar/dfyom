/**
 * Crash recovery: scan for project folders with unsaved changes, load a working folder.
 * Doc: docs/architecture/persistence.md#crash-recovery
 *
 * Restore/discard themselves need the lock and a session, so they live in storage.ts.
 */
import type { ProjectDoc } from '../../core/project/document'
import { loadProjectFiles, type FileMap } from '../../core/project/layout'
import type { RecoverableProject } from '../../core/project/storage'
import type { Logger } from '../../shared/logging'
import { Err, Ok, tryAsync, type AsyncAppResult } from '../../shared/result'
import type { PersistFs } from './fs'
import { inspectLock, type LockDeps } from './lock'
import { projectPaths, projectsRoot, type ProjectPaths } from './paths'
import { readState, readWork } from './working-folder'

export interface ScanOptions {
  readonly fs: PersistFs
  readonly appData: string
  readonly log: Logger
  /** Lock deps for a project folder (owner, clock, PID check). */
  readonly lockDeps: (paths: ProjectPaths) => LockDeps
}

/** Folders with `dirty: true` and no live lock, sorted by key; unreadable folders are logged and skipped. */
export async function scanRecoverable(o: ScanOptions): AsyncAppResult<RecoverableProject[]> {
  const root = projectsRoot(o.appData)
  const keys = await tryAsync(
    async () => ((await o.fs.stat(root)) === undefined ? [] : (await o.fs.readdir(root)).sort()),
    'persist.io',
    'listing project folders failed',
  )
  if (keys.isErr()) return Err(keys.unwrapErr().withContext('recovery.scan'))
  const found: RecoverableProject[] = []
  for (const key of keys.unwrap()) {
    const paths = projectPaths(o.appData, key)
    const state = await readState(o.fs, paths)
    if (state.isErr()) {
      o.log.warn(
        { key, err: state.unwrapErr().toJSON() },
        'project folder skipped in recovery scan',
      )
      continue
    }
    if (state.unwrap().isNone()) continue
    const s = state.unwrap().unwrap()
    if (!s.dirty) continue
    const lock = await inspectLock(o.lockDeps(paths))
    if (lock.isErr() || lock.unwrap().state === 'live') continue
    found.push({
      key,
      projectId: s.projectId,
      filePath: s.filePath,
      workingRevision: s.workingRevision,
      savedRevision: s.savedRevision,
    })
  }
  return Ok(found)
}

/** `work/` through the load pipeline (the schema version was checked on `state.json`). */
export async function loadWork(
  fs: PersistFs,
  paths: ProjectPaths,
): AsyncAppResult<{ readonly doc: ProjectDoc; readonly files: FileMap }> {
  const files = await readWork(fs, paths)
  if (files.isErr()) return Err(files.unwrapErr())
  return loadProjectFiles(files.unwrap())
    .map((doc) => ({ doc, files: files.unwrap() }))
    .mapErr((e) => e.withContext('recovery.loadWork', { key: paths.key }))
}
