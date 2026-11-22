import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { newProjectDoc } from '../project/document'
import { Quantity } from '../quantity/quantity'
import { flatEndMillValues, libraryInput } from './library.fixture'
import { usedLibraryItemIds } from './used'
import { itemUnitSystem, sourceFor, valuesFromInput, valuesInputFromDTO } from './values-input'
import { ToolValuesDtoSchema } from './tool.dto'

const inch = (source: string) =>
  expectOk(Quantity.parse(source, { kind: 'length', defaultUnit: 'in' })).toDTO()
const ipm = (source: string) =>
  expectOk(Quantity.parse(source, { kind: 'feedRate', defaultUnit: 'in/min' })).toDTO()

describe('sourceFor', () => {
  it('keeps the source when its bare-number unit is that of the unit system', () => {
    expect(sourceFor(inch('1/4'), 'inch')).toBe('1/4')
    expect(sourceFor(flatEndMillValues().diameter, 'mm')).toBe('6')
  })

  it('writes the unit out for a bare source entered in the other unit system', () => {
    expect(sourceFor(inch('1/4'), 'mm')).toBe('1/4 in')
    expect(sourceFor(inch('1 1/2 ±0.01'), 'mm')).toBe('1 1/2 in ±0.01')
    expect(sourceFor(ipm('40'), 'mm')).toBe('40 in/min')
  })

  it('keeps a source that writes its unit', () => {
    expect(sourceFor(inch('6 mm'), 'mm')).toBe('6 mm')
  })

  it('round-trips: the written-out source parses to the same value', () => {
    const q = inch('1 1/2 ±0.01')
    const back = expectOk(Quantity.parse(sourceFor(q, 'mm'), { kind: 'length', defaultUnit: 'mm' }))
    expect(back.toDTO().exact).toEqual(q.exact)
    expect(back.toDTO().tolerance).toEqual(q.tolerance)
  })
})

describe('valuesInputFromDTO', () => {
  it('turns stored values into command input like the fixture (kind dropped, sources kept)', () => {
    const v = flatEndMillValues()
    expect(valuesInputFromDTO(v, 'mm')).toEqual(libraryInput(v))
  })

  it('parses back to the stored values with the same units', () => {
    const v = { ...flatEndMillValues(), diameter: inch('1/4') }
    const input = valuesInputFromDTO(v, 'mm')
    expect(input['diameter']).toBe('1/4 in')
    const parsed = expectOk(
      valuesFromInput(ToolValuesDtoSchema, { ...input, kind: 'tool' }, 'mm', []),
    )
    expect((parsed as { diameter: { exact: unknown } }).diameter.exact).toEqual(v.diameter.exact)
  })

  it('leaves out undefined optional fields', () => {
    const v = { ...flatEndMillValues(), stickout: undefined }
    expect('stickout' in valuesInputFromDTO(v, 'mm')).toBe(false)
  })
})

describe('itemUnitSystem', () => {
  it('is the unit system of the first length quantity, else the fallback', () => {
    expect(itemUnitSystem(flatEndMillValues(), 'inch')).toBe('mm')
    expect(itemUnitSystem({ ...flatEndMillValues(), diameter: inch('1/4') }, 'mm')).toBe('inch')
    expect(itemUnitSystem({ name: 'x' }, 'inch')).toBe('inch')
  })
})

describe('usedLibraryItemIds', () => {
  it('lists the design snapshots and every plan copy once, sorted', () => {
    const doc = newProjectDoc({ name: 'P', unitSystem: 'mm' })
    const snap = (id: string, libraryItemId: string) => ({ id, libraryItemId })
    const withSnaps = {
      ...doc,
      snapshots: { s1: snap('s1', 'stock-b'), s2: snap('s2', 'tool-a') },
      plans: { p1: { snapshots: [snap('c1', 'machine-c'), snap('c2', 'tool-a')] } },
    } as unknown as typeof doc
    expect(usedLibraryItemIds(withSnaps)).toEqual(['machine-c', 'stock-b', 'tool-a'])
    expect(usedLibraryItemIds(doc)).toEqual([])
  })
})
