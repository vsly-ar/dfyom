/**
 * `Library`: the app's view of the library folder over a `LibraryStorage` port.
 * Doc: docs/architecture/library.md#storage
 *
 * Holds the loaded items in memory so queries and the snapshot check (`lookup`) are synchronous;
 * writes go through the port at once (with the optimistic `revision` check) and then update the
 * cache. Writes are serialized here, because the library is shared by all open projects.
 */
import { AppError } from '../../shared/errors/app-error'
import { fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import { LIBRARY_ITEM_KINDS, type LibraryItemKind } from './item'
import { LibraryItem, parseLibraryItem, type ItemValues } from './library-item'
import type { ItemLookup, ItemLookupResult } from './snapshot'
import type { LibraryStorage, StoredEntry } from './storage'

/** An item file that does not load: listed, never deleted or overwritten automatically. */
export interface ItemLoadError {
  readonly kind: LibraryItemKind
  readonly id: string
  readonly error: AppError
}

export interface LibraryListing {
  readonly items: readonly LibraryItem[]
  readonly errors: readonly ItemLoadError[]
}

/** Emitted after a successful write; the source of the "used item changed" notice. */
export type LibraryChange =
  | {
      readonly kind: LibraryItemKind
      readonly id: string
      readonly change: 'added' | 'updated'
      readonly revision: number
    }
  | { readonly kind: LibraryItemKind; readonly id: string; readonly change: 'removed' }

type Slot = { readonly ok: true; readonly item: LibraryItem } | ItemLoadError

export class Library {
  private readonly slots = new Map<LibraryItemKind, Map<string, Slot>>(
    LIBRARY_ITEM_KINDS.map((k) => [k, new Map()]),
  )
  private readonly listeners = new Set<(c: LibraryChange) => void>()
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(private readonly storage: LibraryStorage) {}

  /** Loads every item of every kind. Fails only if a whole folder cannot be listed. */
  static async open(storage: LibraryStorage): AsyncAppResult<Library> {
    const lib = new Library(storage)
    const loaded = await lib.reloadAll()
    return loaded.isErr() ? loaded : Ok(lib)
  }

  /** Re-reads every folder (e.g. after another app instance changed the library). */
  async reloadAll(): AsyncAppResult<void> {
    for (const kind of LIBRARY_ITEM_KINDS) {
      const entries = await this.storage.list(kind)
      if (entries.isErr()) return entries.mapErr((e) => e.withContext('Library.load', { kind }))
      const slots = new Map<string, Slot>()
      for (const e of entries.unwrap()) slots.set(e.id, toSlot(kind, e))
      this.slots.set(kind, slots)
    }
    return Ok(undefined)
  }

  list(kind: LibraryItemKind): LibraryListing {
    const items: LibraryItem[] = []
    const errors: ItemLoadError[] = []
    for (const s of this.kindSlots(kind).values()) {
      if ('ok' in s) items.push(s.item)
      else errors.push(s)
    }
    return { items, errors }
  }

  /** Synchronous lookup for queries and the snapshot check. */
  readonly lookup: ItemLookup = (kind, id): ItemLookupResult => {
    const s = this.kindSlots(kind).get(id)
    if (s === undefined) return { state: 'missing' }
    return 'ok' in s ? { state: 'found', item: s.item } : { state: 'unreadable' }
  }

  subscribe(listener: (c: LibraryChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(values: ItemValues, meta: { id: string; updatedAt: string }): AsyncAppResult<LibraryItem> {
    return this.serial(async () => {
      const item = LibraryItem.create({ ...meta, revision: 1, values })
      if (item.isErr()) return item
      const written = await this.write(item.unwrap(), null)
      if (written.isOk())
        this.emit({ kind: values.kind, id: meta.id, change: 'added', revision: 1 })
      return written
    })
  }

  /** Replaces the values of item `id`; `revision` is the one the caller read. */
  update(
    id: string,
    revision: number,
    values: ItemValues,
    updatedAt: string,
  ): AsyncAppResult<LibraryItem> {
    return this.serial(async () => {
      const kind = values.kind
      const current = await this.reload(kind, id)
      if (current.isErr()) return current
      const slot = current.unwrap()
      if (slot === undefined) return unknownItem(kind, id, 'Library.update')
      if (!('ok' in slot))
        return fail('input.malformed', `${kind} ${id} does not load; fix or remove its file`, {
          issues: [{ path: ['id'], rule: 'unreadableItem', message: 'item file does not load' }],
          where: 'Library.update',
          cause: slot.error,
        })
      const base = LibraryItem.create({ ...slot.item, revision })
      if (base.isErr()) return base
      const next = base.unwrap().next(values, updatedAt)
      if (next.isErr()) return next
      const written = await this.write(next.unwrap(), revision)
      if (written.isOk())
        this.emit({ kind, id, change: 'updated', revision: written.unwrap().revision })
      return written
    })
  }

  /** Deletes the item file; without `revision` also an unreadable one (user decision). */
  remove(kind: LibraryItemKind, id: string, revision?: number): AsyncAppResult<void> {
    return this.serial(async () => {
      const r = await this.storage.remove(kind, id, revision)
      if (r.isErr()) {
        await this.reload(kind, id)
        return r.mapErr((e) => e.withContext('Library.remove', { kind, id }))
      }
      this.kindSlots(kind).delete(id)
      this.emit({ kind, id, change: 'removed' })
      return r
    })
  }

  private async write(item: LibraryItem, expected: number | null): AsyncAppResult<LibraryItem> {
    const r = await this.storage.put(item.kind, item.toDTO(), expected)
    if (r.isErr()) {
      await this.reload(item.kind, item.id) // show the current state after a conflict
      return r.mapErr((e) => e.withContext('Library.write', { kind: item.kind, id: item.id }))
    }
    this.kindSlots(item.kind).set(item.id, { ok: true, item })
    return Ok(item)
  }

  /** Re-reads one item into the cache; `undefined` = no such file. */
  private async reload(kind: LibraryItemKind, id: string): AsyncAppResult<Slot | undefined> {
    const r = await this.storage.get(kind, id)
    if (r.isErr()) return r
    const slots = this.kindSlots(kind)
    const entry = r.unwrap()
    if (entry.isNone()) {
      slots.delete(id)
      return Ok(undefined)
    }
    const slot = toSlot(kind, entry.unwrap())
    slots.set(id, slot)
    return Ok(slot)
  }

  private kindSlots(kind: LibraryItemKind): Map<string, Slot> {
    const s = this.slots.get(kind)
    if (s === undefined) throw new Error(`unknown library kind ${kind}`) // all kinds are created
    return s
  }

  private emit(c: LibraryChange): void {
    for (const l of this.listeners) {
      try {
        l(c)
      } catch {
        // A listener bug must not undo a completed write; listeners report their own errors.
      }
    }
  }

  private serial<T>(fn: () => AsyncAppResult<T>): AsyncAppResult<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }
}

function toSlot(kind: LibraryItemKind, e: StoredEntry): Slot {
  const where = `library/${kind}/${e.id}`
  const parsed = e.content.andThen((raw) => parseLibraryItem(raw, where))
  if (parsed.isErr()) return { kind, id: e.id, error: parsed.unwrapErr() }
  const item = parsed.unwrap()
  if (item.kind !== kind || item.id !== e.id)
    return {
      kind,
      id: e.id,
      error: new AppError('input.malformed', `${where} holds ${item.kind} ${item.id}`, {
        issues: [{ path: ['id'], rule: 'fileMismatch', message: 'id/kind differ from the file' }],
        where,
      }),
    }
  return { ok: true, item }
}

function unknownItem(kind: LibraryItemKind, id: string, where: string): AppResult<never> {
  return fail('input.malformed', `${kind} ${id} does not exist`, {
    issues: [{ path: ['id'], rule: 'unknownItem', message: 'no such library item' }],
    where,
  })
}
