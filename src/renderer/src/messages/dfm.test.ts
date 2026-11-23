// DFM catalogue: every code has a sentence, values in the project unit system, suggestions
// rounded so they satisfy the check. Doc: docs/conventions/ui.md#warnings-and-dfm
import { describe, expect, it } from 'vitest'
import { DFM_WARNING_CODES, type DfmWarning } from '../../../core/geometry/model'
import { dfmMessages, lengthSource } from './dfm'

const w = (over: Partial<DfmWarning>): DfmWarning => ({
  code: 'dfm.cornerTooSmall',
  severity: 'warning',
  message: 'core text',
  operation: 'pocket1',
  parameter: 'shape.cornerRadius',
  params: { cornerRadius: 1, toolRadius: 3.175 },
  suggestion: { relation: 'atLeast', value: 3.175 },
  ...over,
})

/** Readable names of the fixture's ids, as the design inspector resolves them (DF43). */
const NAMES: Readonly<Record<string, string>> = {
  pocket1: 'Pocket 1',
  drill1: 'Drilling 1',
  'pocket1.floor': 'Pocket 1 floor',
}
const names = {
  item: (id: string) => NAMES[id] ?? 'Unknown operation',
  surface: (id: string) => NAMES[id] ?? 'Unknown operation surface',
}

describe('dfm messages', () => {
  it('renders every code in mm and inch, never the core fallback', () => {
    for (const code of DFM_WARNING_CODES) {
      const text = dfmMessages.text(w({ code }), 'inch', names)
      expect(text, code).not.toBe('core text')
      expect(text, code).toMatch(/^[A-Z]/)
    }
    expect(dfmMessages.text(w({}), 'mm', names)).toContain('3.18 mm')
    expect(dfmMessages.text(w({}), 'inch', names)).toContain('0.125"')
  })

  it('names operations and surfaces by their readable names, never their ids (DF43)', () => {
    const missing = dfmMessages.text(
      w({ code: 'dfm.surfaceMissing', parameter: 'on', params: { surface: 'pocket1.floor' } }),
      'mm',
      names,
    )
    expect(missing).toBe(
      'It starts from or refers to Pocket 1 floor, which the part no longer has. Pick another surface.',
    )
    const removed = dfmMessages.text(
      w({
        code: 'dfm.retainedRemoved',
        params: { by: 'drill1', regions: ['floorFillet', 'tab[1]'] },
      }),
      'mm',
      names,
    )
    expect(removed).toBe(
      'Drilling 1 cuts away the floor fillet and tab 2 of this operation. Move one of them.',
    )
    for (const text of [missing, removed]) expect(text).not.toMatch(/pocket1|drill1|\[|floorFillet/)
  })

  it('suggests a value that satisfies the check, in the project units', () => {
    expect(dfmMessages.suggestionSource(w({}), 'mm')).toBe('3.18 mm') // ≥ 3.175, rounded up
    expect(
      dfmMessages.suggestionSource(
        w({ parameter: 'depth', suggestion: { relation: 'atMost', value: 12.349 } }),
        'mm',
      ),
    ).toBe('12.34 mm')
    expect(
      dfmMessages.suggestionSource(
        w({ parameter: 'tabs.count', suggestion: { relation: 'atLeast', value: 1 } }),
        'mm',
      ),
    ).toBe('1')
    expect(dfmMessages.suggestionSource(w({ parameter: 'shape' }), 'mm')).toBeUndefined()
    expect(dfmMessages.useValue('atLeast', '3.18 mm')).toBe('Use ≥ 3.18 mm')
    expect(dfmMessages.tier(w({ severity: 'info' }))).toBe('soft')
    expect(lengthSource(25.4, 'inch')).toBe('1"')
  })

  it('a chamfer through a thin floor names the cut under it (B4)', () => {
    const tooDeep = (params: DfmWarning['params']) =>
      dfmMessages.text(
        w({ code: 'dfm.chamferTooDeep', operation: 'chamfer1', parameter: 'width', params }),
        'mm',
        names,
      )
    expect(tooDeep({ depth: 2, edgeDepth: 1.5, edgeOf: 'pocket1', floor: 1 })).toBe(
      'The chamfer is 2 mm deep and cuts through the 1.5 mm floor above Pocket 1.',
    )
    expect(tooDeep({ depth: 2, edgeDepth: 1, edgeOf: 'drill1' })).toBe(
      'The chamfer is 2 mm deep, deeper than Drilling 1 (1 mm).',
    )
  })

  it('words the tool checks by their fit rule, in the project units (F5)', () => {
    const unfit = (params: DfmWarning['params']) =>
      w({
        code: 'dfm.toolUnfit',
        parameter: 'tool',
        params: { tool: '6 mm flat end mill', ...params },
      })
    const text = (params: DfmWarning['params'], units: 'mm' | 'inch' = 'mm') =>
      dfmMessages.text(unfit(params), units, names)
    expect(text({ rule: 'cornerRadius', cornerRadius: 2, toolRadius: 3, locked: false })).toBe(
      'Corner radius 2 mm is smaller than the radius of the 6 mm flat end mill (3 mm).',
    )
    expect(text({ rule: 'cornerRadius', cornerRadius: 2, toolRadius: 3, locked: true })).toMatch(
      /Unlock it or pick another tool\.$/,
    )
    expect(text({ rule: 'width', toolDiameter: 6, size: 5.08, feature: 'slot' }, 'inch')).toBe(
      'The 6 mm flat end mill is wider than the slot (0.2").',
    )
    expect(text({ rule: 'width', toolDiameter: 6, size: 4, feature: 'pocket' })).toContain(
      'pocket at its narrowest (4 mm)',
    )
    expect(text({ rule: 'floorRadius', floorRadius: 1, toolCornerRadius: 0 })).toContain(
      'needs a bull-nose end mill with corner radius 1 mm',
    )
    expect(text({ rule: 'floorRadius', floorRadius: 0, toolCornerRadius: 1 })).toContain(
      'leaves a 1 mm fillet',
    )
    expect(text({ rule: 'diameter', holeDiameter: 5, toolDiameter: 6 })).toBe(
      'The 6 mm flat end mill does not match the Ø 5 mm hole.',
    )
    expect(text({ rule: 'diameter', holeDiameter: 10, toolDiameter: 4, boring: true })).toContain(
      'between Ø 5 mm and Ø 10 mm',
    )
    expect(text({ rule: 'type', needs: 'endMill' })).toContain('a flat or bull-nose end mill')
    expect(text({ rule: 'type', needs: 'notDrill' })).toBe(
      'A drill cannot make a flat bottom: use a flat end mill.',
    )
    expect(text({ rule: 'reach', reach: 20, depth: 25 })).toBe(
      'The 6 mm flat end mill reaches 20 mm; the operation is 25 mm deep.',
    )
    // values missing (unknown rule): still a sentence naming the tool
    expect(text({ rule: 'other' })).toBe('The 6 mm flat end mill does not fit.')
    expect(
      dfmMessages.text(
        w({
          code: 'dfm.toolNotInLibrary',
          parameter: 'tool',
          params: { tool: '1/4" flat end mill' },
        }),
        'inch',
        names,
      ),
    ).toBe('Plan needs a 1/4" flat end mill: add one to the library.')
    // a tool check's suggestion is the size the operation needs, never a value of the tool field
    expect(dfmMessages.suggestionSource(unfit({ rule: 'cornerRadius' }), 'mm')).toBeUndefined()
  })
})
