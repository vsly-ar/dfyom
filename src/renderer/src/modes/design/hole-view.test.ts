// The hole inspector's pure model (v0.4 U2): size fields per type, the refill's entered-size count,
// the custom-size note and the sources line. Doc: docs/conventions/ui.md#hole-inspector
import { describe, expect, it } from 'vitest'
import type { DfmWarning } from '../../../../core/geometry/model'
import { Quantity } from '../../../../core/quantity/quantity'
import { fieldContext } from '../../../../core/design/operation'
import {
  customSizeNote,
  enteredSizesReplaced,
  fastenerSources,
  headDefaults,
  holeRecord,
  sectionValues,
  sharedToolNote,
  sizeFields,
  type FastenerListRow,
  type HoleRecord,
} from './hole-view'

const q = (s: string) => Quantity.parse(s, fieldContext('length', 'mm')).unwrap().toDTO()

const hole = (over: Partial<HoleRecord> = {}): HoleRecord => ({
  id: 'hole1',
  name: 'Hole 1',
  on: 'stock.top',
  type: 'simple',
  fastener: 'M3',
  purpose: 'clearance',
  fit: 'normal',
  bottom: 'through',
  csMethod: 'chamfer',
  center: [q('20'), q('20')],
  sizes: { diameter: q('3.4 mm'), headSink: q('0.2 mm') },
  ...over,
})

const M3: FastenerListRow = {
  size: 'M3',
  nominal: 3,
  tapDrill: 2.5,
  clearance: { close: 3.2, normal: 3.4, loose: 3.6 },
  socketHead: { diameter: 5.5, height: 3 },
  counterbore: { diameter: 6.5 },
  countersunkHead: { diameter: 6.72, angle: 90, source: 'ISO 10642' },
}

