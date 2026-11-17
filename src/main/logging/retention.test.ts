import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupLogs, isOwnLogFile, type RetentionFs } from './retention'
import { ID, useTempDir } from './test-support'

const tmp = useTempDir()
const day = 24 * 60 * 60 * 1000
const now = Date.parse('2026-11-16T00:00:00Z')
let seq = 0
/** A file name in DFYOM's own pattern. */
const own = (): string => `2026-11-0${(seq++ % 9) + 1}T00-00-00Z-${ID}.${seq}.log`
const make = async (name: string, ageMs: number, size: number): Promise<string> => {
  const p = join(tmp.dir, name)
  await writeFile(p, Buffer.alloc(size))
  const t = new Date(now - ageMs)
  await utimes(p, t, t)
  return p
}
const base = (p: string): string => p.slice(tmp.dir.length + 1)

describe('isOwnLogFile', () => {
  it('matches only <startedAt>-<uuid>.<n>.log', () => {
    expect(isOwnLogFile(`2026-11-16T10-20-30Z-${ID}.12.log`)).toBe(true)
    expect(isOwnLogFile('other-app.log')).toBe(false)
    expect(isOwnLogFile(`2026-11-16T10-20-30Z-${ID}.log`)).toBe(false)
    expect(isOwnLogFile('2026-11-16T10-20-30Z-not-a-uuid.1.log')).toBe(false)
  })
})

describe('cleanupLogs', () => {
  it('deletes own files older than 14 days, then oldest first down to the size cap', async () => {
    const a = own()
    const b = own()
    const c = own()
    await make(a, 20 * day, 10)
    await make(b, 5 * day, 100)
    await make(c, 3 * day, 100)
    const active = await make(own(), 2 * day, 100)
    const r = await cleanupLogs({ dir: tmp.dir, now, maxTotalBytes: 150, keep: [active] })
    expect(r.deleted.map(base)).toEqual([a, b, c])
    expect(await readdir(tmp.dir)).toEqual([base(active)])
  })

  it('leaves foreign files alone and keeps them out of the size count', async () => {
    await make('other-app.log', 30 * day, 1_000)
    await make('2026-11-01T00-00-00Z-not-a-uuid.1.log', 30 * day, 10)
    await make(own(), day, 100)
    const r = await cleanupLogs({ dir: tmp.dir, now, maxTotalBytes: 150 })
    expect(r.deleted).toEqual([])
    expect(await readdir(tmp.dir)).toHaveLength(3)
  })

  it('skips symlinks and non-regular entries', async () => {
    const target = await make('target.txt', 30 * day, 10)
    await symlink(target, join(tmp.dir, own()))
    await mkdir(join(tmp.dir, own()))
    const r = await cleanupLogs({ dir: tmp.dir, now, maxAgeMs: 0, maxTotalBytes: 0, minAgeMs: 0 })
    expect(r.deleted).toEqual([])
    expect(await readdir(tmp.dir)).toHaveLength(3)
    expect(await readFile(target)).toHaveLength(10)
  })

  it('never deletes files modified within minAgeMs (another instance writing)', async () => {
    const fresh = await make(own(), 60_000, 500)
    const r = await cleanupLogs({ dir: tmp.dir, now, maxTotalBytes: 0 })
    expect(r.deleted).toEqual([])
    expect(await readdir(tmp.dir)).toEqual([base(fresh)])
  })

  it('never deletes kept files and reports unlink failures', async () => {
    const kept = await make(own(), 30 * day, 10)
    const locked = await make(own(), 30 * day, 10)
    const fs: RetentionFs = {
      readdir: (d) => readdir(d),
      lstat: (p) => lstat(p),
      unlink: async () => {
        throw new Error('EBUSY')
      },
    }
    const r = await cleanupLogs({ dir: tmp.dir, now, keep: [kept], fs })
    expect(r.deleted).toEqual([])
    expect(r.failed).toEqual([{ file: locked, error: 'Error: EBUSY' }])
  })

  it('reports a missing folder instead of throwing', async () => {
    const r = await cleanupLogs({ dir: join(tmp.dir, 'nope'), now })
    expect(r.failed).toHaveLength(1)
  })
})
