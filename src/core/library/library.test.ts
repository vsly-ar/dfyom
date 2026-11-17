import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error'
import { Err, Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Library, type LibraryChange } from './library'
import { parseValues } from './library-item'
import { flatEndMillValues, stockValues } from './library.fixture'
import { createMemoryLibraryStorage, type SeedFile } from './memory-storage'
import type { LibraryStorage } from './storage'

const T0 = '2026-11-17T10:00:00.000Z'
const T1 = '2026-11-18T10:00:00.000Z'
const stored = (id: string, revision = 1, values: object = stockValues()) => ({
  id,
  revision,
  updatedAt: T0,
  ...values,
})
const values = (raw: object) => expectOk(parseValues(raw, 'test'))

async function open(seed: SeedFile[] = [], storage = createMemoryLibraryStorage(seed)) {
  return { lib: expectOk(await Library.open(storage)), storage }
}

describe('Library', () => {
  it('loads every item, listing files that do not load with their error', async () => {
    const { lib } = await open([
      { kind: 'stock', id: 'a', content: stored('a') },
      { kind: 'stock', id: 'bad', content: stored('bad', 1, { ...stockValues(), shape: 'tube' }) },
      { kind: 'stock', id: 'other', content: stored('mismatch') },
      { kind: 'stock', id: 'tool', content: stored('tool', 1, flatEndMillValues()) },
    ])
    const l = lib.list('stock')
    expect(l.items.map((i) => i.id)).toEqual(['a'])
    expect(l.errors.map((e) => [e.id, e.error.code])).toEqual([
      ['bad', 'input.malformed'],
      ['other', 'input.malformed'],
      ['tool', 'input.malformed'],
    ])
    expect(lib.lookup('stock', 'a').state).toBe('found')
    expect(lib.lookup('stock', 'bad').state).toBe('unreadable')
    expect(lib.lookup('stock', 'zzz').state).toBe('missing')
    expect(lib.list('tool')).toEqual({ items: [], errors: [] })
  })

  it('a file that cannot be read is listed with its error; a failing folder fails open', async () => {
    const read = new AppError('persist.io', 'unreadable')
    const listed = expectOk(
      await Library.open({
        ...createMemoryLibraryStorage(),
        list: async (kind) => Ok(kind === 'tool' ? [{ id: 't', content: Err(read) }] : []),
      }),
    )
    expect(listed.list('tool').errors).toEqual([{ kind: 'tool', id: 't', error: read }])
    expect(listed.lookup('tool', 't').state).toBe('unreadable')

    const base = createMemoryLibraryStorage()
    const storage: LibraryStorage = {
      ...base,
      list: async (kind) =>
        kind === 'tool' ? Err(new AppError('persist.io', 'disk gone')) : base.list(kind),
    }
    expectErrCode(await Library.open(storage), 'persist.io')
  })

  it('add writes revision 1 and notifies', async () => {
    const { lib, storage } = await open()
    const changes: LibraryChange[] = []
    lib.subscribe((c) => changes.push(c))
    const item = expectOk(await lib.add(values(stockValues()), { id: 'stock-1', updatedAt: T1 }))
    expect([item.id, item.revision, item.updatedAt]).toEqual(['stock-1', 1, T1])
    expect(expectOk((await storage.get('stock', 'stock-1')).unwrap().unwrap().content)).toEqual(
      item.toDTO(),
    )
    expect(lib.list('stock').items).toEqual([item])
    expect(changes).toEqual([{ kind: 'stock', id: 'stock-1', change: 'added', revision: 1 }])
  })

  it('update bumps the revision; a stale revision is command.conflict and reloads the item', async () => {
    const { lib, storage } = await open([{ kind: 'stock', id: 'a', content: stored('a') }])
    const renamed = values({ ...stockValues(), name: 'Renamed' })
    const u = expectOk(await lib.update('a', 1, renamed, T1))
    expect([u.revision, u.values.name, u.updatedAt]).toEqual([2, 'Renamed', T1])
    expectErrCode(await lib.update('a', 1, renamed, T1), 'command.conflict')

    // Another app instance writes revision 3 behind our back.
    expectOk(await storage.put('stock', { ...stored('a', 3), name: 'Elsewhere' } as never, 2))
    expectErrCode(await lib.update('a', 2, renamed, T1), 'command.conflict')
    const now = lib.lookup('stock', 'a')
    expect(now.state === 'found' && [now.item.revision, now.item.values.name]).toEqual([
      3,
      'Elsewhere',
    ])
  })

  it('update of an unknown item fails without writing', async () => {
    const { lib, storage } = await open()
    expectErrCode(await lib.update('nope', 1, values(stockValues()), T1), 'input.malformed')
    expect(expectOk(await storage.list('stock'))).toEqual([])
  })

  it('remove deletes the file and notifies; a stale revision conflicts', async () => {
    const { lib } = await open([{ kind: 'stock', id: 'a', content: stored('a', 2) }])
    const changes: LibraryChange[] = []
    lib.subscribe((c) => changes.push(c))
    expectErrCode(await lib.remove('stock', 'a', 1), 'command.conflict')
    expectOk(await lib.remove('stock', 'a', 2))
    expect(lib.lookup('stock', 'a').state).toBe('missing')
    expect(changes).toEqual([{ kind: 'stock', id: 'a', change: 'removed' }])
  })

  it('an unreadable item can be removed without a revision, never overwritten', async () => {
    const { lib } = await open([{ kind: 'stock', id: 'bad', content: { nonsense: true } }])
    expectErrCode(await lib.update('bad', 1, values(stockValues()), T1), 'input.malformed')
    expectOk(await lib.remove('stock', 'bad'))
    expect(lib.list('stock').errors).toEqual([])
  })

  it('serializes writes: concurrent adds of the same id → exactly one wins', async () => {
    const { lib } = await open()
    const v = values(stockValues())
    const rs = await Promise.all([
      lib.add(v, { id: 'x', updatedAt: T1 }),
      lib.add(v, { id: 'x', updatedAt: T1 }),
    ])
    expect(rs.map((r) => r.isOk())).toEqual([true, false])
  })

  it('a throwing listener does not break the write', async () => {
    const { lib } = await open()
    lib.subscribe(() => {
      throw new Error('listener bug')
    })
    expectOk(await lib.add(values(stockValues()), { id: 'x', updatedAt: T1 }))
  })
})
