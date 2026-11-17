import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    expect((await readdir(root)).sort()).toEqual(['library.json', 'machines', 'stock', 'tools'])
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
})
