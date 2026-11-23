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

describe('dfm messages', () => {
  it('renders every code in mm and inch, never the core fallback', () => {
    for (const code of DFM_WARNING_CODES) {
      const text = dfmMessages.text(w({ code }), 'inch', (id) => id)
      expect(text, code).not.toBe('core text')
      expect(text, code).toMatch(/^[A-Z]/)
    }
    expect(dfmMessages.text(w({}), 'mm', (id) => id)).toContain('3.18 mm')
    expect(dfmMessages.text(w({}), 'inch', (id) => id)).toContain('0.125"')
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
        (id) => id,
      )
    expect(tooDeep({ depth: 2, edgeDepth: 1.5, edgeOf: 'pocket1', floor: 1 })).toBe(
      'The chamfer is 2 mm deep and cuts through the 1.5 mm floor above pocket1.',
    )
    expect(tooDeep({ depth: 2, edgeDepth: 1, edgeOf: 'drill1' })).toBe(
      'The chamfer is 2 mm deep, deeper than drill1 (1 mm).',
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
      dfmMessages.text(unfit(params), units, (id) => id)
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
        (id) => id,
      ),
    ).toBe('Plan needs a 1/4" flat end mill: add one to the library.')
    // a tool check's suggestion is the size the operation needs, never a value of the tool field
    expect(dfmMessages.suggestionSource(unfit({ rule: 'cornerRadius' }), 'mm')).toBeUndefined()
  })
})
