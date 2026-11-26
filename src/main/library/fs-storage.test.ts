import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { libraryStorageContract } from '../../core/library/storage.contract'
import { stockValues } from '../../core/library/library.fixture'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createFsLibraryStorage } from './fs-storage'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfyom-library-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

libraryStorageContract('filesystem', async () =>
  expectOk(await createFsLibraryStorage(join(dir, 'lib'))),
)

const item = (id: string, revision = 1) => ({
  id,
  revision,
  updatedAt: '2026-11-17T10:00:00.000Z',
  ...stockValues(),
})

describe('filesystem library storage', () => {
  it('creates the folders and the manifest', async () => {
    const root = join(dir, 'library')
    expectOk(await createFsLibraryStorage(root))
    expect((await readdir(root)).sort()).toEqual([
      'library.json',
      'machines',
      'stock',
      'tools',
      'workholding',
    ])
    expect(JSON.parse(await readFile(join(root, 'library.json'), 'utf8'))).toEqual({
      format: 'dfyom-library',
      schemaVersion: 1,
    })
    expectOk(await createFsLibraryStorage(root)) // opening again keeps it
  })

  it('refuses a manifest of another format or version (never resets it)', async () => {
    const root = join(dir, 'library')
    expectOk(await createFsLibraryStorage(root))
    const manifest = join(root, 'library.json')
    await writeFile(manifest, JSON.stringify({ format: 'dfyom-library', schemaVersion: 2 }))
    expectErrCode(await createFsLibraryStorage(root), 'persist.migration')
    await writeFile(manifest, '{not json')
    expectErrCode(await createFsLibraryStorage(root), 'input.malformed')
    expect(await readFile(manifest, 'utf8')).toBe('{not json')
  })

  it('writes one pretty-printed file per item, atomically (no temp files left)', async () => {
    const root = join(dir, 'library')
    const s = expectOk(await createFsLibraryStorage(root))
    expectOk(await s.put('stock', item('a'), null))
    expectOk(await s.put('tool', { ...item('t'), kind: 'tool' } as never, null))
    expect(await readdir(join(root, 'stock'))).toEqual(['a.json'])
    expect(await readdir(join(root, 'tools'))).toEqual(['t.json'])
    const text = await readFile(join(root, 'stock', 'a.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(item('a'), null, 2)}\n`)
  })

  it('lists a file that is not JSON with its error and ignores other files', async () => {
    const root = join(dir, 'library')
    const s = expectOk(await createFsLibraryStorage(root))
    expectOk(await s.put('stock', item('a'), null))
    await writeFile(join(root, 'stock', 'broken.json'), '{')
    await writeFile(join(root, 'stock', 'a.json.tmp-123'), 'partial')
    await writeFile(join(root, 'stock', 'README.txt'), 'x')
    const entries = expectOk(await s.list('stock'))
    expect(entries.map((e) => e.id)).toEqual(['a', 'broken'])
    expectErrCode(entries[1]!.content, 'input.malformed')
    // A broken file is never overwritten, but can be removed without a revision.
    expectErrCode(await s.put('stock', item('broken', 2), 1), 'command.conflict')
    expectOk(await s.remove('stock', 'broken'))
  })

  it('rejects ids that are not safe file names', async () => {
    const s = expectOk(await createFsLibraryStorage(join(dir, 'library')))
    expectErrCode(await s.get('stock', '../library'), 'input.malformed')
    expectErrCode(await s.put('stock', item('../x'), null), 'input.malformed')
    expectErrCode(await s.remove('stock', 'a/b'), 'input.malformed')
  })

  it('rejects wrong-case ids, so a case-insensitive disk cannot alias another item', async () => {
    const root = join(dir, 'library')
    const s = expectOk(await createFsLibraryStorage(root))
    expectOk(await s.put('stock', item('tool-1'), null))
    expectErrCode(await s.get('stock', 'TOOL-1'), 'input.malformed')
    expectErrCode(await s.put('stock', item('TOOL-1', 2), 1), 'input.malformed')
    expectErrCode(await s.remove('stock', 'TOOL-1', 1), 'input.malformed')
    expect(await readdir(join(root, 'stock'))).toEqual(['tool-1.json'])
  })

  it('a write waits for the per-item lock and fails with command.conflict while it is held', async () => {
    const root = join(dir, 'library')
    const s = expectOk(
      await createFsLibraryStorage(root, { lockRetries: 3, lockRetryMs: 1, staleLockMs: 60_000 }),
    )
    expectOk(await s.put('stock', item('a'), null))
    await writeFile(join(root, 'stock', 'a.json.lock'), 'other instance')
    expectErrCode(await s.put('stock', item('a', 2), 1), 'command.conflict')
    expectErrCode(await s.remove('stock', 'a', 1), 'command.conflict')
    expect(await readFile(join(root, 'stock', 'a.json.lock'), 'utf8')).toBe('other instance')
  })

  it('a stale lock (crashed instance) is broken', async () => {
    const root = join(dir, 'library')
    const s = expectOk(await createFsLibraryStorage(root, { lockRetryMs: 1, staleLockMs: 1000 }))
    expectOk(await s.put('stock', item('a'), null))
    const lock = join(root, 'stock', 'a.json.lock')
    await writeFile(lock, 'crashed')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    expectOk(await s.put('stock', item('a', 2), 1))
    expect(await readdir(join(root, 'stock'))).toEqual(['a.json'])
  })

  it('two instances writing the same revision: exactly one wins', async () => {
    const root = join(dir, 'library')
    const a = expectOk(await createFsLibraryStorage(root, { lockRetryMs: 1 }))
    const b = expectOk(await createFsLibraryStorage(root, { lockRetryMs: 1 }))
    expectOk(await a.put('stock', item('x'), null))
    const rs = await Promise.all([
      a.put('stock', { ...item('x', 2), name: 'A' }, 1),
      b.put('stock', { ...item('x', 2), name: 'B' }, 1),
    ])
    expect(rs.filter((r) => r.isOk())).toHaveLength(1)
    expect(await readdir(join(root, 'stock'))).toEqual(['x.json'])
  })

  it('a library from before WL1 gains workholding/ on open; a missing kind folder lists no items', async () => {
    const root = join(dir, 'library')
    const s = expectOk(await createFsLibraryStorage(root))
    await rm(join(root, 'workholding'), { recursive: true })
    expect(expectOk(await s.list('workholding'))).toEqual([])
    expectOk(await createFsLibraryStorage(root))
    expect(await readdir(join(root, 'workholding'))).toEqual([])
  })

  it('opening sweeps stale temp and lock files, keeping fresh ones', async () => {
    const root = join(dir, 'library')
    expectOk(await createFsLibraryStorage(root))
    const old = new Date(Date.now() - 60 * 60_000)
    const files = {
      oldTmp: join(root, 'tools', 't.json.tmp-0f8e2a4c-1b2d-4e6f-8a9b-0c1d2e3f4a5b'),
      oldManifestTmp: join(root, 'library.json.tmp-0f8e2a4c-1b2d-4e6f-8a9b-0c1d2e3f4a5c'),
      oldLock: join(root, 'stock', 'a.json.lock'),
      freshTmp: join(root, 'tools', 'u.json.tmp-0f8e2a4c-1b2d-4e6f-8a9b-0c1d2e3f4a5d'),
    }
    for (const f of Object.values(files)) await writeFile(f, 'x')
    for (const f of [files.oldTmp, files.oldManifestTmp, files.oldLock]) await utimes(f, old, old)
    expectOk(await createFsLibraryStorage(root))
    expect((await readdir(join(root, 'tools'))).sort()).toEqual([
      'u.json.tmp-0f8e2a4c-1b2d-4e6f-8a9b-0c1d2e3f4a5d',
    ])
    expect(await readdir(join(root, 'stock'))).toEqual([])
    expect((await readdir(root)).sort()).toEqual([
      'library.json',
      'machines',
      'stock',
      'tools',
      'workholding',
    ])
  })
})
