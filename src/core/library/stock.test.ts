import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { len, stockValues } from './library.fixture'
import { Stock } from './stock'
import { StockValuesDtoSchema } from './stock.dto'

const load = (raw: unknown) =>
  parseWith(StockValuesDtoSchema, raw, 'test').andThen((dto) => Stock.fromDTO(dto))

describe('Stock', () => {
  it('round-trips a block through its DTO', () => {
    const s = expectOk(load(stockValues()))
    expect(s.kind).toBe('stock')
    expect(s.length.canonical).toBe(100)
    expect(s.thickness.tolerance.isSome()).toBe(true)
    expect(s.notes.isNone()).toBe(true)
    expect(s.toDTO()).toEqual(stockValues())
  })

  it('keeps notes', () => {
    const s = expectOk(load({ ...stockValues(), notes: 'shelf 3' }))
    expect(s.notes.unwrap()).toBe('shelf 3')
    expect(s.toDTO().notes).toBe('shelf 3')
  })

  it('reports every non-positive dimension at once', () => {
    const e = expectErrCode(
      load({ ...stockValues(), length: len('0'), width: len('-5'), thickness: len('0') }),
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['length', 'positive'],
      ['width', 'positive'],
      ['thickness', 'positive'],
    ])
  })

  it('rejects a quantity of the wrong kind at the shape level', () => {
    const angle = { ...len('1'), kind: 'angle', defaultUnit: 'deg' }
    expectErrCode(load({ ...stockValues(), length: angle }), 'input.malformed')
  })

  it('rejects an unknown material class, empty names and long notes', () => {
    const e = expectErrCode(
      load({
        ...stockValues(),
        name: '',
        notes: 'x'.repeat(4001),
        material: { name: '', class: 'wood' },
      }),
      'input.malformed',
    )
    expect(e.issues.map((i) => i.path.join('.')).sort()).toEqual([
      'material.class',
      'material.name',
      'name',
      'notes',
    ])
  })

  it('create() checks the same rules as the schema', () => {
    const s = expectOk(load(stockValues()))
    const e = expectErrCode(
      s.with({ name: 'x'.repeat(121), material: { name: '', class: 'aluminum' } }),
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['name', 'length'],
      ['material.name', 'length'],
    ])
  })

  it('with() returns a new valid model and leaves the old one unchanged', () => {
    const s = expectOk(load(stockValues()))
    expect(expectOk(s.with({ name: 'Other' })).name).toBe('Other')
    expect(s.name).toBe('Alu plate 6061')
    expect(Object.isFrozen(s)).toBe(true)
  })
})
