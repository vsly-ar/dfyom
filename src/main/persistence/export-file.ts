/**
 * The `ExportFiles` port over the file system: exported gCode files written into the user's
 * folder like Save As – a random temp file next to the target, renamed over it.
 * Doc: docs/architecture/grbl.md#plan-export-command
 */
import { randomBytes } from 'node:crypto'
import path, { dirname } from 'node:path'
import type { ExportFiles } from '../../core/post/plan-export'
import { Err, fail, Ok, tryAsync } from '../../shared/result'
import { canonicalPath, nodeFs, renameWithRetry, type PersistFs } from './fs'

type PathApi = Pick<typeof path, 'isAbsolute' | 'normalize' | 'parse' | 'sep'>

/**
 * Absolute and normalized (no `.`, `..`, doubled separators), with a real root: on Windows a
 * drive (`C:\`) or a UNC share, never a drive-relative `\out` or `C:out`, and no `:` after the
 * root (alternate data streams).
 */
export function isSafeAbsolutePath(p: string, api: PathApi = path): boolean {
  if (!api.isAbsolute(p) || api.normalize(p) !== p) return false
  const { root } = api.parse(p)
  if (api.sep === '\\' && !/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)$/.test(root)) return false
  return !p.slice(root.length).includes(':')
}

export function createExportFiles(fs: PersistFs = nodeFs): ExportFiles {
  return {
    async write(target, text, opts) {
      const where = 'exportFiles.write'
      const data = { target }
      const invalid = (message: string, issuePath: string, rule: string, hint: string) =>
        fail('input.malformed', message, {
          where,
          data,
          issues: [{ path: [issuePath], rule, message: hint }],
        })
      if (!isSafeAbsolutePath(target))
        return invalid(
          'the export target must be an absolute path',
          'target',
          'absolutePath',
          'use an absolute path',
        )
      // lstat: any entry counts as existing, also a symlink (dangling or not)
      const entry = await tryAsync(() => fs.lstat(target), 'persist.io', 'stat failed')
      if (entry.isErr()) return Err(entry.unwrapErr().withContext(where, data))
      const found = entry.unwrap()
      if (found?.isDirectory === true)
        return invalid('the export target is a folder', 'target', 'notAFile', 'choose a file')
      if (found !== undefined && !opts.confirm)
        return invalid(
          'the target exists; confirm to replace it',
          'confirm',
          'confirmOverwrite',
          'set confirm: true',
        )
      // like Save As: write the real file a symlink points to, never replace the link
      const real = await tryAsync(() => canonicalPath(fs, target), 'persist.io', 'resolve failed')
      if (real.isErr()) return Err(real.unwrapErr().withContext(where, data))
      const file = real.unwrap()
      if (found?.isSymbolicLink === true) {
        const resolved = await tryAsync(() => fs.lstat(file), 'persist.io', 'stat failed')
        if (resolved.isErr()) return Err(resolved.unwrapErr().withContext(where, data))
        const r = resolved.unwrap()
        if (r === undefined || r.isSymbolicLink)
          return invalid(
            'the target is a link to nothing',
            'target',
            'danglingLink',
            'choose another file',
          )
        if (r.isDirectory)
          return invalid('the export target is a folder', 'target', 'notAFile', 'choose a file')
      }
      const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
      const written = await tryAsync(
        async () => {
          await fs.writeFile(tmp, text, { exclusive: true })
          await fs.fsync(tmp)
          await renameWithRetry(fs, tmp, file)
        },
        'persist.io',
        'writing the gCode file failed',
      )
      if (written.isErr()) {
        // only our own temp file, never recursively
        await fs.unlink(tmp).catch(() => undefined)
        return Err(written.unwrapErr().withContext(where, { target, file }))
      }
      // the rename happened: a failed directory fsync does not undo the export
      await fs.fsyncDir(dirname(file)).catch(() => undefined)
      return Ok({ filePath: file })
    },
  }
}
