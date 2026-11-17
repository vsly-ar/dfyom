import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createMemoryLibraryStorage } from './memory-storage'
import { libraryStorageContract } from './storage.contract'

libraryStorageContract('in-memory', () => createMemoryLibraryStorage())

describe('in-memory storage', () => {
  it('can be seeded with raw (even broken) files, for tests', async () => {
    const s = createMemoryLibraryStorage([
      { kind: 'tool', id: 'broken', content: { revision: 'x' } },
    ])
    const [entry] = expectOk(await s.list('tool'))
    expect(expectOk(entry!.content)).toEqual({ revision: 'x' })
    // A file whose revision cannot be read is never overwritten.
    expectErrCode(
      await s.put('tool', { id: 'broken', revision: 1 } as never, 0),
      'command.conflict',
    )
  })
})
