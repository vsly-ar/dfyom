/**
 * Snapshot: a project's copy of a library item's values. Parts and plans reference snapshots,
 * never library items; loading a project never reads the library.
 * Docs: docs/architecture/library.md#snapshots, docs/architecture/persistence.md#library-references
 *
 * Commands that take or update snapshots are project document commands (design/plan tasks);
 * this file holds the pure functions they call, and the "used item changed" check.
 */
import { z } from 'zod'
import { construct, invariants } from '../../shared/model'
import { parseWith } from '../../shared/parse'
import { fail, type AppResult } from '../../shared/result'
import { ItemIdSchema, type LibraryItemKind } from './item'
import { LibraryItem, valuesFromDTO, VALUES_SCHEMAS, type ItemValues } from './library-item'

const snapshotOf = <K extends LibraryItemKind>(kind: K) =>
  z.object({
    id: z.string().min(1).describe('Snapshot id (referenced by parts and plans)'),
    kind: z.literal(kind),
    libraryItemId: ItemIdSchema.optional().describe(
      "The library item the values were copied from; none for a part's own stock",
    ),
    takenAt: z.iso.datetime({ offset: true }).describe('When the values were copied'),
    values: VALUES_SCHEMAS[kind],
  })

export const SnapshotDtoSchema = z.discriminatedUnion('kind', [
  snapshotOf('stock'),
  snapshotOf('tool'),
  snapshotOf('machine'),
])
export type SnapshotDTO = z.output<typeof SnapshotDtoSchema>

export interface SnapshotProps {
  readonly id: string
  /** None: the project's own values, not from the library (a part's own stock, DF13). */
  readonly libraryItemId: string | undefined
  readonly takenAt: string
  readonly values: ItemValues
}

export class Snapshot implements SnapshotProps {
  private constructor(
    readonly id: string,
    readonly libraryItemId: string | undefined,
    readonly takenAt: string,
    readonly values: ItemValues,
  ) {
    invariants('Snapshot', (c) => {
      c.check(id.length > 0, ['id'], 'nonEmpty', 'must not be empty')
      c.check(
        libraryItemId === undefined || libraryItemId.length > 0,
        ['libraryItemId'],
        'nonEmpty',
        'must not be empty',
      )
      c.check(!Number.isNaN(Date.parse(takenAt)), ['takenAt'], 'isoDate', 'must be an ISO time')
    })
    Object.freeze(this)
  }

  static create(p: SnapshotProps): AppResult<Snapshot> {
    return construct('Snapshot', () => new Snapshot(p.id, p.libraryItemId, p.takenAt, p.values))
  }

  static fromDTO(dto: SnapshotDTO): AppResult<Snapshot> {
    return valuesFromDTO(dto.values)
      .mapErr((e) => e.prefixIssues('values'))
      .andThen((values) =>
        Snapshot.create({
          id: dto.id,
          libraryItemId: dto.libraryItemId,
          takenAt: dto.takenAt,
          values,
        }),
      )
  }

  /** `kind` is the values' kind, so it cannot disagree with them. */
  get kind(): LibraryItemKind {
    return this.values.kind
  }

  toDTO(): SnapshotDTO {
    return {
      id: this.id,
      kind: this.kind,
      ...(this.libraryItemId === undefined ? {} : { libraryItemId: this.libraryItemId }),
      takenAt: this.takenAt,
      values: this.values.toDTO(),
    } as SnapshotDTO
  }
}

/** Shape check + model of an untrusted snapshot (project files, command args). */
export function parseSnapshot(raw: unknown, where: string): AppResult<Snapshot> {
  return parseWith(SnapshotDtoSchema, raw, where).andThen(Snapshot.fromDTO)
}

/** The project's own values in a new snapshot, linked to no library item (DF13). */
export function ownSnapshot(values: ItemValues, id: string, takenAt: string): AppResult<Snapshot> {
  return Snapshot.create({ id, libraryItemId: undefined, takenAt, values })
}

/** Copy an item's values into a new snapshot. */
export function takeSnapshot(item: LibraryItem, id: string, takenAt: string): AppResult<Snapshot> {
  return Snapshot.create({ id, libraryItemId: item.id, takenAt, values: item.values })
}

/**
 * "Update from library": the same snapshot (id kept, so references stay valid) with the item's
 * current values and a new `takenAt`.
 */
export function refreshSnapshot(
  snapshot: Snapshot,
  item: LibraryItem,
  takenAt: string,
): AppResult<Snapshot> {
  if (item.id !== snapshot.libraryItemId || item.kind !== snapshot.kind)
    return fail('internal.unexpected', 'snapshot refreshed from another library item', {
      where: 'refreshSnapshot',
      data: { snapshotId: snapshot.id, libraryItemId: snapshot.libraryItemId, itemId: item.id },
    })
  return Snapshot.create({ ...snapshot, takenAt, values: item.values })
}

/** What the library currently holds for an id (an unreadable file is listed with its error). */
export type ItemLookupResult =
  | { readonly state: 'found'; readonly item: LibraryItem }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' }

export type ItemLookup = (kind: LibraryItemKind, id: string) => ItemLookupResult

/**
 * Derived, never stored. `libraryUnreadable`: the item file exists but does not load, so no
 * comparison is possible.
 */
export type SnapshotStatus = 'current' | 'libraryChanged' | 'libraryRemoved' | 'libraryUnreadable'

export function snapshotStatus(snapshot: Snapshot, lookup: ItemLookup): SnapshotStatus {
  // the project's own values follow no library item (DF13)
  if (snapshot.libraryItemId === undefined) return 'current'
  const r = lookup(snapshot.kind, snapshot.libraryItemId)
  if (r.state === 'missing') return 'libraryRemoved'
  if (r.state === 'unreadable') return 'libraryUnreadable'
  return deepEqual(snapshot.values.toDTO(), r.item.values.toDTO()) ? 'current' : 'libraryChanged'
}

/** The "used item changed" notice as data: one entry per snapshot whose item is not current. */
export interface LibraryChangeNotice {
  readonly snapshotId: string
  readonly kind: LibraryItemKind
  readonly libraryItemId: string
  readonly status: Exclude<SnapshotStatus, 'current'>
}

export function usedItemNotices(
  snapshots: readonly Snapshot[],
  lookup: ItemLookup,
): LibraryChangeNotice[] {
  const notices: LibraryChangeNotice[] = []
  for (const s of snapshots) {
    const status = snapshotStatus(s, lookup)
    if (status !== 'current' && s.libraryItemId !== undefined)
      notices.push({ snapshotId: s.id, kind: s.kind, libraryItemId: s.libraryItemId, status })
  }
  return notices
}

/** Structural equality of JSON values (key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]))
}
