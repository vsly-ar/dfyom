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
})
