/**
 * Memos keyed by frozen document records (hardening P5): a committed document is frozen once and
 * shared, and a command's draft hands out its unmodified records as those same frozen objects, so
 * a pure function of a record needs to run once per record, not once per command. Records that
 * are not frozen (a draft's modified or new ones) are computed each time.
 * Doc: docs/architecture/shapes.md#design-commands-p5
 */
import { current, isDraft, type Draft } from 'immer'
import type { AppResult } from '../../shared/result'
import { Snapshot, type SnapshotDTO } from '../library/snapshot'

/**
 * The record as a plain object: a draft's unmodified record is its frozen base (no proxies), a
 * modified one a copy whose unmodified children are their frozen bases (Immer `current`).
 */
export function baseOf<T>(x: T): T {
  return isDraft(x) ? (current(x as Draft<T>) as T) : x
}

/** Is `x` an object frozen by a committed document (cacheable by identity)? */
export const isFrozenRecord = (x: unknown): x is object =>
  typeof x === 'object' && x !== null && Object.isFrozen(x)

/** `fn` cached per frozen record (by identity, weakly); other records are computed each time. */
export function memoByRecord<K extends object, V>(fn: (record: K) => V): (record: K) => V {
  const cache = new WeakMap<K, V>()
  return (record) => {
    const base = baseOf(record)
    if (!isFrozenRecord(base)) return fn(base)
    if (cache.has(base)) return cache.get(base)!
    const v = fn(base)
    cache.set(base, v)
    return v
  }
}

/** `Snapshot.fromDTO` per frozen snapshot record (the part's stock, every operation's tool). */
export const snapshotFromRecord: (dto: SnapshotDTO) => AppResult<Snapshot> = memoByRecord(
  (dto: SnapshotDTO) => Snapshot.fromDTO(dto),
)
