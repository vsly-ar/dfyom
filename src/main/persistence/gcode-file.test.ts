// The `GcodeFiles` port over the file system (DF93): absolute paths only, a size cap, missing
// files and folders. Doc: docs/modes/run.md#run-an-external-g-code-file-df93
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createGcodeFiles, readGcodeFile } from './gcode-file'
import { nodeFs } from './fs'
import { useTempDir } from './fs.testing'

const tmp = useTempDir()

describe('reading gCode files for a run (DF93)', () => {
  it('reads an absolute path as text', async () => {
    const file = join(tmp.dir, 'part.nc')
    writeFileSync(file, 'G21\nG0 X1 (Ø 6)\n')
    expect(expectOk(await createGcodeFiles().read(file))).toBe('G21\nG0 X1 (Ø 6)\n')
  })

  it('refuses relative paths, folders and files over the cap; a missing file is persist.io', async () => {
    const rule = (r: Awaited<ReturnType<typeof readGcodeFile>>) =>
      expectErrCode(r, 'input.malformed').issues[0]?.rule
    expect(rule(await readGcodeFile(nodeFs, 'part.nc'))).toBe('absolutePath')
    const folder = join(tmp.dir, 'f.nc')
    mkdirSync(folder)
    expect(rule(await readGcodeFile(nodeFs, folder))).toBe('notAFile')
    const big = { ...nodeFs, stat: async () => ({ size: 60 * 1024 * 1024, isDirectory: false }) }
    expect(rule(await readGcodeFile(big, join(tmp.dir, 'big.nc')))).toBe('fileTooLarge')
    expectErrCode(await readGcodeFile(nodeFs, join(tmp.dir, 'missing.nc')), 'persist.io')
  })
})
