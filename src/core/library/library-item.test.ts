import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { LibraryItem, parseLibraryItem } from './library-item'
import { len, machineValues, stockValues } from './library.fixture'

const meta = { id: 'stock-1', revision: 3, updatedAt: '2026-11-17T10:00:00.000Z' }

describe('LibraryItem', () => {
  it('parses a stored file: meta + values of the item kind', () => {
    const item = expectOk(parseLibraryItem({ ...meta, ...stockValues() }, 'test'))
    expect(item.kind).toBe('stock')
    expect(item.revision).toBe(3)
    expect(item.values.name).toBe('Alu plate 6061')
    expect(item.toDTO()).toEqual({ ...meta, ...stockValues() })
  })

  it('writes meta first, then the values in model order (stable key order)', () => {
    const item = expectOk(parseLibraryItem({ ...stockValues(), ...meta }, 'test'))
    expect(Object.keys(item.toDTO()).slice(0, 5)).toEqual([
      'id',
      'revision',
      'updatedAt',
      'kind',
      'name',
    ])
  })

  it('rejects malformed meta and values of another shape', () => {
    const e = expectErrCode(
      parseLibraryItem({ ...meta, id: '../evil', revision: 0, ...stockValues() }, 't'),
      'input.malformed',
    )
    expect(e.issues.map((i) => i.path.join('.')).sort()).toEqual(['id', 'revision'])
    expectErrCode(
      parseLibraryItem({ ...meta, ...stockValues(), kind: 'tool' }, 't'),
      'input.malformed',
    )
    expectErrCode(parseLibraryItem({ ...meta, kind: 'workholding' }, 't'), 'input.malformed')
  })

  it('reports value invariants with their field paths', () => {
    const e = expectErrCode(
      parseLibraryItem({ ...meta, ...stockValues(), width: len('0') }, 't'),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['width'])
  })

  it('next() bumps the revision and stamps the time, keeping the id', () => {
    const item = expectOk(parseLibraryItem({ ...meta, ...machineValues() }, 't'))
    const next = expectOk(item.next(item.values, '2026-11-18T00:00:00.000Z'))
    expect([next.id, next.revision, next.updatedAt]).toEqual([
      'stock-1',
      4,
      '2026-11-18T00:00:00.000Z',
    ])
    expectErrCode(
      LibraryItem.create({ ...meta, revision: 1.5, values: item.values }),
      'model.invariant',
    )
  })
})
