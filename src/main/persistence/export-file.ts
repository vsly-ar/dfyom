/**
 * The `ExportFiles` port over the file system: atomic writes of exported gCode files.
 * Doc: docs/architecture/grbl.md#plan-export-command
 */
import { isAbsolute } from 'node:path'
import type { ExportFiles } from '../../core/post/plan-export'
import { Err, fail, Ok, tryAsync } from '../../shared/result'
import { nodeFs, writeFileAtomic, type PersistFs } from './fs'

export function createExportFiles(fs: PersistFs = nodeFs): ExportFiles {
  return {
    async write(target, text, opts) {
      const where = 'exportFiles.write'
      if (!isAbsolute(target))
        return fail('input.malformed', 'the export target must be an absolute path', {
          where,
          issues: [{ path: ['target'], rule: 'absolutePath', message: 'use an absolute path' }],
        })
      const existing = await tryAsync(() => fs.stat(target), 'persist.io', 'stat failed')
      if (existing.isErr()) return Err(existing.unwrapErr())
      const found = existing.unwrap()
      if (found?.isDirectory === true)
        return fail('input.malformed', 'the export target is a folder', {
          where,
          issues: [{ path: ['target'], rule: 'notAFile', message: 'choose a file, not a folder' }],
        })
      if (found !== undefined && !opts.confirm)
        return fail('input.malformed', 'the target exists; confirm to replace it', {
          where,
          issues: [{ path: ['confirm'], rule: 'confirmOverwrite', message: 'set confirm: true' }],
        })
      const written = await writeFileAtomic(fs, target, text)
      if (written.isErr()) {
        // best effort: never leave the temp file behind
        await tryAsync(() => fs.rm(`${target}.tmp`), 'persist.io', 'cleanup failed')
        return Err(written.unwrapErr().withContext(where, { target }))
      }
      return Ok({ filePath: target })
    },
  }
}
