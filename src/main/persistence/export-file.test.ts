// Spec: docs/architecture/grbl.md#plan-export-command
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createExportFiles, isSafeAbsolutePath } from './export-file'
import { faultFs, useTempDir } from './fs.testing'

const tmp = useTempDir()

describe('createExportFiles', () => {
  it('writes a new file atomically (no temp file left) and returns its real path', async () => {
    const target = join(realpathSync(tmp.dir), 'plan.nc')
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

  it('rejects relative paths and directories; errors name the target', async () => {
    const files = createExportFiles()
    const rel = expectErrCode(
      await files.write('plan.nc', 'x', { confirm: true }),
      'input.malformed',
    )
    expect(rel.frames[0]?.data).toMatchObject({ target: 'plan.nc' })
    const dir = join(tmp.dir, 'd.nc')
    await mkdir(dir)
    const d = expectErrCode(await files.write(dir, 'x', { confirm: true }), 'input.malformed')
    expect(d.frames[0]?.data).toMatchObject({ target: dir })
    const target = join(tmp.dir, 'plan.nc')
    await writeFile(target, 'old')
    const c = expectErrCode(await files.write(target, 'x', { confirm: false }), 'input.malformed')
    expect(c.frames[0]?.data).toMatchObject({ target })
  })

  it('a stat failure carries the target', async () => {
    const target = join(tmp.dir, 'plan.nc')
    const fs = faultFs((op) => (op === 'lstat' ? 'fail' : undefined))
    const e = expectErrCode(
      await createExportFiles(fs).write(target, 'x', { confirm: false }),
      'persist.io',
    )
    expect(e.frames.some((f) => f.data?.['target'] === target)).toBe(true)
  })

  it('never touches a user file or folder named like the old fixed temp file', async () => {
    const target = join(tmp.dir, 'plan.nc')
    await mkdir(join(tmp.dir, 'plan.nc.tmp'))
    await writeFile(join(tmp.dir, 'plan.nc.tmp', 'keep'), 'mine')
    expectOk(await createExportFiles().write(target, 'new', { confirm: false }))
    expect(await readFile(join(tmp.dir, 'plan.nc.tmp', 'keep'), 'utf8')).toBe('mine')
    const other = join(tmp.dir, 'b.nc')
    await writeFile(`${other}.tmp`, 'mine too')
    // a failing rename: the random temp file is removed, the user's file is kept
    const fs = faultFs((op) => (op === 'rename' ? 'fail' : undefined))
    expectErrCode(await createExportFiles(fs).write(other, 'new', { confirm: false }), 'persist.io')
    expect(await readFile(`${other}.tmp`, 'utf8')).toBe('mine too')
    expect((await readdir(tmp.dir)).sort()).toEqual(['b.nc.tmp', 'plan.nc', 'plan.nc.tmp'])
  })

  it('writes through a symlink to the real file, only with confirm', async () => {
    const dir = realpathSync(tmp.dir)
    const real = join(dir, 'real.nc')
    const link = join(dir, 'link.nc')
    await writeFile(real, 'old')
    await symlink(real, link)
    expectErrCode(
      await createExportFiles().write(link, 'new', { confirm: false }),
      'input.malformed',
    )
    const r = expectOk(await createExportFiles().write(link, 'new', { confirm: true }))
    expect(r.filePath).toBe(real)
    expect(await readFile(real, 'utf8')).toBe('new')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(real)
  })

  it('a dangling symlink counts as existing and is never replaced', async () => {
    const link = join(tmp.dir, 'dangling.nc')
    await symlink(join(tmp.dir, 'gone.nc'), link)
    const files = createExportFiles()
    const e = expectErrCode(await files.write(link, 'x', { confirm: false }), 'input.malformed')
    expect(e.issues[0]?.rule).toBe('confirmOverwrite')
    const d = expectErrCode(await files.write(link, 'x', { confirm: true }), 'input.malformed')
    expect(d.issues[0]?.rule).toBe('danglingLink')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('accepts only absolute, normalized paths with a real root (no drive-relative paths or streams)', () => {
    expect(isSafeAbsolutePath('/out/a.nc', posix)).toBe(true)
    expect(isSafeAbsolutePath('out/a.nc', posix)).toBe(false)
    expect(isSafeAbsolutePath('/out/../a.nc', posix)).toBe(false)
    expect(isSafeAbsolutePath('C:\\out\\a.nc', win32)).toBe(true)
    expect(isSafeAbsolutePath('\\\\server\\share\\a.nc', win32)).toBe(true)
    expect(isSafeAbsolutePath('\\out\\a.nc', win32)).toBe(false)
    expect(isSafeAbsolutePath('C:out\\a.nc', win32)).toBe(false)
    expect(isSafeAbsolutePath('C:\\out\\a.nc:stream', win32)).toBe(false)
    expect(isSafeAbsolutePath('C:\\out\\..\\a.nc', win32)).toBe(false)
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
