// Plan finding texts: the design tool findings of E4 worded from their params (task F5), every
// other code the core's message, sentence-cased. Doc: docs/modes/plan-v0.2.md#implementation-task-e4
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../../../core/plan/checks'
import { findingText } from './plan'

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
