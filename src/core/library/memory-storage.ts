/**
 * In-memory `LibraryStorage` for tests and headless use. Stores JSON copies, like files.
 * Doc: docs/architecture/library.md#storage
 */
import { None, Ok, Some, type AsyncAppResult, type Option } from '../../shared/result'
import type { LibraryItemKind } from './item'
import type { LibraryItemDTO } from './library-item'
import { checkPut, checkRemove, type LibraryStorage, type StoredEntry } from './storage'

export interface SeedFile {
  readonly kind: LibraryItemKind
  readonly id: string
  /** Raw JSON content; need not be a valid item. */
  readonly content: unknown
}

const copy = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown

export function createMemoryLibraryStorage(seed: readonly SeedFile[] = []): LibraryStorage {
  const files = new Map<string, unknown>()
  const key = (kind: LibraryItemKind, id: string) => `${kind}/${id}`
  for (const f of seed) files.set(key(f.kind, f.id), copy(f.content))

  const entry = (kind: LibraryItemKind, id: string): Option<StoredEntry> => {
    const k = key(kind, id)
    return files.has(k) ? Some({ id, content: Ok(copy(files.get(k))) }) : None
  }

  return {
    async list(kind) {
      const prefix = `${kind}/`
      const ids = [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort()
      return Ok(ids.map((id) => entry(kind, id).unwrap()))
    },
    async get(kind, id) {
      return Ok(entry(kind, id))
    },
    async put(kind, dto: LibraryItemDTO, expected): AsyncAppResult<void> {
      const ok = checkPut(kind, dto.id, entry(kind, dto.id), expected)
      if (ok.isOk()) files.set(key(kind, dto.id), copy(dto))
      return ok
    },
    async remove(kind, id, expected) {
      const ok = checkRemove(kind, id, entry(kind, id), expected)
      if (ok.isOk()) files.delete(key(kind, id))
      return ok
    },
  }
}
