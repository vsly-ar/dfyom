// Contract tests every LibraryStorage implementation must pass. Test-only.
// Doc: docs/architecture/library.md#storage
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { stockValues } from './library.fixture'
import type { LibraryStorage } from './storage'

const T = '2026-11-17T10:00:00.000Z'
const dto = (id: string, revision: number, name = 'Plate') => ({
  id,
  revision,
  updatedAt: T,
  ...stockValues(),
  name,
})

/** `make` returns a fresh, empty storage per test. */
export function libraryStorageContract(
  label: string,
  make: () => Promise<LibraryStorage> | LibraryStorage,
): void {
  describe(`LibraryStorage contract: ${label}`, () => {
    it('starts empty and stores items per kind', async () => {
      const s = await make()
      expect(expectOk(await s.list('stock'))).toEqual([])
      expectOk(await s.put('stock', dto('a', 1), null))
      const listed = expectOk(await s.list('stock'))
      expect(listed.map((e) => [e.id, expectOk(e.content)])).toEqual([['a', dto('a', 1)]])
      expect(expectOk(await s.list('tool'))).toEqual([])
      const got = expectOk(await s.get('stock', 'a'))
      expect(expectOk(got.unwrap().content)).toEqual(dto('a', 1))
      expect(expectOk(await s.get('stock', 'b')).isNone()).toBe(true)
    })

    it('put checks the stored revision (null = must not exist)', async () => {
      const s = await make()
      expectOk(await s.put('stock', dto('a', 1), null))
      expectErrCode(await s.put('stock', dto('a', 1), null), 'command.conflict')
      expectErrCode(await s.put('stock', dto('a', 3), 2), 'command.conflict')
      expectErrCode(await s.put('stock', dto('b', 2), 1), 'command.conflict')
      expectOk(await s.put('stock', dto('a', 2, 'New'), 1))
      const got = expectOk(await s.get('stock', 'a')).unwrap()
      expect(expectOk(got.content)).toEqual(dto('a', 2, 'New'))
    })

    it('stored values are copies, not shared references', async () => {
      const s = await make()
      const d = dto('a', 1)
      expectOk(await s.put('stock', d, null))
      d.name = 'mutated'
      const got = expectOk(await s.get('stock', 'a')).unwrap()
      expect((expectOk(got.content) as { name: string }).name).toBe('Plate')
    })

    it('remove checks the revision when given', async () => {
      const s = await make()
      expectOk(await s.put('stock', dto('a', 1), null))
      expectErrCode(await s.remove('stock', 'a', 2), 'command.conflict')
      expectOk(await s.remove('stock', 'a', 1))
      expect(expectOk(await s.list('stock'))).toEqual([])
      expectErrCode(await s.remove('stock', 'a'), 'input.malformed')
      expectOk(await s.put('stock', dto('b', 1), null))
      expectOk(await s.remove('stock', 'b'))
    })
  })
}
