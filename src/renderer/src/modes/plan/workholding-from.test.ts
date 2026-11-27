// DF125: the workholding fields' references (docs/modes/workholding.md#measured-from-df125).
import { describe, expect, it } from 'vitest'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import { shownQuantity, storedSource, storeOffset } from './workholding-from'

const refs = { zero: [20, -5] as const, thickness: 18 }
const q = (source: string, units: 'mm' | 'inch' = 'mm') =>
  Quantity.parse(source, fieldContext('length', units)).unwrap()

describe('workholding fields measured from', () => {
  it('offsets X/Y by the work zero and heights by the thickness, only when chosen', () => {
    const corner = { xy: 'corner', z: 'top' } as const
    const zero = { xy: 'zero', z: 'bottom' } as const
    expect([storeOffset('x', corner, refs), storeOffset('z', corner, refs)]).toEqual([0, 0])
    expect(storeOffset('x', zero, refs)).toBe(20)
    expect(storeOffset('y', zero, refs)).toBe(-5)
    expect(storeOffset('z', zero, refs)).toBe(-18)
  })
  it('keeps the stored entry as typed without an offset', () => {
    const dto = q('1 1/4"').toDTO()
    expect(shownQuantity(dto, 31.75, 0, 'mm')?.source).toBe('1 1/4"')
    expect(storedSource(q('12'), 0, 'mm')).toBe('12')
  })
  it('shows the resolved value less the offset and stores the entry plus it', () => {
    expect(shownQuantity(q('30').toDTO(), 30, 20, 'mm')?.source).toBe('10 mm')
    expect(storedSource(q('25'), 20, 'mm')).toBe('45 mm')
    // heights: Z20 above an 18 mm stock reads 38, an entry of 48 stores 30
    expect(shownQuantity(q('20').toDTO(), 20, -18, 'mm')?.source).toBe('38 mm')
    expect(storedSource(q('48'), -18, 'mm')).toBe('30 mm')
    // inch projects write inch
    expect(storedSource(q('1', 'inch'), 25.4, 'inch')).toBe('2"')
  })
})
