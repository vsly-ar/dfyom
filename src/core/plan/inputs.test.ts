// Spec: the toolpath seam of docs/modes/plan-v0.1.md (Implementation (task 2.13)).
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { planOperationInputs } from './inputs'
import { planSetup } from './plan.fixture'

describe('planOperationInputs (seam for 2.9/2.10)', () => {
  it('fails with plan.check while an operation has error findings; then resolves every input', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const e = expectErrCode(planOperationInputs(s.d.doc, planId), 'plan.check')
    expect(e.issues.some((i) => i.rule === 'unresolved')).toBe(true)
    // the 6 mm drill has no data: give its operations speeds
    const drills = s
      .plan(planId)
      .setups[0]!.operations.filter((o) => o.designOperationIds[0]!.startsWith('drill'))
    for (const op of drills)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
    const inputs = expectOk(planOperationInputs(s.d.doc, planId))
    expect(inputs.map((i) => i.kind)).toEqual([
      'facing',
      'drilling',
      'drilling',
      'drilling',
      'pocket',
      'profile',
    ])
    const facing = inputs[0]!
    expect(facing).toMatchObject({
      setup: { workOffset: 'G54', clearanceHeight: 10, retractHeight: 2 },
      stickout: 25,
      strategy: { kind: 'facing', pattern: 'zigzag', overshoot: 1 },
    })
    expect(facing.feeds.fields.feedRate.unwrap()).toMatchObject({ value: 800, source: 'preset' })
    expect(facing.machine.isSome()).toBe(true)
    // a subset; the hash changes with any input of the operation
    const only = expectOk(planOperationInputs(s.d.doc, planId, [facing.planOperationId]))
    expect(only.map((i) => i.inputHash)).toEqual([facing.inputHash])
    await s.run('plan.operation.update', {
      planId,
      planOperationId: facing.planOperationId,
      strategy: { overshoot: '2' },
    })
    const changed = expectOk(planOperationInputs(s.d.doc, planId, [facing.planOperationId]))
    expect(changed[0]!.inputHash).not.toBe(facing.inputHash)
    expect(changed[0]!.strategy).toMatchObject({ overshoot: 2 })
    // strategy defaults depend on the unit system (overshoot 1 mm vs 0.04"): so does the hash
    const inch = expectOk(
      planOperationInputs({ ...s.d.doc, unitSystem: 'inch' }, planId, [facing.planOperationId]),
    )
    const mm = expectOk(planOperationInputs(s.d.doc, planId, [facing.planOperationId]))
    expect(inch[0]!.inputHash).not.toBe(mm[0]!.inputHash)
  })
})
