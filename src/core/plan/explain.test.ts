// Spec: docs/modes/plan-v0.1.md#commands-and-queries-v01 (`plan.operation.feeds.get`): the
// calculator's inputs, each field's source with the derivation of calculator values, and the
// derived values (surface speed, chip thinning, power) at the values that will be used.
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { actf, effectiveDiameter } from '../feeds-speeds/formulas'
import { opsOf, planSetup } from './plan.fixture'

interface Step {
  step: string
  formula: string
  inputs: Record<string, number | string>
  result: number
  unit: string
}
interface Explained {
  auto: 'on' | 'off' | { unavailable: string }
  inputs: {
    materialClass: string
    toolMaterial: string | null
    diameter: number
    fluteCount: number
    cornerRadius: number
    engagement: { kind: string; ae?: number; ap?: number }
    rigidity: string
    spindlePower: number | null
  } | null
  fields: Record<
    string,
    { value: number; unit: string; source: string; derivation: Step[] | null } | null
  >
  used: {
    dCalc: number
    vc: number
    fz: number
    chipThinning: number
    Q: number | null
    Pc: number | null
    spindleLoad: number | null
  } | null
}

async function setup() {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const id = (design: string) =>
    opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === design)!.id
  const explain = (planOperationId: string) =>
    s.query('plan.operation.feeds.get', { planId, planOperationId }) as Explained
  const update = (planOperationId: string, args: object) =>
    s.run('plan.operation.update', { planId, planOperationId, ...args })
  return { s, planId, id, explain, update }
}

describe('plan.operation.feeds.get', () => {
  it('auto mode: inputs, the derivation of every calculator field, and the values at use', async () => {
    const { id, explain, update } = await setup()
    const pocket = id('pocket1')
    await update(pocket, { auto: true })
    const e = explain(pocket)
    expect(e.auto).toBe('on')
    expect(e.inputs).toMatchObject({
      materialClass: 'aluminum',
      toolMaterial: 'carbide',
      diameter: 6,
      fluteCount: 2,
      engagement: { kind: 'slot' },
    })
    const n = e.fields['spindleSpeed']!
    const vf = e.fields['feedRate']!
    expect(n.source).toBe('calculator')
    expect(n.derivation!.map((d) => d.step)).toContain('data')
    expect(vf.derivation!.map((d) => d.step)).toContain('F2')
    expect(vf.derivation!.every((d) => d.formula.length > 0)).toBe(true)
    // stepover is the strategy's in v0.1: no derivation
    expect(e.fields['stepover']).toMatchObject({ source: 'strategy', derivation: null })
    // the display values follow the fields' values (the bull nose: axial chip thinning only)
    const used = e.used!
    const ap = e.fields['stepdown']!.value
    const RE = e.inputs!.cornerRadius
    expect(used.chipThinning).toBeCloseTo(actf(RE, ap), 12)
    expect(used.dCalc).toBeCloseTo(effectiveDiameter(6, RE, ap), 12)
    expect(used.vc).toBeCloseTo((Math.PI * used.dCalc * n.value) / 1000, 9)
    expect(used.fz).toBeCloseTo(vf.value / (n.value * 2 * used.chipThinning), 12)
    expect(used.Q).toBeCloseTo(6 * ap * vf.value, 6)
    expect(used.Pc).not.toBeNull()
  })

  it('preset mode: no derivation, the values at use still computed from the preset values', async () => {
    const { id, explain } = await setup()
    const e = explain(id('pocket1'))
    expect(e.auto).toBe('off')
    expect(e.fields['spindleSpeed']).toMatchObject({ source: 'preset', derivation: null })
    expect(e.used!.vc).toBeCloseTo(
      (Math.PI * e.used!.dCalc * e.fields['spindleSpeed']!.value) / 1000,
      9,
    )
  })

  it('an entered value changes the values at use, not the derivation of the others', async () => {
    const { id, explain, update } = await setup()
    const pocket = id('pocket1')
    await update(pocket, { auto: true })
    const before = explain(pocket)
    await update(pocket, { overrides: { feedRate: '400' } })
    const after = explain(pocket)
    expect(after.fields['feedRate']).toMatchObject({
      value: 400,
      source: 'override',
      derivation: null,
    })
    expect(after.fields['spindleSpeed']).toEqual(before.fields['spindleSpeed'])
    expect(after.used!.fz).toBeCloseTo(
      400 / (after.fields['spindleSpeed']!.value * 2 * after.used!.chipThinning),
      12,
    )
  })

  it('facing: stepover engagement with chip thinning at the used stepover', async () => {
    const { id, explain, update } = await setup()
    const facing = id('facing1')
    await update(facing, { auto: true, overrides: { stepover: '1' } })
    const e = explain(facing)
    expect(e.inputs!.engagement).toEqual({ kind: 'stepover', ae: 4.5 })
    expect(e.used!.chipThinning).toBeGreaterThan(1)
  })

  it('without calculator data: the reason, no values at use', async () => {
    const { s, planId, id, explain } = await setup()
    const drilling = id('drill1')
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: drilling,
      toolLibraryItemId: s.tools.drill6,
    })
    const e = explain(drilling)
    expect(e.auto).toMatchObject({ unavailable: expect.stringMatching(/tool material/) })
    expect(e.used).toBeNull()
    expect(e.inputs).toMatchObject({ toolMaterial: null, engagement: { kind: 'drill' } })
  })

  it('an unknown plan operation is input.malformed', async () => {
    const { s, planId } = await setup()
    expectErrCode(
      s.d.query('plan.operation.feeds.get', { planId, planOperationId: 'nope' }, uiSource()),
      'input.malformed',
    )
  })
})
