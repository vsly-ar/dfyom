// Contract tests every LibraryStorage implementation must pass. Test-only.
// Doc: docs/architecture/library.md#storage
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { presetHolderDTO } from './holder'
import { machineValues, stockValues, toeClampValues } from './library.fixture'
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

    it('keeps workholding items in their own kind (workholding-library.md#snapshots-and-persistence)', async () => {
      const s = await make()
      expect(expectOk(await s.list('workholding'))).toEqual([])
      const clamp = { id: 'a', revision: 1, updatedAt: T, ...toeClampValues() }
      expectOk(await s.put('workholding', clamp, null))
      expectOk(await s.put('stock', dto('a', 1), null)) // same id, other kind: another file
      const listed = expectOk(await s.list('workholding'))
      expect(listed.map((e) => [e.id, expectOk(e.content)])).toEqual([['a', clamp]])
      expectErrCode(await s.put('workholding', { ...clamp, revision: 2 }, 2), 'command.conflict')
      expectOk(await s.put('workholding', { ...clamp, revision: 2, name: 'Strap' }, 1))
      expectOk(await s.remove('workholding', 'a', 2))
      expect(expectOk(await s.list('workholding'))).toEqual([])
      expect(expectOk(await s.list('stock')).map((e) => e.id)).toEqual(['a'])
    })

    it('keeps the optional holder of a machine as stored (tool-holder.md#model, DF132 H1)', async () => {
      const s = await make()
      const holder = { ...presetHolderDTO('er11'), nutDiameter: presetHolderDTO('er16').nutLength }
      const machine = { id: 'm', revision: 1, updatedAt: T, ...machineValues(), holder }
      expectOk(await s.put('machine', machine, null))
      const got = expectOk(await s.get('machine', 'm')).unwrap()
      expect(expectOk(got.content)).toEqual(machine)
      // removing the holder is a plain update without the field
      const { holder: _h, ...without } = machine
      expectOk(await s.put('machine', { ...without, revision: 2 }, 1))
      const again = expectOk(await s.get('machine', 'm')).unwrap()
      expect(expectOk(again.content)).not.toHaveProperty('holder')
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
      // Without a revision only an item whose revision cannot be read may be removed.
      expectOk(await s.put('stock', dto('b', 1), null))
      expectErrCode(await s.remove('stock', 'b'), 'command.conflict')
      expect(expectOk(await s.list('stock')).map((e) => e.id)).toEqual(['b'])
    })
  })
}
