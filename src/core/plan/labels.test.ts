import { describe, expect, it } from 'vitest'
import type { PartDTO } from '../design/part.dto'
import { planOperationLabel } from './labels'

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
})