describe('hole view', () => {
  it('head defaults stay within half the material below a through hole (X2: 6 mm board)', () => {
    const custom = hole({ fastener: undefined, sizes: { diameter: q('6 mm') } })
    // without the material: one diameter deep
    expect(headDefaults(custom, 'counterbore', 'mm')).toEqual({
      cbDiameter: '10.8 mm',
      cbDepth: '6 mm',
    })
    // a 6 mm board: 3 mm, which the core takes (a counterbore must end above the stock bottom)
    expect(headDefaults(custom, 'counterbore', 'mm', 6)).toEqual({
      cbDiameter: '10.8 mm',
      cbDepth: '3 mm',
    })
    expect(headDefaults(custom, 'countersink', 'mm', 4)).toEqual({ csDiameter: '10 mm' })
  })

  it('lists the size fields of a type and bottom', () => {
    expect(sizeFields({ type: 'simple', bottom: 'through' })).toEqual(['diameter'])
    expect(sizeFields({ type: 'counterbore', bottom: 'flat' })).toEqual([
      'diameter',
      'depth',
      'cbDiameter',
      'cbDepth',
    ])
    expect(sizeFields({ type: 'countersink', bottom: 'through' })).toEqual([
      'diameter',
      'csDiameter',
      'csAngle',
    ])
  })

  it('counts only entered sizes a refill overwrites', () => {
    const next = {
      type: 'simple' as const,
      fastener: 'M4',
      purpose: 'clearance' as const,
      fit: 'normal' as const,
    }
    // the M3 table value is not an entered size
    expect(enteredSizesReplaced(hole(), next, new Set(), 'mm')).toBe(0)
    // a custom M3 diameter is
    const custom = hole({ sizes: { diameter: q('3.6'), headSink: q('0.2 mm') } })
    expect(enteredSizesReplaced(custom, next, new Set(['diameter']), 'mm')).toBe(1)
    // the same value as the new table replaces nothing
    expect(
      enteredSizesReplaced(
        hole({ sizes: { diameter: q('4.5'), headSink: q('0.2 mm') } }),
        next,
        new Set(['diameter']),
        'mm',
      ),
    ).toBe(0)
    // without a fastener every size counts but the core default diameter
    const plain = hole({
      fastener: undefined,
      sizes: { diameter: q('6 mm'), headSink: q('0.2 mm') },
    })
    expect(enteredSizesReplaced(plain, { ...next, fastener: 'M3' }, new Set(), 'mm')).toBe(0)
    const typed = hole({ fastener: undefined, sizes: { diameter: q('5'), headSink: q('0.2 mm') } })
    expect(enteredSizesReplaced(typed, { ...next, fastener: 'M3' }, new Set(), 'mm')).toBe(1)
  })

  it('words the custom-size note with the table value as the fix', () => {
    const w = {
      code: 'dfm.holeCustomSize',
      severity: 'info',
      message: '',
      operation: 'hole1_counterbore',
      parameter: 'cbDiameter',
      params: { field: 'cbDiameter', table: 6.5, value: 7, fastener: 'M3', feature: 'hole1' },
    } as DfmWarning
    expect(customSizeNote(w, 'mm')).toEqual({ text: 'DIN for M3: 6.5 mm.', source: '6.5 mm' })
    expect(customSizeNote(w, 'inch')?.text).toBe('DIN for M3: 0.2559" (6.5 mm).')
    expect(customSizeNote({ ...w, code: 'dfm.toolUnfit' } as DfmWarning, 'mm')).toBeUndefined()
  })

  it('names the sources of the filled sizes', () => {
    expect(fastenerSources(hole({ type: 'counterbore' }), [M3])).toEqual([
      ['ISO 273', 'normal'],
      ['ISO 4762', 'head'],
      ['DIN 974-1', 'counterbore'],
    ])
    expect(fastenerSources(hole({ purpose: 'tapDrill' }), [M3])).toEqual([
      ['ISO 2306', 'tap drill'],
    ])
    expect(fastenerSources(hole({ type: 'countersink' }), [M3])[1]).toEqual(['ISO 10642', 'head'])
    expect(fastenerSources(hole({ fastener: undefined }), [M3])).toEqual([])
  })

  it('reads the countersink method; the section gets the stepdown only when stepped (F7)', () => {
    const feature = (extra: object) =>
      ({ id: 'hole1', kind: 'hole', name: 'Hole 1', type: 'countersink', ...extra }) as never
    expect(holeRecord(feature({})).csMethod).toBe('chamfer')
    const stepped = holeRecord(feature({ csMethod: 'stepped', csStepdown: q('0.5 mm') }))
    expect(stepped.csMethod).toBe('stepped')
    expect(stepped.sizes.csStepdown?.source).toBe('0.5 mm')
    // the stepdown follows the method control, not the size fields
    expect(sizeFields(stepped)).toEqual(['diameter', 'csDiameter', 'csAngle'])
    const noPart = { loaded: undefined, table: undefined } as never
    const s = hole({ type: 'countersink', csMethod: 'stepped', sizes: { csStepdown: q('0.5') } })
    expect(sectionValues(s, noPart, []).csStepdown).toBe(0.5)
    expect(sectionValues({ ...s, csMethod: 'chamfer' }, noPart, []).csStepdown).toBeUndefined()
  })

  it('says whether a stepped countersink shares the drill role tool (F7)', () => {
    const sink = hole({ type: 'countersink', csMethod: 'stepped' })
    const ops = (cs: string | undefined, drill: string | undefined) => [
      { featureRole: 'drill', tool: drill },
      { featureRole: 'countersink', tool: cs },
    ]
    const same = (a: string, b: string) => a === b
    expect(sharedToolNote(sink, ops('em3', 'em3'), same)).toBe('same')
    expect(sharedToolNote(sink, ops('em2', 'em3'), same)).toBe('other')
    expect(sharedToolNote(sink, ops(undefined, 'em3'), same)).toBe('pending')
    expect(sharedToolNote({ ...sink, csMethod: 'chamfer' }, ops('a', 'b'), same)).toBeUndefined()
    expect(sharedToolNote({ ...sink, type: 'simple' }, ops('a', 'a'), same)).toBeUndefined()
  })
})
