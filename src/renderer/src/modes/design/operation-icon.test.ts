// Row icons: one icon per meaning in the design navigator and the plan list (DF44).
import { describe, expect, it } from 'vitest'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import { partOperationIcon } from './operation-icon'

const op = (o: Record<string, string>): OperationDTO =>
  ({ name: o['id'], ...o }) as unknown as OperationDTO

const part = (
  operations: OperationDTO[],
  features: unknown[],
): Pick<PartDTO, 'operations' | 'features'> =>
  ({ operations, features }) as unknown as Pick<PartDTO, 'operations' | 'features'>

describe('partOperationIcon', () => {
  const drill = op({
    id: 'hole1_drill',
    kind: 'drilling',
    featureId: 'hole1',
    featureRole: 'drill',
  })
  const cb = op({
    id: 'hole1_counterbore',
    kind: 'pocket',
    featureId: 'hole1',
    featureRole: 'counterbore',
  })
  const cs = op({
    id: 'hole2_countersink',
    kind: 'chamfer',
    featureId: 'hole2',
    featureRole: 'countersink',
  })
  const chamfer = op({ id: 'chamfer1', kind: 'chamfer' })
  const pocket = op({ id: 'pocket1', kind: 'pocket' })
  const instance = op({
    id: 'clones1_3_hole1_counterbore',
    kind: 'pocket',
    featureId: 'clones1',
    featureRole: '3_hole1_counterbore',
  })
  const p = part(
    [drill, cb, cs, chamfer, instance, pocket],
    [
      { id: 'hole1', kind: 'hole', type: 'counterbore' },
      { id: 'hole2', kind: 'hole', type: 'countersink' },
      { id: 'clones1', kind: 'clones' },
    ],
  )

  it("gives a hole's owned operations the hole type of their role, never facing or pocket", () => {
    expect(partOperationIcon(p, drill)).toBe('hole-simple')
    expect(partOperationIcon(p, cb)).toBe('hole-counterbore')
    expect(partOperationIcon(p, cs)).toBe('hole-countersink')
  })

  it('gives a chamfer the chamfer icon and a clone instance its source operation icon', () => {
    expect(partOperationIcon(p, chamfer)).toBe('chamfer')
    expect(partOperationIcon(p, instance)).toBe('hole-counterbore')
    expect(partOperationIcon(p, pocket)).toBe('pocket')
  })
})
