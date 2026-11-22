// Plan finding texts: the design tool findings of E4 worded from their params (task F5), every
// other code the core's message, sentence-cased. Doc: docs/modes/plan-v0.2.md#implementation-task-e4
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../../../core/plan/checks'
import { findingText, planMessages } from './plan'

const finding = (over: Partial<PlanWarning>): PlanWarning =>
  ({
    code: 'plan.check',
    severity: 'error',
    message: 'no tool assigned',
    rule: 'noTool',
    planOperationId: 'op-1',
    field: 'tool',
    params: {},
    ...over,
  }) as PlanWarning

describe('plan finding texts', () => {
  it('words a clamped stepover in the user units (task U2)', () => {
    const w = finding({
      code: 'plan.stepoverClamped',
      severity: 'info',
      rule: 'offsetClearing',
      field: 'stepover',
      message: 'stepover clamped to 3 mm (half the tool) for offset clearing of op-1',
      params: { operation: 'op-1', stepover: 5, effective: 3 },
    })
    expect(findingText(w)).toBe('Clamped to 3.00 mm (half the tool) for offset clearing.')
    expect(findingText(w, 'inch')).not.toContain('mm')
    expect(
      findingText({ ...w, message: 'stepover clamped to 1 mm (the flat radius) for …' }),
    ).toContain('(the flat radius)')
  })

  it('words the region-width tool checks in the user units (BL2)', () => {
    const w = finding({
      rule: 'openingSize',
      message: 'tool diameter must fit the opening of profile1 (4.99 mm at its widest)',
      params: { operation: 'profile1', diameter: 6, opening: 4.99 },
    })
    expect(findingText(w)).toBe(
      'The tool (6.00 mm) is too wide for the opening: it is 4.99 mm at its narrowest.',
    )
    expect(findingText(w, 'inch')).not.toContain('mm')
    expect(findingText(finding({ rule: 'pocketSize', params: { diameter: 6, pocket: 5 } }))).toBe(
      'The tool (6.00 mm) is too wide for the pocket: it is 5.00 mm at its narrowest.',
    )
    // without the numbers, and for other rules, the core text stays
    expect(findingText(finding({ rule: 'openingSize', message: 'too wide' }))).toBe('Too wide.')
    expect(findingText(finding({}))).toBe('No tool assigned.')
  })

  it('names the openingSize check of a design tool (BL2)', () => {
    expect(
      findingText(
        finding({
          code: 'plan.designToolReplaced',
          severity: 'info',
          rule: 'openingSize',
          params: { check: 'openingSize', designTool: 'Flat 6', tool: 'Flat 3' },
        }),
      ),
    ).toBe('The design’s tool, the Flat 6, is too wide for the opening: Flat 3 is used instead.')
  })

  it('words the design tool findings from their params', () => {
    expect(
      findingText(
        finding({
          code: 'plan.designToolReplaced',
          severity: 'info',
          rule: 'reach',
          params: { check: 'reach', designTool: 'Flat 6', tool: 'Flat 6 long' },
        }),
      ),
    ).toBe(
      'The design’s tool, the Flat 6, does not reach the depth with its stickout: Flat 6 long is used instead.',
    )
    expect(
      findingText(
        finding({
          code: 'plan.designToolFailed',
          rule: 'fluteLength',
          params: { check: 'fluteLength', designTool: 'Flat 6', alternatives: 'Flat 4, Flat 3' },
        }),
      ),
    ).toBe(
      'The design’s locked tool, the Flat 6, has too short a flute. Tools that fit: Flat 4, Flat 3. Assign another tool here, change the machine, extend the stickout, or change the design.',
    )
    expect(
      findingText(
        finding({
          code: 'plan.toolUnresolved',
          rule: 'noMatchingTool',
          params: { designTool: '1/4" flat end mill', alternatives: '' },
        }),
      ),
    ).toBe(
      'No library tool that matches the design’s locked 1/4" flat end mill passes the plan checks. No library tool fits. Add a matching tool to the library, or assign another tool here.',
    )
    // an unknown check still reads as a sentence
    expect(
      findingText(
        finding({
          code: 'plan.designToolReplaced',
          params: { check: 'newRule', designTool: 'Flat 6', tool: 'Flat 4' },
        }),
      ),
    ).toContain('Flat 6, fails a plan check: Flat 4 is used instead.')
  })

  it('keeps the core message, sentence-cased, for other codes', () => {
    expect(findingText(finding({}))).toBe('No tool assigned.')
  })
})

describe('plan status texts', () => {
  it('leaves the face out of a setup subtitle when the name already says it', () => {
    expect(planMessages.setup.rowMeta('top', 'front left', 0, 'Top')).toBe('G54 front left · 0°')
    expect(planMessages.setup.rowMeta('top', 'front left', 90, 'Flip')).toBe(
      'Top · G54 front left · 90°',
    )
    expect(planMessages.setup.rowMeta('bottom', undefined, 0)).toBe('Bottom · 0°')
  })

  it('counts errors and warnings, never notes', () => {
    expect(planMessages.warnings.count(0, 0)).toBe('0 warnings')
    expect(planMessages.warnings.count(1, 2)).toBe('1 error, 2 warnings')
  })
})
