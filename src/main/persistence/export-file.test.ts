// Spec: docs/architecture/grbl.md#plan-export-command
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createExportFiles } from './export-file'
import { faultFs, useTempDir } from './fs.testing'

const tmp = useTempDir()

describe('createExportFiles', () => {
  it('writes a new file atomically (no temp file left)', async () => {
    const target = join(tmp.dir, 'plan.nc')
    const r = expectOk(await createExportFiles().write(target, 'G0 Z10\n', { confirm: false }))
    expect(r.filePath).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('G0 Z10\n')
    expect(await readdir(tmp.dir)).toEqual(['plan.nc'])
  })

  it('replaces an existing file only with confirm', async () => {
    const target = join(tmp.dir, 'plan.nc')
    await writeFile(target, 'old')
    const e = expectErrCode(
      await createExportFiles().write(target, 'new', { confirm: false }),
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['confirm'], rule: 'confirmOverwrite' })
    expect(await readFile(target, 'utf8')).toBe('old')
    expectOk(await createExportFiles().write(target, 'new', { confirm: true }))
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('rejects relative paths and directories', async () => {
    const files = createExportFiles()
    expectErrCode(await files.write('plan.nc', 'x', { confirm: true }), 'input.malformed')
    const dir = join(tmp.dir, 'd.nc')
    await mkdir(dir)
    expectErrCode(await files.write(dir, 'x', { confirm: true }), 'input.malformed')
  })

  it('fails with persist.io when the folder is missing or a write fails; the target is kept', async () => {
    expectErrCode(
      await createExportFiles().write(join(tmp.dir, 'none', 'a.nc'), 'x', { confirm: false }),
      'persist.io',
    )
    const target = join(tmp.dir, 'plan.nc')
    await writeFile(target, 'old')
    const fs = faultFs((op) => (op === 'rename' ? 'fail' : undefined))
    expectErrCode(await createExportFiles(fs).write(target, 'new', { confirm: true }), 'persist.io')
    expect(await readFile(target, 'utf8')).toBe('old')
  })
})
