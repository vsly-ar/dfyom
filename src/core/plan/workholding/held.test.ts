// Spec: docs/modes/workholding.md#held-pieces-and-screws-in-the-part-w5 (v0.4-llm-first W5)
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../checks'
import { opsOf, planSetup, type PlanSetup } from '../plan.fixture'

// the test part (design.fixture.ts): 100 × 60 × 20 block, outline profile1 round 8–92 × 8–52
const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings
const codes = (s: PlanSetup, planId: string, ...of: string[]) =>
  warnings(s, planId).filter((w) => of.includes(w.code))

const clamp = { kind: 'toeClamp', edge: 'vMin', at: '30', grip: '5', top: '20' }
const screw = (x: string, y: string) => ({ kind: 'screw', center: [x, y] })

async function plan(opts: { tabs?: boolean } = {}) {
  const s = await planSetup()
  if (opts.tabs === false)
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      tabs: { count: '0' },
    })
  await s.run('project.apply', {})
  const planId = await s.create()
  const setupId = s.plan(planId).setups[0]!.id
  const set = (items: object[], extra: object = {}) =>
    s.run('plan.workholding.set', { planId, setupId, items, ...extra })
  return { s, planId, setupId, set }
}

describe('plan.workholding.partLoose (W5)', () => {
  it('an outline without tabs comes loose under clamps; tape, a screw inside or tabs hold it', async () => {
    const { s, planId, setupId, set } = await plan({ tabs: false })
    // no items: today's behaviour, the info only
    expect(codes(s, planId, 'plan.workholding.partLoose')).toEqual([])
    const r = (await set([clamp])) as { findings: PlanWarning[] }
    const loose = {
      code: 'plan.workholding.partLoose',
      severity: 'warning',
      planOperationId: opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'profile1')!
        .id,
      rule: 'partLoose',
      params: { setupId, profile: 'profile1', side: 'outside' },
    }
    // in the set result at once (static) and in plan.warning.list
    expect(r.findings.filter((f) => f.code === loose.code)).toMatchObject([loose])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toMatchObject([loose])
    expect(codes(s, planId, 'plan.workholding.partLoose')[0]!.message).toContain(
      'cuts the part free in Top without tabs',
    )
    // a surface hold keeps every piece cut free held
    await set([clamp, { kind: 'surface', type: 'tape' }])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toEqual([])
    // a screw inside the part holds it (and is in the part)
    await set([clamp, screw('30', '20')])
    expect(codes(s, planId, 'plan.workholding.partLoose', 'plan.workholding.inPart')).toMatchObject(
      [{ code: 'plan.workholding.inPart' }],
    )
    // a screw in the waste does not
    await set([clamp, screw('3', '30')])
    expect(codes(s, planId, 'plan.workholding.partLoose', 'plan.workholding.inPart')).toMatchObject(
      [{ code: 'plan.workholding.partLoose' }],
    )
  })

  it('tabs hold the part: no partLoose', async () => {
    const { s, planId, set } = await plan()
    await set([clamp])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toEqual([])
  })

  it('a slug without tabs comes loose; a screw inside the slug holds it', async () => {
    const { s, planId, setupId, set } = await plan()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['70', '30'], diameter: '16' },
      side: 'inside',
      slotWidth: '6',
      tabs: { count: '0' },
    })
    await s.run('project.apply', {})
    await set([clamp])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toMatchObject([
      { params: { setupId, profile: 'profile2', side: 'inside' } },
    ])
    expect(codes(s, planId, 'plan.workholding.partLoose')[0]!.message).toContain(
      'cuts the slug free',
    )
    // the screw in the slug is in the waste: it holds the slug and is not in the part
    await set([clamp, screw('70', '30')])
    expect(codes(s, planId, 'plan.workholding.partLoose', 'plan.workholding.inPart')).toEqual([])
  })

  it('a vise holds a piece whose loop runs off both gripped sides', async () => {
    const { s, planId, set } = await plan({ tabs: false })
    // the outline trimmed to run off the left and right sides (the jaws close along X)
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      shape: { kind: 'rectangle', center: ['50', '30'], length: '120', width: '44' },
    })
    await s.run('project.apply', {})
    await set([{ kind: 'vise', axis: 'u' }])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toEqual([])
    await set([{ kind: 'vise', axis: 'v' }])
    expect(codes(s, planId, 'plan.workholding.partLoose')).toHaveLength(1)
  })
})

