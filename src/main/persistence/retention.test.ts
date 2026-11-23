import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { noopLogger } from '../../shared/logging'
import { expectOk } from '../../shared/testing/result'
import { testFs, useTempDir } from './fs.testing'
import { projectPaths } from './paths'
import {
  applyRetention,
  isSaveFileName,
  planRetention,
  RETENTION_LIMITS,
  saveFileName,
  type SaveFile,
} from './retention'

const MB = 1024 * 1024
const save = (key: string, i: number, size: number): SaveFile => ({
  key,
  name: saveFileName(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), i),
  size,
})
const names = (files: readonly SaveFile[]) => files.map((f) => `${f.key}:${f.name.slice(17, 19)}`)

describe('save file names', () => {
  it('are <savedAt>-r<revision>.dfyom, safe on every OS and sorting by time', () => {
    expect(saveFileName('2026-11-17T10:00:05.123Z', 12)).toBe('2026-11-17T10-00-05.123Z-r12.dfyom')
    expect(isSaveFileName('2026-11-17T10-00-05.123Z-r12.dfyom')).toBe(true)
    expect(isSaveFileName('notes.txt')).toBe(false)
  })
})

describe('planRetention', () => {
  it('keeps the limits fixed at 20 saves, 200 MB per project and 2 GB in total', () => {
    expect(RETENTION_LIMITS).toEqual({
      maxSaves: 20,
      maxProjectBytes: 200 * MB,
      maxTotalBytes: 2048 * MB,
    })
  })

  it('deletes the oldest saves beyond 20 per project', () => {
    const files = Array.from({ length: 22 }, (_, i) => save('a', i + 10, 1))
    expect(names(planRetention(files))).toEqual(['a:10', 'a:11'])
  })

  it('deletes oldest first down to 200 MB per project', () => {
    const files = [save('a', 10, 90 * MB), save('a', 11, 90 * MB), save('a', 12, 90 * MB)]
    expect(names(planRetention(files))).toEqual(['a:10'])
  })

  it('never deletes the newest save of a project, even when it alone is over a limit', () => {
    expect(planRetention([save('a', 10, 300 * MB)])).toEqual([])
    expect(names(planRetention([save('a', 10, 1), save('a', 11, 300 * MB)]))).toEqual(['a:10'])
  })

  it('applies the total limit across projects, oldest first', () => {
    const files = [
      ...Array.from({ length: 12 }, (_, i) => save('a', 10 + i, 190 * MB)).slice(-1),
      save('b', 10, 190 * MB),
    ]
    expect(planRetention(files)).toEqual([])
    const many = Array.from({ length: 12 }, (_, i) => [
      save(`p${i + 10}`, 10 + i, 100 * MB),
      save(`p${i + 10}`, 30 + i, 100 * MB),
    ]).flat()
    // 24 × 100 MB = 2400 MB > 2048 MB → delete the 4 oldest that are not a project's newest.
    expect(names(planRetention(many))).toEqual(['p10:10', 'p11:11', 'p12:12', 'p13:13'])
  })
})

describe('applyRetention', () => {
  const tmp = useTempDir()

  it('deletes planned files across project folders and ignores foreign files', async () => {
    const a = projectPaths(tmp.dir, 'a')
    await mkdir(a.saves, { recursive: true })
    const files = Array.from({ length: 21 }, (_, i) => save('a', 10 + i, 1).name)
    for (const f of files) await writeFile(join(a.saves, f), 'x')
    await writeFile(join(a.saves, 'notes.txt'), 'x')
    await mkdir(projectPaths(tmp.dir, 'b').folder, { recursive: true })
    const r = expectOk(await applyRetention({ fs: testFs, appData: tmp.dir, log: noopLogger }))
    expect(r.deleted.map((d) => d.name)).toEqual([files[0]])
    expect((await readdir(a.saves)).length).toBe(21)
  })

  it('is fine without a projects folder', async () => {
    expect(
      expectOk(await applyRetention({ fs: testFs, appData: tmp.dir, log: noopLogger })).deleted,
    ).toEqual([])
  })
})
