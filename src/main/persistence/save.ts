/**
 * Save steps 2–4 (build, verify, replace) and the save-history copy (step 5).
 * Doc: docs/architecture/persistence.md#save
 */
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { FileMap, Manifest } from '../../core/project/layout'
import type { Logger } from '../../shared/logging'
import {
  Err,
  None,
  Ok,
  Some,
  tryAsync,
  type AsyncAppResult,
  type Option,
} from '../../shared/result'
import { AppError } from '../../shared/errors/app-error'
import {
  hashFile,
  loadArchive,
  writeArchive,
  type ArchiveAsset,
  type ArchiveInfo,
  type WrittenArchive,
} from './archive'
import { renameWithRetry, type PersistFs } from './fs'
import { isSaveFileName, saveFileName } from './retention'

const TEMP_SUFFIX = /\.tmp-[0-9a-f]{8}$/

export interface WriteArchiveOptions {
  readonly fs: PersistFs
  /** The project file to create or replace. */
  readonly target: string
  readonly files: FileMap
  /** Assets to store (`assets/<sha256>.stl` and the working-folder file). */
  readonly assets?: readonly ArchiveAsset[]
  readonly info: ArchiveInfo
  readonly log: Logger
}

/**
 * Streams `<target>.tmp-<random>` next to the target, fsyncs it, verifies it by streaming it
 * back from disk (entry set, sizes, hashes incl. assets, full load pipeline) and renames it over
 * the target. Any failure before the rename deletes the temp file and leaves the target untouched.
 */
export async function writeVerifiedArchive(o: WriteArchiveOptions): AsyncAppResult<WrittenArchive> {
  const where = 'save.writeArchive'
  const data = { target: o.target }
  const tmp = `${o.target}.tmp-${randomBytes(4).toString('hex')}`
  const cleanup = async () => {
    await o.fs.rm(tmp).catch(() => undefined)
  }

  const written = await writeArchive(o.fs, tmp, o.files, o.assets ?? [], o.info)
  const synced = written.isErr()
    ? written
    : await tryAsync(() => o.fs.fsync(tmp), 'persist.io', 'fsync of the temp archive failed')
  if (written.isErr() || synced.isErr()) {
    await cleanup()
    const e = written.isErr() ? written.unwrapErr() : synced.unwrapErr()
    return Err(e.withContext(where, data))
  }
  const built = written.unwrap()
  const loaded = await loadArchive(o.fs, tmp)
  if (loaded.isErr() && loaded.unwrapErr().code === 'persist.io') {
    // Reading it back failed: an I/O error, not a failed verification.
    await cleanup()
    return Err(loaded.unwrapErr().withContext(where, data))
  }
  const verifyError = loaded.isErr()
    ? loaded.unwrapErr()
    : loaded.unwrap().sha256 !== built.sha256 ||
        JSON.stringify(loaded.unwrap().manifest) !== JSON.stringify(built.manifest)
      ? new AppError('input.malformed', 'archive on disk differs from the one built')
      : undefined
  if (verifyError !== undefined) {
    await cleanup()
    return Err(
      new AppError('persist.verify', 'the temp archive failed verification', {
        where,
        data,
        cause: verifyError,
      }),
    )
  }

  const renamed = await tryAsync(
    () => renameWithRetry(o.fs, tmp, o.target),
    'persist.io',
    'replacing the project file failed',
  )
  if (renamed.isErr()) {
    await cleanup()
    return Err(renamed.unwrapErr().withContext(where, data))
  }
  // After the rename the save has happened: later problems are warnings, not failures.
  const dir = dirname(o.target)
  const dirSynced = await tryAsync(
    () => o.fs.fsyncDir(dir),
    'persist.io',
    'fsync of the folder failed',
  )
  if (dirSynced.isErr())
    o.log.warn({ err: dirSynced.unwrapErr().toJSON() }, 'project folder fsync failed')
  await removeStaleTemps(o.fs, o.target, o.log)
  return Ok(built)
}

/** Deletes `<target>.tmp-<8 hex>` left by a crashed save of the same target (best effort). */
async function removeStaleTemps(fs: PersistFs, target: string, log: Logger): Promise<void> {
  const prefix = `${basename(target)}.tmp-`
  const r = await tryAsync(
    async () => {
      for (const name of await fs.readdir(dirname(target)))
        if (name.startsWith(prefix) && TEMP_SUFFIX.test(name))
          await fs.rm(join(dirname(target), name))
    },
    'persist.io',
    'removing stale temp archives failed',
  )
  if (r.isErr()) log.warn({ err: r.unwrapErr().toJSON() }, 'stale temp archive cleanup failed')
}

/**
 * Copies an archive into `saves/` as `<savedAt>-r<revision>.dfyom` (copy-on-write clone where
 * supported, then rename). `onlyIfNew`: skip when a save with the same sha256 exists.
 * Returns the save's file name, or `None` if skipped.
 */
export async function addToHistory(o: {
  readonly fs: PersistFs
  readonly saves: string
  readonly source: string
  readonly manifest: Manifest
  readonly onlyIfNew: boolean
}): AsyncAppResult<Option<string>> {
  return tryAsync(
    async () => {
      await o.fs.mkdir(o.saves)
      if (o.onlyIfNew) {
        const { sha256: hash, size } = await hashFile(o.fs, o.source)
        for (const name of await o.fs.readdir(o.saves)) {
          if (!isSaveFileName(name)) continue
          const file = join(o.saves, name)
          if ((await o.fs.stat(file))?.size !== size) continue
          if ((await hashFile(o.fs, file)).sha256 === hash) return None
        }
      }
      const name = saveFileName(o.manifest.savedAt, o.manifest.revision)
      const tmp = join(o.saves, `${name}.tmp`)
      await o.fs.copyFile(o.source, tmp)
      await o.fs.fsync(tmp)
      await renameWithRetry(o.fs, tmp, join(o.saves, name))
      return Some(name)
    },
    'persist.io',
    'copying into the save history failed',
  )
}
