import { describe, expect, it } from 'vitest'
import type { PartDTO } from '../design/part.dto'
import { namedPlanMessages, planOperationLabel, withoutOperationName } from './labels'
import type { PlanOperationDTO } from './plan.dto'

const op = (id: string, name: string, featureId?: string, featureRole?: string) => ({
  id,
  name,
  ...(featureId === undefined ? {} : { featureId, featureRole }),
})

/** A part with two holes, each repeated by its own Clones feature (only what labels read). */
const part = {
  operations: [
    op('hole1_drill', 'Screw A · drill', 'hole1', 'drill'),
    op('clones1_2_hole1_drill', 'Screw A · drill · 2', 'clones1', '2_hole1_drill'),
    op('clones1_3_hole1_drill', 'Screw A · drill · 3', 'clones1', '3_hole1_drill'),
    op('hole2_drill', 'Screw B · drill', 'hole2', 'drill'),
    op('clones2_2_hole2_drill', 'Screw B · drill · 2', 'clones2', '2_hole2_drill'),
    op('drilling1', 'Drilling 1'),
    op('drilling2', 'Drilling 2'),
  ],
  features: [
    { id: 'clones1', kind: 'clones', name: 'Clones 1', source: { featureId: 'hole1' } },
    { id: 'clones2', kind: 'clones', name: 'Clones 2', source: { featureId: 'hole2' } },
  ],
} as unknown as PartDTO

describe('planOperationLabel', () => {
  it('names a repeated operation once with its count', () => {
    expect(
      planOperationLabel(part, ['hole1_drill', 'clones1_2_hole1_drill', 'clones1_3_hole1_drill']),
    ).toBe('Screw A · drill × 3')
  })

  it('names each repeated operation of a merged group once with its count (X2 F10)', () => {
    expect(
      planOperationLabel(part, [
        'hole1_drill',
        'clones1_2_hole1_drill',
        'clones1_3_hole1_drill',
        'hole2_drill',
        'clones2_2_hole2_drill',
        'drilling1',
      ]),
    ).toBe('Screw A · drill × 3, Screw B · drill × 2, Drilling 1')
  })

  it('lists single operations by name', () => {
    expect(planOperationLabel(part, ['drilling1', 'drilling2'])).toBe('Drilling 1, Drilling 2')
    expect(planOperationLabel(part, ['drilling1'])).toBe('Drilling 1')
  })

  it('reads "Unknown operation" for an id the part no longer has, never the id (DF43)', () => {
    expect(planOperationLabel(part, ['gone1'])).toBe('Unknown operation')
    expect(planOperationLabel(part, ['drilling1', 'gone1'])).toBe('Drilling 1, Unknown operation')
  })
})

describe('namedPlanMessages (D4: plan messages name their operation)', () => {
  const plan = {
    design: { part },
    setups: [
      {
        operations: [
          { id: 'op1', designOperationIds: ['drilling1'] },
          { id: 'op2', designOperationIds: [], aid: { name: 'Witness mark 1' } },
        ] as unknown as PlanOperationDTO[],
      },
    ],
  }
  const f = (message: string, planOperationId?: string) => ({
    message,
    ...(planOperationId === undefined ? {} : { planOperationId }),
  })

  it('prefixes label and id, or puts the id after a leading label, once', () => {
    const named = namedPlanMessages(plan, [
      f('no tool assigned', 'op1'),
      f('Witness mark 1 cuts the part: place it in the waste', 'op2'),
      f('the plan has no setups'),
      f('gone', 'op9'),
    ])
    expect(named.map((n) => n.message)).toEqual([
      'Drilling 1 (op1): no tool assigned',
      'Witness mark 1 (op2) cuts the part: place it in the waste',
      'the plan has no setups',
      'gone',
    ])
    expect(namedPlanMessages(plan, named)).toEqual(named)
  })

  it('withoutOperationName gives the app its text back', () => {
    expect(withoutOperationName('Drilling 1 (op1): no tool assigned', 'op1')).toBe(
      'no tool assigned',
    )
    expect(withoutOperationName('Witness mark 1 (op2) cuts the part', 'op2')).toBe(
      'Witness mark 1 cuts the part',
    )
    expect(withoutOperationName('no tool assigned', 'op1')).toBe('no tool assigned')
    expect(withoutOperationName('Drilling 1 (op1): x', undefined)).toBe('Drilling 1 (op1): x')
  })
})
