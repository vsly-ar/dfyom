// Spec: docs/modes/plan-v0.1.md#locks-and-auto-mode (task 3.14), through the command layer:
// auto mode switched by the preset control, locks only in auto mode, typing never locks,
// unlocking keeps the value, impossible locks refused with their reason, inactive locks warned.
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { loadPlanDTO } from './plan'
import type { PlanOperationDTO } from './plan.dto'
import { feed } from '../library/library.fixture'
import { expectUndoRedo, opsOf, planSetup, src } from './plan.fixture'

interface FieldView {
  value: number
  source: string
  locked: boolean
  recommended: { value: number; unit: string } | null
  lock: { state: string; rule?: string; reason?: string }
}
interface OpView {
  id: string
  presetName: string | null
  auto: 'on' | 'off' | { unavailable: string }
  feeds: Record<string, FieldView | null>
}

async function setup() {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const ops = opsOf(s.plan(planId))
  const id = (design: string) => ops.find((o) => o.designOperationIds[0] === design)!.id
  const view = (planOperationId: string) =>
    (s.query('plan.operation.list', { planId }) as { operations: OpView[] }).operations.find(
      (o) => o.id === planOperationId,
    )!
  const op = (planOperationId: string): PlanOperationDTO =>
    opsOf(s.plan(planId)).find((o) => o.id === planOperationId)!
  const update = (planOperationId: string, args: object) =>
    s.run('plan.operation.update', { planId, planOperationId, ...args })
  const refuse = async (planOperationId: string, args: object, code = 'model.invariant' as const) =>
    (await s.failWith('plan.operation.update', { planId, planOperationId, ...args }, code))
      .issues[0]
  return {
    s,
    planId,
    pocket: id('pocket1'),
    facing: id('facing1'),
    helix: id('drill2'),
    view,
    op,
    update,
    refuse,
  }
}

const fieldsOf = (v: OpView, key: keyof FieldView) =>
  Object.fromEntries(Object.entries(v.feeds).map(([f, x]) => [f, x?.[key] ?? null]))

describe('auto mode', () => {
  it('a tool preset is the default: fixed values, no locks, no recommendation', async () => {
    const { pocket, view } = await setup()
    const v = view(pocket)
    expect(v.auto).toBe('off')
    expect(v.presetName).toBe('Alu finish')
    expect(fieldsOf(v, 'lock')).toEqual({
      spindleSpeed: { state: 'hidden' },
      feedRate: { state: 'hidden' },
      plungeRate: { state: 'hidden' },
      stepdown: { state: 'hidden' },
      stepover: { state: 'hidden' },
    })
    expect(v.feeds['spindleSpeed']).toMatchObject({ source: 'preset', recommended: null })
  })

  it('auto: true switches to the calculator (clears presetName, one undo step)', async () => {
    const { s, planId, pocket, view, op } = await setup()
    await expectUndoRedo(s, 'plan.operation.update', {
      planId,
      planOperationId: pocket,
      auto: true,
    })
    expect(op(pocket)).toMatchObject({ auto: true })
    expect(op(pocket).presetName).toBeUndefined()
    const v = view(pocket)
    expect(v.auto).toBe('on')
    expect(v.presetName).toBeNull()
    expect(fieldsOf(v, 'source')).toMatchObject({
      spindleSpeed: 'calculator',
      feedRate: 'calculator',
      stepdown: 'calculator',
      stepover: 'strategy',
    })
    expect(fieldsOf(v, 'lock')).toEqual({
      spindleSpeed: { state: 'available' },
      feedRate: { state: 'available' },
      plungeRate: { state: 'hidden' },
      stepdown: { state: 'available' },
      stepover: { state: 'hidden' },
    })
    expect(v.feeds['feedRate']?.recommended?.value).toBe(v.feeds['feedRate']?.value)
  })

  it('without a preset the default is auto mode; without data it is unavailable with the reason', async () => {
    const { s, planId, helix, view } = await setup()
    expect(view(helix).auto).toBe('on') // flat 4 without presets, carbide in aluminum
    const drill = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'drill1')!.id
    expect(view(drill).auto).toEqual({ unavailable: expect.stringMatching(/No feeds-and-speeds/) })
  })

  it('auto and presetName together are input.malformed', async () => {
    const { pocket, refuse } = await setup()
    expect(
      await refuse(pocket, { auto: true, presetName: 'Alu finish' }, 'input.malformed' as never),
    ).toMatchObject({ rule: 'autoAndPreset' })
  })
})

