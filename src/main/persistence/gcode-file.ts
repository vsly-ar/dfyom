/**
 * The `GcodeFiles` port over the file system (DF93): reads an external gCode file for a run, an
 * absolute normalized path of at most `MAX_GCODE_FILE_BYTES`, as UTF-8 text.
 * Doc: docs/modes/run.md#run-an-external-g-code-file-df93
 */
import { Err, fail, Ok, tryAsync, type AsyncAppResult } from '../../shared/result'
import { MAX_GCODE_FILE_BYTES, type GcodeFiles } from '../../core/run/gcode-file'
import { isSafeAbsolutePath } from './export-file'
import { nodeFs, type PersistFs } from './fs'

export function createGcodeFiles(fs: PersistFs = nodeFs): GcodeFiles {
  return { read: (path) => readGcodeFile(fs, path) }
}

/** The file's text; `input.malformed` (`absolutePath`, `notAFile`, `fileTooLarge`) or `persist.io`. */
export async function readGcodeFile(fs: PersistFs, path: string): AsyncAppResult<string> {
  const where = 'gcodeFiles.read'
  const data = { file: path }
  const invalid = (message: string, rule: string, hint: string) =>
    fail('input.malformed', message, {
      where,
      data,
      issues: [{ path: ['file'], rule, message: hint }],
    })
  if (!isSafeAbsolutePath(path))
    return invalid('the file must be an absolute path', 'absolutePath', 'use an absolute path')
  const entry = await tryAsync(() => fs.stat(path), 'persist.io', 'stat failed')
  if (entry.isErr()) return Err(entry.unwrapErr().withContext(where, data))
  const found = entry.unwrap()
  if (found === undefined)
    return fail('persist.io', 'the file does not exist', {
      where,
      data: { ...data, missing: true },
    })
  if (found.isDirectory) return invalid('the path is a folder', 'notAFile', 'choose a file')
  if (found.size > MAX_GCODE_FILE_BYTES)
    return invalid(
      `the file is ${Math.round(found.size / 1e6)} MB; DFYOM runs files up to ${MAX_GCODE_FILE_BYTES / 1024 / 1024} MB`,
      'fileTooLarge',
      'split the program',
    )
  const bytes = await tryAsync(() => fs.readFile(path), 'persist.io', 'read failed')
  if (bytes.isErr()) return Err(bytes.unwrapErr().withContext(where, data))
  return Ok(new TextDecoder().decode(bytes.unwrap()))
}
