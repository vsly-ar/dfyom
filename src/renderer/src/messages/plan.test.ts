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
  it('drops the operation name the core puts in front for agents (D4): the finding sits at it', () => {
    expect(findingText(finding({ message: 'Pocket 1 (op-1): no tool assigned' }))).toBe(
      'No tool assigned.',
    )
    expect(
      findingText(finding({ code: 'plan.aid', message: 'Witness mark 1 (op-1) cuts the part' })),
    ).toBe('Witness mark 1 cuts the part.')
  })

  it('names operations and setups by name in order, loose-piece, cut-out, corner and rest findings, never by id (DF43)', () => {
    const NAMES: Record<string, string> = {
      pocket1: 'Pocket 1',
      profile1: 'Profile 1',
      'op-2': 'Hole 1',
      top: 'Top',
      bottom: 'Bottom',
    }
    const names = {
      design: (id: string) => NAMES[id] ?? 'Unknown operation',
      planOperation: (id: string) => NAMES[id] ?? 'Unknown operation',
      setup: (id: string) => NAMES[id] ?? 'Unknown',
    }
    const texts = [
      finding({ code: 'plan.order', rule: 'edgeBefore', params: { dependsOn: 'op-2' } }),
      finding({ code: 'plan.order', rule: 'onBefore', params: { dependsOn: 'op-2' } }),
      finding({
        code: 'plan.loosePiece',
        rule: 'profileFirst',
        params: { profile: 'profile1', operation: 'pocket1' },
      }),
      finding({
        code: 'plan.cutoutBeforeSetup',
        rule: 'cutoutLast',
        params: { profile: 'profile1', setupId: 'top', nextSetupId: 'bottom' },
      }),
      finding({
        rule: 'cornerRadius',
        params: { operation: 'pocket1', radius: 3, cornerRadius: 0 },
      }),
      finding({
        code: 'plan.restMaterial',
        rule: 'restMaterial',
        params: { operation: 'pocket1', area: 12.34, u: 10, v: 5 },
      }),
    ].map((w) => findingText(w, 'mm', names))
    expect(texts).toEqual([
      'This operation chamfers an edge of Hole 1, which comes later.',
      'This operation starts from a surface of Hole 1, which comes later.',
      'Profile 1 is cut before Pocket 1 inside it: the piece may be loose.',
      'Profile 1 cuts through in setup Top before setup Bottom: held only by its tabs while re-fixtured.',
      'Tool radius 3.00 mm is above the smallest inside corner of Pocket 1 (sharp): that corner keeps the tool radius.',
      '12.3 mm² of Pocket 1 near (10.00 mm, 5.00 mm) stays uncut: a neck is narrower than the tool.',
    ])
    for (const t of texts) expect(t).not.toMatch(/pocket1|profile1|op-2/)
  })

  it('names where the collet nut size is entered (DF132 Q181) and shows the holder collision as the core words it', () => {
    const names = { design: () => '', planOperation: () => '', setup: () => 'Top' }
    expect(
      findingText(
        finding({
          code: 'plan.holder.unknown',
          severity: 'info',
          rule: 'unknown',
          field: 'machine.holder',
          message: 'The machine has no collet nut size: …',
          params: { setupId: 's1' },
        }),
        'mm',
        names,
      ),
    ).toBe(
      'The workholding of Top is checked against the tool only: the machine has no collet nut size. Enter it under Holder in the machine’s Spindle tab (Library) to check the nut and spindle body against the clamps.',
    )
    expect(
      findingText(
        finding({
          code: 'plan.workholding.collision',
          rule: 'holder',
          field: 'stickout',
          message:
            'Pocket 1 (op-1): the collet nut (ER11, Ø19) at Z19 hits Toe clamp 1 near X19 Y40 (tip Z-6, Toe clamp 1 top Z25, margin 2 mm): chuck the tool with at least 36 mm out or move the item',
        }),
      ),
    ).toBe(
      'The collet nut (ER11, Ø19) at Z19 hits Toe clamp 1 near X19 Y40 (tip Z-6, Toe clamp 1 top Z25, margin 2 mm): chuck the tool with at least 36 mm out or move the item.',
    )
  })

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
