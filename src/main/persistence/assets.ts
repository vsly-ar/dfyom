/**
 * Working-folder assets: import (streamed copy, hashed while copying, atomic) and cleanup of
 * files no record references. Doc: docs/architecture/persistence.md#assets-and-references-v02
 */
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  ASSET_DIR,
  assetPathOf,
  isAssetPath,
  type AssetFormat,
  type AssetRef,
} from '../../core/project/assets'
import type { Logger } from '../../shared/logging'
import { fail, Ok, tryAsync, type AppResult, type AsyncAppResult } from '../../shared/result'
import { chunks } from './archive'
import { renameWithRetry, type PersistFs } from './fs'

/** Absolute file of an asset path inside `work/`; refuses anything but `assets/<sha256>.stl`. */
export function assetFileIn(work: string, path: string): AppResult<string> {
  return isAssetPath(path)
    ? Ok(join(work, path))
    : fail('input.malformed', 'not an asset path', { where: 'assets.file', data: { path } })
}

/**
 * Copies `source` into `<work>/assets/<sha256>.<format>`: streamed into a temp file (hashing on
 * the way), fsynced, renamed. Importing the same content again stores it once.
 */
export async function importAssetFile(
  fs: PersistFs,
  work: string,
  source: string,
  format: AssetFormat = 'stl',
): AsyncAppResult<AssetRef> {
  const dir = join(work, ASSET_DIR)
  const tmp = join(dir, `import-${randomBytes(4).toString('hex')}.tmp`)
  const r = await tryAsync(
    async () => {
      await fs.mkdir(dir)
      await fs.writeFile(tmp, new Uint8Array(0))
      const hash = createHash('sha256')
      let size = 0
      for await (const chunk of chunks(fs, source)) {
        hash.update(chunk)
        size += chunk.length
        await fs.appendFile(tmp, chunk)
      }
      await fs.fsync(tmp)
      const sha256 = hash.digest('hex')
      const path = assetPathOf(sha256, format)
      // Same content, same name: replacing an existing copy is harmless (and repairs a damaged one).
      await renameWithRetry(fs, tmp, join(work, path))
      await fs.fsyncDir(dir)
      return { path, sha256, size }
    },
    'persist.io',
    'copying the file into the project failed',
  )
  if (r.isErr()) {
    await fs.unlink(tmp).catch(() => undefined)
    return r.mapErr((e) => e.withContext('assets.import', { source }))
  }
  return r
}

/**
 * Deletes every file in `<work>/assets/` whose path is not in `keep` (unreferenced assets,
 * leftover import temp files). Best effort: failures are logged, never returned.
 */
export async function removeUnreferencedAssets(
  fs: PersistFs,
  work: string,
  keep: ReadonlySet<string>,
  log: Logger,
): Promise<number> {
  const dir = join(work, ASSET_DIR)
  let removed = 0
  const r = await tryAsync(
    async () => {
      if ((await fs.stat(dir)) === undefined) return
      for (const name of await fs.readdir(dir))
        if (!keep.has(`${ASSET_DIR}/${name}`)) {
          await fs.rm(join(dir, name))
          removed++
        }
    },
    'persist.io',
    'removing unreferenced assets failed',
  )
  if (r.isErr()) log.warn({ err: r.unwrapErr().toJSON() }, 'unreferenced asset cleanup failed')
  else if (removed > 0) log.info({ removed }, 'unreferenced assets removed')
  return removed
}
