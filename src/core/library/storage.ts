/**
 * `LibraryStorage`: the port through which the library reads and writes item files.
 * Doc: docs/architecture/library.md#storage
 *
 * Implementations: `memory-storage.ts` (tests, headless) and `src/main/library/fs-storage.ts`
 * (one JSON file per item under `<appData>/library/`). The port moves raw JSON; parsing and
 * invariants stay in core (`parseLibraryItem`), so every implementation validates the same way.
 */
import { fail, Ok, type AppResult, type AsyncAppResult, type Option } from '../../shared/result'
import type { LibraryItemKind } from './item'
import type { LibraryItemDTO } from './library-item'

/** One stored item file: its id (file name) and parsed JSON, or why it could not be read. */
export interface StoredEntry {
  readonly id: string
  readonly content: AppResult<unknown>
}

export interface LibraryStorage {
  /** Every item file of a kind, in id order; one unreadable file does not fail the list. */
  list(kind: LibraryItemKind): AsyncAppResult<readonly StoredEntry[]>
  get(kind: LibraryItemKind, id: string): AsyncAppResult<Option<StoredEntry>>
  /**
   * Writes the item atomically if the stored revision equals `expected` (`null`: no file may
   * exist yet); otherwise `command.conflict`. A file whose revision cannot be read conflicts too,
   * so a broken file is never overwritten.
   */
  put(kind: LibraryItemKind, dto: LibraryItemDTO, expected: number | null): AsyncAppResult<void>
  /**
   * Deletes the item file; `expected` given → `command.conflict` if the stored revision differs.
   * Without it an unreadable file can be removed (user decision). Missing → `input.malformed`.
   */
  remove(kind: LibraryItemKind, id: string, expected?: number): AsyncAppResult<void>
}

/** The stored `revision`, if the content is an object with an integer revision. */
export function storedRevision(content: AppResult<unknown>): number | undefined {
  if (content.isErr()) return undefined
  const v = content.unwrap()
  if (typeof v !== 'object' || v === null) return undefined
  const r = (v as { revision?: unknown }).revision
  return typeof r === 'number' && Number.isInteger(r) ? r : undefined
}

/** Shared optimistic-concurrency check for `put` (`current` = what is stored now). */
export function checkPut(
  kind: LibraryItemKind,
  id: string,
  current: Option<StoredEntry>,
  expected: number | null,
): AppResult<void> {
  if (expected === null) {
    return current.isNone()
      ? Ok(undefined)
      : conflict(kind, id, 'already exists', { expected: null })
  }
  if (current.isNone()) return conflict(kind, id, 'was removed', { expected })
  const actual = storedRevision(current.unwrap().content)
  return actual === expected
    ? Ok(undefined)
    : conflict(kind, id, `is at revision ${actual ?? 'unreadable'}`, { expected, actual })
}

/** Shared check for `remove`. */
export function checkRemove(
  kind: LibraryItemKind,
  id: string,
  current: Option<StoredEntry>,
  expected: number | undefined,
): AppResult<void> {
  if (current.isNone())
    return fail('input.malformed', `${kind} ${id} does not exist`, {
      issues: [{ path: ['id'], rule: 'unknownItem', message: 'no such library item' }],
      where: 'LibraryStorage.remove',
    })
  const actual = storedRevision(current.unwrap().content)
  if (expected === undefined)
    // Only an item that does not load (no readable revision) may be removed without one.
    return actual === undefined
      ? Ok(undefined)
      : conflict(kind, id, `is at revision ${actual}; pass the revision you read`, { actual })
  return actual === expected
    ? Ok(undefined)
    : conflict(kind, id, `is at revision ${actual ?? 'unreadable'}`, { expected, actual })
}

function conflict(
  kind: LibraryItemKind,
  id: string,
  what: string,
  data: Record<string, unknown>,
): AppResult<never> {
  return fail('command.conflict', `${kind} ${id} ${what}; re-read the item and retry`, {
    where: 'LibraryStorage',
    data: { kind, id, ...data },
  })
}
