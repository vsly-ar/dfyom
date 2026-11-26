// Spec: the first real hardwood cut (docs/research/2026-11-24-hardwood-tearout.md § 1) against
// docs/modes/plan-v0.1.md#reach-and-rigidity-warnings-hardening-df73-df75,
// docs/modes/plan-v0.1.md#finishing-defaults-hardening-df75-df76 and
// docs/architecture/feeds-speeds.md#finishing-pass-feed-hardening-df74, with the user's Setup 2
// numbers: "Finishing 1/4″ 3F" (Ø6.33, 20 mm flutes, stickout 31.7) on a 30.54 mm cavity,
// "extralong 1/4″" 2F (Ø6.31, 50 mm flutes) at 62 mm stickout on the outline, a 3000 mm/min
// GRBL router (spindle 6200–29 300 rpm, 800 W), hardwood stock.
import { describe, expect, it } from 'vitest'
import { feed, len, libraryInput, machineValues, num, rpm, watt } from '../library/library.fixture'
import type { PlanWarning } from './checks'
import { flat6, planSetup, type PlanSetup } from './plan.fixture'

const finishing3F = () => ({
  ...flat6(),
  name: 'Finishing 1/4" 3F',
  diameter: len('6.33'),
  fluteLength: len('20'),
  overallLength: len('50'),
  stickout: len('31.7'),
  fluteCount: num('3'),
  presets: [],
})
const extralong2F = () => ({
  ...flat6(),
  name: 'extralong 1/4"',
  diameter: len('6.31'),
  fluteLength: len('50'),
  overallLength: len('76'),
  stickout: len('62'),
  fluteCount: num('2'),
  presets: [],
})
const nova = () => {
  const { kind: _, ...m } = machineValues()
  return {
    ...m,
    name: '3020 Nova',
    rigidity: 'fixedGantry' as const,
    maxFeedRate: { x: feed('3000'), y: feed('3000'), z: feed('1000') },
    spindle: {
      control: 'manual' as const,
      minSpeed: rpm('6200'),
      maxSpeed: rpm('29300'),
      power: watt('800'),
    },
  }
}

interface Case {
  readonly s: PlanSetup
  readonly planId: string
  readonly cavity: string
  readonly outline: string
}

/** Setup 2: the 30.54 mm cavity and a through outline of a 31 mm hardwood board. */
async function setup2(): Promise<Case> {
  const s = await planSetup({
    part: false,
    stock: {
      name: 'Hardwood',
      shape: 'block',
      length: '250',
      width: '100',
      thickness: '31',
      material: { name: 'Walnut', class: 'hardwood' },
    },
  })
  const add = async (kind: string, values: object) =>
    ((await s.run(`library.${kind}.add`, { values: libraryInput(values) })) as { id: string }).id
  const t3 = await add('tool', finishing3F())
  const t2 = await add('tool', extralong2F())
  const machine = await add('machine', nova())
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['125', '50'],
      length: '200',
      width: '60',
      cornerRadius: '6',
    },
    depth: '30.54',
    floorRadius: '0',
  })
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['125', '50'],
      length: '230',
      width: '84',
      cornerRadius: '5',
    },
    slotWidth: '7',
    tabs: { count: '4', width: '8', thickness: '3' },
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: machine })
  const ops = s.plan(planId).setups[0]!.operations
  const byKind = (kind: string) =>
    ops.find(
      (o) => s.part().operations.find((d) => d.id === o.designOperationIds[0])?.kind === kind,
    )!.id
  const cavity = byKind('pocket')
  const outline = byKind('profile')
  await s.run('plan.tool.assign', { planId, planOperationId: cavity, toolLibraryItemId: t3 })
  await s.run('plan.tool.assign', { planId, planOperationId: outline, toolLibraryItemId: t2 })
  return { s, planId, cavity, outline }
}

const findings = (c: Case, op: string) =>
  (
    c.s.query('plan.warning.list', { planId: c.planId }) as { warnings: PlanWarning[] }
  ).warnings.filter((w) => w.planOperationId === op)
const strategyOf = (c: Case, op: string) =>
  (
    c.s.query('plan.operation.list', { planId: c.planId }) as {
      operations: { id: string; strategy: Record<string, number | string> }[]
    }
  ).operations.find((o) => o.id === op)!.strategy

