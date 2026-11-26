// Setup panel helpers (v0.2 task F6, model.ts): the WCS corner named by part faces, the window's
// setup, operation steps across setups of one direction, per-setup export blocking.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import {
  currentSetup,
  isError,
  isWarning,
  operationStep,
  roughingBefore,
  setupCorner,
  setupExportBlocked,
} from './model'

const stock = { length: 100, width: 60, thickness: 20 }
const height = { value: '5', unit: 'mm' } as unknown as SetupDTO['clearanceHeight']

const setup = (id: string, ops: string[], extra: Partial<SetupDTO> = {}): SetupDTO => ({
  id,
  name: id,
  workOffset: 'G54',
  clearanceHeight: height,
  retractHeight: height,
  operations: ops.map((o) => ({ id: o, designOperationIds: [o], overrides: {}, strategy: {} })),
  ...extra,
})

const plan = (setups: SetupDTO[]) => ({ setups }) as unknown as PlanDTO

describe('setupCorner', () => {
  it('names the part corner of the work zero by the faces meeting there', () => {
    expect(setupCorner(setup('a', []), stock)).toBe('front left')
    expect(setupCorner(setup('a', [], { direction: '-z' }), stock)).toBe('back left')
    expect(setupCorner(setup('a', [], { direction: '+x' }), stock)).toBe('bottom front')
    expect(setupCorner(setup('a', [], { direction: '-y' }), stock)).toBe('bottom left')
    // a turned setup: the work zero moves to the lower-left corner of the turned face
    expect(setupCorner(setup('a', [], { rotation: 90 }), stock)).toBe('back left')
    expect(setupCorner(setup('a', [], { rotation: 180 }), stock)).toBe('back right')
    expect(setupCorner(setup('a', [], { rotation: 270 }), stock)).toBe('front right')
  })
})

describe('currentSetup', () => {
  const p = plan([setup('s1', ['a']), setup('s2', ['b', 'c'])])
  it('follows the selection, then the last selection, else the first setup', () => {
    expect(currentSetup(p, null, undefined).id).toBe('s1')
    expect(currentSetup(p, 's2', undefined).id).toBe('s2')
    expect(currentSetup(p, 'c', 's1').id).toBe('s2')
    expect(currentSetup(p, null, 'b').id).toBe('s2')
    expect(currentSetup(p, null, 'gone').id).toBe('s1')
  })
})

describe('operationStep', () => {
  const p = plan([
    setup('bottom', ['a'], { direction: '-z' }),
    setup('top', ['b', 'c']),
    setup('top2', ['d']),
  ])
  it('moves within a setup and across into a neighbouring setup of the same direction only', () => {
    expect(operationStep(p, 'b', 1)).toEqual({ toIndex: 1 })
    expect(operationStep(p, 'c', 1)).toEqual({ toSetupId: 'top2', toIndex: 0 })
    expect(operationStep(p, 'd', -1)).toEqual({ toSetupId: 'top', toIndex: 2 })
    expect(operationStep(p, 'b', -1)).toBeUndefined()
    expect(operationStep(p, 'a', 1)).toBeUndefined()
    expect(operationStep(p, 'd', 1)).toBeUndefined()
  })
})

describe('setupExportBlocked', () => {
  const s1 = setup('s1', ['a'])
  const s2 = setup('s2', ['b'])
  const w = (extra: Partial<PlanWarning>): PlanWarning => ({
    code: 'plan.check',
    severity: 'error',
    message: 'x',
    rule: 'r',
    params: {},
    ...extra,
  })
  it('blocks on its own operations’ errors and plan-wide errors not about another setup', () => {
    expect(setupExportBlocked([w({ planOperationId: 'b' })], s1)).toBe(false)
    expect(setupExportBlocked([w({ planOperationId: 'b' })], s2)).toBe(true)
    expect(setupExportBlocked([w({ planOperationId: 'a', severity: 'warning' })], s1)).toBe(false)
    expect(setupExportBlocked([w({ params: { setupId: 's2' } })], s1)).toBe(false)
    expect(setupExportBlocked([w({})], s1)).toBe(true)
  })
})

describe('finding severity', () => {
  it('counts only `warning` findings as warnings; `info` is a note', () => {
    const f = (severity: PlanWarning['severity']) => ({ severity }) as PlanWarning
    expect([f('error'), f('warning'), f('info')].map(isWarning)).toEqual([false, true, false])
    expect([f('error'), f('warning'), f('info')].map(isError)).toEqual([true, false, false])
  })
})

describe('roughingBefore (DF122 R2: the "rest" chip)', () => {
  const part = {
    operations: [
      { id: 'pocket1_roughing', kind: 'pocket', roughing: true, roughingOf: 'pocket1' },
      { id: 'pocket1', kind: 'pocket', roughingPass: {} },
      { id: 'p_roughing', kind: 'pocket', roughing: true, featureId: 'p', featureRole: 'roughing' },
      { id: 'p_pocket', kind: 'pocket', featureId: 'p', featureRole: 'pocket' },
      { id: 'pocket2', kind: 'pocket' },
    ],
  }
  const withPart = (setups: SetupDTO[]) => ({ setups, design: { part } }) as unknown as PlanDTO
  const op = (p: PlanDTO, id: string) =>
    p.setups.flatMap((x) => x.operations).find((o) => o.id === id)!

  it('names the roughing that comes earlier in the machining order, a pocket’s or a pattern’s', () => {
    const p = withPart([
      setup('a', ['pocket1_roughing', 'p_roughing']),
      setup('b', ['pocket1', 'p_pocket', 'pocket2']),
    ])
    expect(roughingBefore(p, op(p, 'pocket1'))?.id).toBe('pocket1_roughing')
    expect(roughingBefore(p, op(p, 'p_pocket'))?.id).toBe('p_roughing')
    expect(roughingBefore(p, op(p, 'pocket2'))).toBeUndefined()
    expect(roughingBefore(p, op(p, 'pocket1_roughing'))).toBeUndefined()
  })

  it('none when the owner was moved before its roughing (it then cuts everything)', () => {
    const p = withPart([setup('a', ['pocket1', 'pocket1_roughing'])])
    expect(roughingBefore(p, op(p, 'pocket1'))).toBeUndefined()
  })
})