describe('plan.workholding.inPart (W5)', () => {
  it('a screw whose head meets the part warns; in the waste or off the stock it does not', async () => {
    const { s, planId, setupId, set } = await plan()
    await set([clamp, screw('20', '30')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toMatchObject([
      {
        severity: 'warning',
        rule: 'inPart',
        params: { setupId, itemId: 'wh2' },
        message: expect.stringContaining('Screw 1 in Top goes through the part'),
      },
    ])
    // head Ø 8 at X4: its rim touches the outline at X8, wholly in the waste
    await set([clamp, screw('4', '30')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toEqual([])
    // Ø 10 at X4 reaches 1 mm into the part
    await set([clamp, { ...screw('4', '30'), headDiameter: '10' }])
    expect(codes(s, planId, 'plan.workholding.inPart')).toHaveLength(1)
    await set([clamp, screw('-10', '30')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toEqual([])
  })

  it('without a through outline the whole block is the part', async () => {
    const { s, planId, set } = await plan()
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      side: 'on',
      depth: '2',
    })
    await s.run('project.apply', {})
    await set([clamp, screw('3', '30')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toHaveLength(1)
  })

  it('reads the screw in the setup frame of a rotated setup', async () => {
    const { s, planId, setupId, set } = await plan()
    // unrotated, (57, 50) is inside the outline (8–92 × 8–52)
    await set([clamp, screw('57', '50')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toHaveLength(1)
    // turned 90°: the setup's X runs along the face's v; (57, 50) is face (50, 3), in the waste
    await s.run('plan.setup.update', { planId, setupId, rotation: 90 })
    await set([{ ...clamp, at: '20' }, screw('57', '50')])
    expect(codes(s, planId, 'plan.workholding.inPart')).toEqual([])
  })
})

describe('surface holds (W5)', () => {
  it('a setup held on a surface leaves out plan.loosePiece', async () => {
    const { s, planId, setupId, set } = await plan()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['70', '30'], diameter: '16' },
      side: 'inside',
      slotWidth: '6',
      tabs: { count: '0' },
    })
    await s.run('project.apply', {})
    const outlineOp = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'profile1')!
    await s.run('plan.operation.move', { planId, planOperationId: outlineOp.id, toIndex: 0 })
    expect(codes(s, planId, 'plan.loosePiece').length).toBeGreaterThan(0)
    await set([{ kind: 'surface', type: 'vacuum' }])
    expect(codes(s, planId, 'plan.loosePiece', 'plan.workholding.partLoose')).toEqual([])
    // the setup with the hold only: a clamp instead brings the warning back
    await set([clamp])
    expect(codes(s, planId, 'plan.loosePiece').length).toBeGreaterThan(0)
    expect(setupId).toBeDefined()
  })

  it('refuses a second surface, parameters of another kind and an unknown type', async () => {
    const { s, planId, setupId } = await plan()
    const tape = { kind: 'surface', type: 'tape' }
    const e = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, items: [tape, { kind: 'surface', type: 'glue' }] },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['items', 1, 'kind'] })
    const bad = async (item: object) =>
      (
        await s.failWith(
          'plan.workholding.set',
          { planId, setupId, items: [item] },
          'input.malformed',
        )
      ).issues[0]!.rule
    expect(await bad({ ...tape, top: '5' })).toBe('notForKind')
    expect(await bad({ kind: 'surface', type: 'magnet' })).toBeDefined()
  })
})
