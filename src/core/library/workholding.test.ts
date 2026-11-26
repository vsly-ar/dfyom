import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { len, toeClampValues } from './library.fixture'
import { LibraryItem, parseLibraryItem } from './library-item'
import { Workholding } from './workholding'
import {
  builtinWorkholding,
  BUILTIN_UPDATED_AT,
  defaultWorkholding,
  isBuiltinWorkholding,
} from './workholding-builtins'
import { WorkholdingValuesDtoSchema, WORKHOLDING_TYPES } from './workholding.dto'

const load = (raw: unknown) =>
  parseWith(WorkholdingValuesDtoSchema, raw, 'test').andThen((dto) => Workholding.fromDTO(dto))
const issues = (raw: unknown) =>
  expectErrCode(load(raw), 'model.invariant').issues.map((i) => [i.path.join('.'), i.rule])

const base = (type: string) => ({ kind: 'workholding', name: 'Device', type })

/** One valid item per type, the type's required fields only. */
const MINIMAL: Record<(typeof WORKHOLDING_TYPES)[number], object> = {
  toeClamp: { ...base('toeClamp'), width: len('30'), length: len('60'), top: len('25') },
  vise: { ...base('vise'), jawWidth: len('150'), jawThickness: len('20'), soft: false },
  screw: { ...base('screw'), headDiameter: len('8'), headHeight: len('0') },
  block: { ...base('block'), length: len('40'), width: len('20'), height: len('15') },
  base: { ...base('base'), baseType: 'fixturePlate', sacrificial: false },
  surface: { ...base('surface'), surfaceType: 'vacuum' },
}

describe('Workholding', () => {
  it('round-trips a toe clamp through its DTO in file order', () => {
    const w = expectOk(load(toeClampValues()))
    expect(w.kind).toBe('workholding')
    expect(w.type).toBe('toeClamp')
    expect(w.size('length').unwrap().canonical).toBe(70)
    expect(w.size('jawWidth').isNone()).toBe(true)
    expect(w.toDTO()).toEqual(toeClampValues())
    expect(Object.keys(w.toDTO())).toEqual([
      'kind',
      'name',
      'type',
      'width',
      'length',
      'top',
      'gripMin',
      'gripMax',
      'stud',
    ])
  })

  it.each(WORKHOLDING_TYPES)('accepts a %s with its required fields', (type) => {
    const w = expectOk(load(MINIMAL[type]))
    expect(w.toDTO()).toEqual(MINIMAL[type])
  })

  it('stores default only when set', () => {
    const w = expectOk(load({ ...toeClampValues(), default: true }))
    expect(w.isDefault).toBe(true)
    expect(Object.keys(w.toDTO()).slice(0, 4)).toEqual(['kind', 'name', 'type', 'default'])
    expect(expectOk(load({ ...toeClampValues(), default: false })).toDTO()).toEqual(
      toeClampValues(),
    )
  })

  it("refuses a field of another type (notForKind) and names the type's fields", () => {
    const e = expectErrCode(
      load({ ...MINIMAL.vise, width: len('30'), stud: 'M8', surfaceType: 'tape' }),
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['width', 'notForKind'],
      ['stud', 'notForKind'],
      ['surfaceType', 'notForKind'],
    ])
    expect(e.issues[0]!.message).toBe(
      'a vise takes jawWidth, jawThickness, soft, jawHeight, maxOpening',
    )
  })

  it('reports every missing required field', () => {
    expect(issues(base('toeClamp'))).toEqual([
      ['width', 'required'],
      ['length', 'required'],
      ['top', 'required'],
    ])
    expect(issues(base('base'))).toEqual([
      ['baseType', 'required'],
      ['sacrificial', 'required'],
    ])
  })

  it('sizes are > 0; a screw head height and a base thickness may be 0', () => {
    expect(issues({ ...MINIMAL.block, length: len('0'), height: len('-1') })).toEqual([
      ['length', 'positive'],
      ['height', 'positive'],
    ])
    expectOk(load({ ...MINIMAL.base, thickness: len('0') }))
    expect(issues({ ...MINIMAL.screw, headHeight: len('-0.5') })).toEqual([
      ['headHeight', 'nonNegative'],
    ])
  })

  it('a grip range is gripMin ≤ gripMax < length, both or none', () => {
    const clamp = toeClampValues()
    expect(issues({ ...clamp, gripMin: len('12'), gripMax: len('10') })).toEqual([
      ['gripMax', 'gripRange'],
    ])
    expect(issues({ ...clamp, gripMax: len('70') })).toEqual([['gripMax', 'lessThanLength']])
    const { gripMax: _, ...onlyMin } = clamp
    expect(issues(onlyMin)).toEqual([['gripMax', 'gripRange']])
    expectOk(load({ ...clamp, gripMin: len('10'), gripMax: len('10') }))
  })

  it('stud and thread are 1–20 characters', () => {
    expect(issues({ ...toeClampValues(), stud: 'x'.repeat(21) })).toEqual([['stud', 'length']])
    expect(issues({ ...MINIMAL.screw, thread: '' })).toEqual([['thread', 'length']])
  })

  it('a stored workholding item loads as a library item', () => {
    const item = expectOk(
      parseLibraryItem(
        { id: 'workholding-1', revision: 1, updatedAt: BUILTIN_UPDATED_AT, ...toeClampValues() },
        'test',
      ),
    )
    expect(item.kind).toBe('workholding')
  })
})