describe('locks', () => {
  it('locking a recommended field pins the shown value; the others follow it', async () => {
    const { pocket, view, op, update } = await setup()
    await update(pocket, { auto: true })
    const before = view(pocket)
    await update(pocket, { locks: { spindleSpeed: true } })
    expect(op(pocket).locked).toEqual(['spindleSpeed'])
    const pinned = Math.round(before.feeds['spindleSpeed']!.value)
    expect(src(op(pocket).overrides.spindleSpeed)).toBe(`${pinned} rpm`)
    // the locked value is the starting point: a new value moves the feed
    await update(pocket, { overrides: { spindleSpeed: '10000' } })
    const v = view(pocket)
    expect(v.feeds['spindleSpeed']).toMatchObject({
      value: 10000,
      source: 'override',
      locked: true,
    })
    expect(v.feeds['spindleSpeed']!.recommended!.value).toBeCloseTo(
      before.feeds['spindleSpeed']!.value,
      6,
    )
    expect(v.feeds['feedRate']!.value).toBeCloseTo(
      (before.feeds['feedRate']!.value * 10000) / before.feeds['spindleSpeed']!.value,
      6,
    )
  })

  it('typing never locks; an entered value applies to its field only', async () => {
    const { pocket, view, op, update } = await setup()
    await update(pocket, { auto: true })
    const before = view(pocket)
    await update(pocket, { overrides: { spindleSpeed: '10000' } })
    expect(op(pocket).locked).toBeUndefined()
    const v = view(pocket)
    expect(v.feeds['spindleSpeed']).toMatchObject({ value: 10000, locked: false })
    expect(v.feeds['feedRate']!.value).toBeCloseTo(before.feeds['feedRate']!.value, 9)
  })

  it('unlocking keeps the value as entered; clearing the value also unlocks', async () => {
    const { pocket, op, update } = await setup()
    await update(pocket, { auto: true, overrides: { feedRate: '700' }, locks: { feedRate: true } })
    expect(op(pocket).locked).toEqual(['feedRate'])
    await update(pocket, { locks: { feedRate: false } })
    expect(op(pocket).locked).toBeUndefined()
    expect(src(op(pocket).overrides.feedRate)).toBe('700')
    await update(pocket, { locks: { feedRate: true } })
    await update(pocket, { overrides: { feedRate: null } })
    expect(op(pocket).locked).toBeUndefined()
    expect(op(pocket).overrides.feedRate).toBeUndefined()
  })

  it('an impossible lock is refused with lockUnavailable and the reason', async () => {
    const { pocket, update, refuse } = await setup()
    await update(pocket, { auto: true })
    expect(
      await refuse(pocket, { overrides: { spindleSpeed: '40000' }, locks: { spindleSpeed: true } }),
    ).toMatchObject({
      path: ['locks', 'spindleSpeed'],
      rule: 'lockUnavailable',
      message: "40000 rpm is above this machine's 30000 rpm.",
      params: { reason: 'spindleRange' },
    })
    expect(await refuse(pocket, { locks: { plungeRate: true } })).toMatchObject({
      rule: 'lockUnavailable',
      params: { reason: 'notLockable' },
    })
    expect(await refuse(pocket, { locks: { stepover: true } })).toMatchObject({
      params: { reason: 'notLockable' },
    })
  })

  it('outside auto mode there are no locks', async () => {
    const { facing, refuse } = await setup()
    expect(await refuse(facing, { locks: { spindleSpeed: true } })).toMatchObject({
      rule: 'lockUnavailable',
      params: { reason: 'autoOff' },
    })
  })

  it('locking in the default auto mode makes auto a choice', async () => {
    const { helix, op, update } = await setup()
    expect(op(helix).auto).toBeUndefined()
    await update(helix, { locks: { feedRate: true } })
    expect(op(helix)).toMatchObject({ auto: true, locked: ['feedRate'] })
  })

  it('facing stepover has a lock; choosing a preset or leaving auto clears the locks, entries stay', async () => {
    const { facing, view, op, update } = await setup()
    await update(facing, { auto: true })
    expect(view(facing).feeds['stepover']?.lock).toEqual({ state: 'available' })
    await update(facing, { locks: { stepover: true, spindleSpeed: true } })
    expect(op(facing).locked).toEqual(['spindleSpeed', 'stepover'])
    await update(facing, { presetName: 'Alu finish' })
    expect(op(facing).locked).toBeUndefined()
    expect(op(facing).auto).toBeUndefined()
    expect(op(facing).overrides.spindleSpeed).toBeDefined()
    await update(facing, { auto: true, locks: { spindleSpeed: true } })
    await update(facing, { auto: false })
    expect(op(facing).locked).toBeUndefined()
    expect(op(facing).auto).toBeUndefined()
  })

  it('a stored lock a later change breaks is inactive: feeds.lockInactive on the field', async () => {
    const { s, planId, pocket, view, update } = await setup()
    await update(pocket, { auto: true, overrides: { stepdown: '20' }, locks: { stepdown: true } })
    await update(pocket, { stickout: '15' })
    const w = (
      s.query('plan.warning.list', { planId }) as {
        warnings: {
          code: string
          field?: string
          rule: string
          planOperationId?: string
          message: string
        }[]
      }
    ).warnings.find((x) => x.code === 'feeds.lockInactive' && x.planOperationId === pocket)
    expect(w).toMatchObject({ field: 'stepdown', rule: 'toolLength' })
    // D4: plan.warning.list names the operation first
    expect(w?.message).toBe(
      `Pocket 1 (${pocket}): ` +
        'Stepdown lock is inactive: Stepdown 20 mm is deeper than the stickout (15 mm).',
    )
    expect(view(pocket).feeds['stepdown']).toMatchObject({
      locked: true,
      lock: { state: 'unavailable', rule: 'toolLength' },
    })
  })
})

describe('invariants', () => {
  it('a record with locks outside auto mode does not load (model.invariant)', async () => {
    const { s, planId, pocket } = await setup()
    const plan = structuredClone(s.plan(planId))
    const target = opsOf(plan).find((o) => o.id === pocket)!
    target.overrides = { ...target.overrides, feedRate: feed('700') }
    target.locked = ['feedRate']
    const r = loadPlanDTO(plan, 'mm', 'test')
    expect(r.isErr() && r.unwrapErr().code).toBe('model.invariant')
    expect(r.unwrapErr().issues.map((i) => i.rule)).toEqual(['lockOutsideAuto'])
    target.auto = true
    expectOk(loadPlanDTO(plan, 'mm', 'test'))
  })
})