describe('the first hardwood cut (DF73–DF76)', () => {
  it('DF73: 62 mm stickout for a 31.5 mm cut warns with the deflection factor; 31.7 mm does not', async () => {
    const c = await setup2()
    const excess = findings(c, c.outline).filter((w) => w.rule === 'excessStickout')
    expect(excess).toHaveLength(1)
    const w = excess[0]!
    expect(w).toMatchObject({ code: 'plan.check', severity: 'warning', field: 'stickout' })
    // through 31 mm + 0.5 mm breakthrough; needed 36.5 mm; (62 / 36.5)³ ≈ 4.9
    expect(Number(w.params['depth'])).toBeCloseTo(31.5, 6)
    expect(Number(w.params['needed'])).toBeCloseTo(36.5, 6)
    expect(Number(w.params['factor'])).toBeCloseTo((62 / 36.5) ** 3, 6)
    expect(w.params['suggested']).toBe(37)
    expect(w.message).toContain('4.9×')
    expect(w.message).toContain('chuck the tool deeper, about 37 mm')
    expect(w.message).toContain('the collet then grips the flutes')
    expect(findings(c, c.cavity).map((f) => f.rule)).not.toContain('excessStickout')
    // chucked at 37 mm: quiet
    await c.s.run('plan.operation.update', {
      planId: c.planId,
      planOperationId: c.outline,
      stickout: '37',
    })
    expect(findings(c, c.outline).map((f) => f.rule)).not.toContain('excessStickout')
  })

  it('DF75: the 30.54 mm cavity is deeper than the 20 mm flutes (warning); finishing stays within them', async () => {
    const c = await setup2()
    const rub = findings(c, c.cavity).filter((w) => w.rule === 'shankRub')
    expect(rub).toHaveLength(1)
    expect(rub[0]).toMatchObject({ code: 'plan.check', severity: 'warning', field: 'tool' })
    expect(rub[0]!.params).toEqual({ depth: 30.54, fluteLength: 20 })
    // a warning never blocks: no error findings on the cavity
    expect(findings(c, c.cavity).filter((w) => w.severity === 'error')).toEqual([])
    // DF75/DF76 default: min(30.54, 20 flutes, 2 × 6.33 in wood)
    expect(Number(strategyOf(c, c.cavity)['finishStepdown'])).toBeCloseTo(12.66, 6)
  })

  it('DF76: wood finishing defaults: 0.5 mm allowance, profile finish stepdown ≤ 2 D', async () => {
    const c = await setup2()
    expect(Number(strategyOf(c, c.cavity)['finishAllowance'])).toBeCloseTo(0.5, 9)
    expect(Number(strategyOf(c, c.outline)['finishAllowance'])).toBeCloseTo(0.5, 9)
    expect(Number(strategyOf(c, c.outline)['finishStepdown'])).toBeCloseTo(12.62, 6)
    // an entered value wins
    await c.s.run('plan.operation.update', {
      planId: c.planId,
      planOperationId: c.cavity,
      strategy: { finishAllowance: '0.2' },
    })
    expect(Number(strategyOf(c, c.cavity)['finishAllowance'])).toBeCloseTo(0.2, 9)
  })

  it('DF74: at 0.2 mm the finish feed is held at 3000 mm/min and rubs; the message names fixes', async () => {
    const c = await setup2()
    const feeds = () =>
      c.s.query('plan.operation.feeds.get', { planId: c.planId, planOperationId: c.cavity }) as {
        fields: { spindleSpeed: { value: number }; feedRate: { value: number } }
        finish: { allowance: number; feedRate: number; fz: number; clamped: boolean } | null
      }
    // the research's numbers: 3000 mm/min, rpm lowered to keep 0.157 mm/tooth
    const f0 = feeds()
    expect(f0.fields.feedRate.value).toBeCloseTo(3000, 6)
    expect(f0.fields.spindleSpeed.value).toBeCloseTo(
      3000 / (3 * (0.127 + 0.6 * (0.1778 - 0.127))),
      3,
    )
    // the 0.5 mm wood default: held at the limit, 0.085 mm (over half the 0.127 mm minimum)
    expect(f0.finish).toMatchObject({ allowance: 0.5, feedRate: 3000, clamped: true })
    expect(f0.finish!.fz).toBeCloseTo(0.085, 3)
    expect(findings(c, c.cavity).map((w) => w.rule)).not.toContain('finishRubbing')

    await c.s.run('plan.operation.update', {
      planId: c.planId,
      planOperationId: c.cavity,
      strategy: { finishAllowance: '0.2' },
    })
    expect(feeds().finish!.fz).toBeCloseTo(0.055, 3)
    const rub = findings(c, c.cavity).filter((w) => w.rule === 'finishRubbing')
    expect(rub).toHaveLength(1)
    expect(rub[0]).toMatchObject({
      code: 'feeds.rubbing',
      severity: 'warning',
      field: 'spindleSpeed',
    })
    expect(rub[0]!.params).toMatchObject({
      finishAllowance: 0.2,
      finishFeedRate: 3000,
      minimum: 0.127,
      allowanceForMinimum: 1.3,
      flutesForMinimum: 1,
    })
    // the spindle would need about 2750 rpm, below its 6200 rpm minimum: not offered
    expect(rub[0]!.params['spindleSpeedForMinimum']).toBeUndefined()
    // D4: plan.warning.list names the operation first
    expect(rub[0]!.message).toBe(
      `Pocket 1 (${rub[0]!.planOperationId}): ` +
        "Finishing pass rubs: radial chip thinning at the 0.2 mm finishing allowance leaves 0.055 mm chips, under the 0.127 mm minimum, and the machine's 3000 mm/min feed limit (X/Y) stops a faster finishing feed. A finishing allowance of at least 1.3 mm or a tool with 1 flute at this spindle speed makes a real chip.",
    )
  })

  it('DF74: the finishing passes of the generated toolpath run at the finishing feed', async () => {
    const c = await setup2()
    const inputs = (await import('./inputs')).planOperationInputs(c.s.d.doc, c.planId, [c.cavity])
    const feeds = inputs.unwrap()[0]!.feeds
    expect(feeds.finish.unwrap().feedRate).toBeCloseTo(3000, 6)
  })
})
