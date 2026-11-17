import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { parseLibraryItem, type LibraryItem } from './library-item'
import { flatEndMillValues, len, stockValues } from './library.fixture'
import {
  parseSnapshot,
  refreshSnapshot,
  snapshotStatus,
  takeSnapshot,
  usedItemNotices,
  type ItemLookup,
} from './snapshot'

const T0 = '2026-11-17T10:00:00.000Z'
const T1 = '2026-11-18T10:00:00.000Z'

const item = (values: object = stockValues(), revision = 1): LibraryItem =>
  expectOk(parseLibraryItem({ id: 'stock-1', revision, updatedAt: T0, ...values }, 'test'))

const found =
  (i: LibraryItem): ItemLookup =>
  () => ({ state: 'found', item: i })

describe('snapshot', () => {
  it('copies the values without library meta', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T1))
    expect(s.toDTO()).toEqual({
      id: 'snap-1',
      kind: 'stock',
      libraryItemId: 'stock-1',
      takenAt: T1,
      values: stockValues(),
    })
  })

  it('round-trips through its DTO and rejects a kind that differs from the values', () => {
    const dto = expectOk(takeSnapshot(item(), 'snap-1', T1)).toDTO()
    expect(expectOk(parseSnapshot(dto, 't')).toDTO()).toEqual(dto)
    expectErrCode(parseSnapshot({ ...dto, kind: 'tool' }, 't'), 'input.malformed')
    expectErrCode(parseSnapshot({ ...dto, id: '' }, 't'), 'input.malformed')
  })

  it('values are validated with the same model rules', () => {
    const dto = expectOk(takeSnapshot(item(), 'snap-1', T1)).toDTO()
    const bad = { ...dto, values: { ...dto.values, length: len('0') } }
    const e = expectErrCode(parseSnapshot(bad, 't'), 'model.invariant')
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['values.length'])
  })

  it('status: current while values are equal, even after a write with the same values', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T1))
    expect(snapshotStatus(s, found(item(stockValues(), 5)))).toBe('current')
  })

  it('status: libraryChanged on any value difference (deep compare)', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T1))
    const notes = item({ ...stockValues(), notes: 'moved' })
    const nested = item({ ...stockValues(), material: { name: '6061-T6', class: 'other' } })
    expect(snapshotStatus(s, found(notes))).toBe('libraryChanged')
    expect(snapshotStatus(s, found(nested))).toBe('libraryChanged')
  })

  it('status: libraryRemoved / libraryUnreadable', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T1))
    expect(snapshotStatus(s, () => ({ state: 'missing' }))).toBe('libraryRemoved')
    expect(snapshotStatus(s, () => ({ state: 'unreadable' }))).toBe('libraryUnreadable')
  })

  it('refresh replaces values and time, keeps the snapshot id', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T0))
    const changed = item({ ...stockValues(), name: 'Renamed' }, 2)
    const r = expectOk(refreshSnapshot(s, changed, T1))
    expect([r.id, r.takenAt, r.values.name]).toEqual(['snap-1', T1, 'Renamed'])
    expect(snapshotStatus(r, found(changed))).toBe('current')
  })

  it('refresh rejects an item of another library entry', () => {
    const s = expectOk(takeSnapshot(item(), 'snap-1', T0))
    const tool = expectOk(
      parseLibraryItem({ id: 'tool-1', revision: 1, updatedAt: T0, ...flatEndMillValues() }, 't'),
    )
    expectErrCode(refreshSnapshot(s, tool, T1), 'internal.unexpected')
  })

  it('usedItemNotices lists only snapshots whose library item changed or went away', () => {
    const a = expectOk(takeSnapshot(item(), 'snap-a', T0))
    const b = expectOk(takeSnapshot(item(), 'snap-b', T0))
    const lookupB = found(item({ ...stockValues(), name: 'Renamed' }, 2))
    const notices = usedItemNotices([a, b], (kind, id) =>
      id === 'stock-1' && kind === 'stock' ? lookupB(kind, id) : { state: 'missing' },
    )
    expect(notices).toEqual([
      { snapshotId: 'snap-a', kind: 'stock', libraryItemId: 'stock-1', status: 'libraryChanged' },
      { snapshotId: 'snap-b', kind: 'stock', libraryItemId: 'stock-1', status: 'libraryChanged' },
    ])
    expect(usedItemNotices([a], found(item()))).toEqual([])
  })
})