describe('built-in workholding items', () => {
  it('lists the eight built-ins with their ids, mm and inch value sets', () => {
    const mm = builtinWorkholding('mm')
    expect(mm.map((i) => i.id)).toEqual([
      'builtin-toe-clamp',
      'builtin-vise',
      'builtin-screw',
      'builtin-spoilboard',
      'builtin-fixture-plate',
      'builtin-tape',
      'builtin-vacuum',
      'builtin-glue',
    ])
    expect(mm.every((i) => isBuiltinWorkholding(i.id) && i.revision === 1)).toBe(true)
    const inch = builtinWorkholding('inch')
    const clamp = (items: readonly LibraryItem[]) => items[0]!.values as Workholding
    expect(clamp(mm).size('width').unwrap().source).toBe('30 mm')
    expect(clamp(inch).size('width').unwrap().source).toBe('1 1/4"')
    expect(clamp(inch).size('width').unwrap().canonical).toBe(31.75)
    expect(clamp(inch).size('gripMax').unwrap().source).toBe('5/8"')
    expect((inch[1]!.values as Workholding).name).toBe('Machine vise 6"')
    expect(builtinWorkholding('mm')).toBe(mm) // built once per unit system
  })

  it('today’s W6-C clamp: width 30, length 60 (grip 10 + reach 50), top 25, grip 5–15 mm', () => {
    const v = builtinWorkholding('mm')[0]!.values as Workholding
    expect(
      (['width', 'length', 'top', 'gripMin', 'gripMax'] as const).map(
        (f) => v.size(f).unwrap().canonical,
      ),
    ).toEqual([30, 60, 25, 5, 15])
  })
})

describe('default workholding per type (Q135)', () => {
  const user = (id: string, updatedAt: string, isDefault: boolean, values = toeClampValues()) =>
    expectOk(
      LibraryItem.create({
        id,
        revision: 1,
        updatedAt,
        values: expectOk(load({ ...values, ...(isDefault ? { default: true } : {}) })),
      }),
    )

  it('is the built-in when no user item claims it; blocks have none', () => {
    const plain = user('workholding-1', '2026-11-26T10:00:00Z', false)
    expect(defaultWorkholding([plain], 'toeClamp', 'mm').unwrap().id).toBe('builtin-toe-clamp')
    expect(defaultWorkholding([], 'base', 'mm').unwrap().id).toBe('builtin-spoilboard')
    expect(defaultWorkholding([], 'surface', 'inch').unwrap().id).toBe('builtin-tape')
    expect(defaultWorkholding([], 'block', 'mm').isNone()).toBe(true)
  })

  it('is the user item marked default; of two, the later updatedAt wins', () => {
    const a = user('workholding-1', '2026-11-26T10:00:00Z', true)
    const b = user('workholding-2', '2026-11-26T09:00:00Z', true)
    expect(defaultWorkholding([a, b], 'toeClamp', 'mm').unwrap().id).toBe('workholding-1')
    const c = user('workholding-3', '2026-11-26T11:00:00Z', true)
    expect(defaultWorkholding([a, b, c], 'toeClamp', 'mm').unwrap().id).toBe('workholding-3')
    // a default of another type does not count
    expect(defaultWorkholding([a], 'vise', 'mm').unwrap().id).toBe('builtin-vise')
  })
})
