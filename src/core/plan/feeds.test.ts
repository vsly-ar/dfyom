// Spec: docs/modes/plan-v0.1.md#feeds-and-speeds (resolution order, source per field) against the
// shipped carbide data (docs/architecture/feeds-speeds.md#material-data-v01).
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some, type Option } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { feed, len, qty, rpm } from '../library/library.fixture'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { Quantity } from '../quantity/quantity'
import {
  feedModeIssues,
  lockableFields,
  pickPreset,
  resolveFeeds,
  type FeedsInput,
  type ResolvedFeed,
} from './feeds'
import type { PlanOperationDTO } from './plan.dto'
import { drill6, drillPreset, flat6 } from './plan.fixture'

function tool(values: object): Tool {
  return expectOk(
    parseWith(ToolValuesDtoSchema, { kind: 'tool', ...values }, 'test').andThen((d) =>
      Tool.fromDTO(d),
    ),
  )
}
const noPreset = () => tool({ ...flat6(), presets: [] })
const q = (dto: ReturnType<typeof qty>) => expectOk(Quantity.fromDTO(dto))

function input(over: Partial<FeedsInput> = {}): FeedsInput {
  return {
    kind: 'pocket',
    tool: noPreset(),
    preset: None,
    overrides: {},
    materialClass: 'aluminum',
    machine: None,
    auto: true,
    ...over,
  }
}
const val = (f: Option<ResolvedFeed>) => f.unwrap().value
const src = (f: Option<ResolvedFeed>) => f.map((v) => v.source).unwrapOr(null as never)

// Aluminum, carbide, D ≤ 6 mm band: vc 500 SFM = 152.4 m/min, fz .001" = 0.0254 mm, apSlot 0.5,
// kPlunge 0.25; lowest rigidity (no machine): range low end, apFactor 0.3.
const N6 = (152.4 * 1000) / (Math.PI * 6)
const VF6 = N6 * 2 * 0.0254

describe('resolveFeeds: resolution order and source', () => {
  it('without preset or override: calculator speeds and stepdown, strategy stepover', () => {
    const r = resolveFeeds(input())
    expect(val(r.fields.spindleSpeed)).toBeCloseTo(N6, 6)
    expect(val(r.fields.feedRate)).toBeCloseTo(VF6, 6)
    expect(val(r.fields.plungeRate)).toBeCloseTo(0.25 * VF6, 6)
    expect(val(r.fields.stepdown)).toBeCloseTo(0.5 * 6 * 0.3, 9)
    expect(val(r.fields.stepover)).toBeCloseTo(0.4 * 6, 9) // pocket fallback 0.4 D
    expect(Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, src(v)]))).toEqual({
      spindleSpeed: 'calculator',
      feedRate: 'calculator',
      plungeRate: 'calculator',
      stepdown: 'calculator',
      stepover: 'strategy',
    })
    expect(r.fields.feedRate.unwrap().derivation?.length).toBeGreaterThan(0)
    expect(r.engagement).toEqual({ kind: 'slot' })
    expect(r.chipLoad.unwrap()).toBeCloseTo(0.0254, 9)
  })

  it('a preset wins over the calculator for every field it has', () => {
    const t = tool(flat6())
    const r = resolveFeeds(
      input({ tool: t, preset: pickPreset(t, 'aluminum', undefined), auto: false }),
    )
    expect(r.auto).toBe('off')
    expect(r.fields.spindleSpeed.unwrap()).toMatchObject({ value: 18000, source: 'preset' })
    expect(r.fields.feedRate.unwrap()).toMatchObject({ value: 800, source: 'preset' })
    expect(r.fields.plungeRate.unwrap()).toMatchObject({ value: 200, source: 'preset' })
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 1, source: 'preset' })
    expect(r.fields.stepover.unwrap()).toMatchObject({ value: 3, source: 'preset' })
    // calculator unused; the final-value check still sees the preset's chip load
    // (800 / (18 000 · 2) = 0.022 mm < the 0.0254 mm data minimum)
    expect(r.warnings.map((w) => [w.code, w.field])).toEqual([['feeds.rubbing', 'feedRate']])
    expect(r.locks.spindleSpeed).toEqual({ state: 'hidden' })
    expect(r.recommended.spindleSpeed.isNone()).toBe(true)
  })

  it('an override wins over the preset; the rest keeps its source', () => {
    const t = tool(flat6())
    const r = resolveFeeds(
      input({
        tool: t,
        preset: pickPreset(t, 'aluminum', undefined),
        auto: false,
        overrides: { feedRate: q(feed('500')), stepover: q(len('2')) },
      }),
    )
    expect(r.fields.feedRate.unwrap()).toMatchObject({ value: 500, source: 'override' })
    expect(r.fields.stepover.unwrap()).toMatchObject({ value: 2, source: 'override' })
    expect(r.fields.spindleSpeed.unwrap()).toMatchObject({ value: 18000, source: 'preset' })
  })

  it('a preset without stepdown/stepover: strategy stepdown and stepover (no calculator)', () => {
    const t = tool({
      ...flat6(),
      presets: [
        {
          name: 'Fast',
          spindleSpeed: rpm('10000'),
          feedRate: feed('600'),
          plungeRate: feed('100'),
        },
      ],
    })
    const r = resolveFeeds(
      input({ tool: t, preset: pickPreset(t, 'aluminum', undefined), auto: false }),
    )
    expect(src(r.fields.spindleSpeed)).toBe('preset')
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 1.5, source: 'strategy' })
    expect(src(r.fields.stepover)).toBe('strategy')
  })

  it('an entered (unlocked) stepdown applies to its field only', () => {
    const r = resolveFeeds(input({ overrides: { stepdown: q(len('2')) } }))
    expect(r.engagement).toEqual({ kind: 'slot' })
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 2, source: 'override' })
    expect(val(r.fields.spindleSpeed)).toBeCloseTo(N6, 6)
    expect(r.recommended.stepdown.unwrap()).toBeCloseTo(0.5 * 6 * 0.3, 9)
    expect(r.locked).toEqual([])
  })

  it('no calculator data: speeds unresolved, stepdown/stepover from the strategy, feeds.noData', () => {
    const r = resolveFeeds(input({ materialClass: 'other' }))
    expect(r.fields.spindleSpeed.isNone() && r.fields.feedRate.isNone()).toBe(true)
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 1.5, source: 'strategy' })
    expect(r.warnings.map((w) => w.code)).toEqual(['feeds.noData'])
    expect(r.chipLoad.isNone()).toBe(true)
  })

  it('facing: stepover engagement with the 0.75 D fallback; stepdown falls back to the depth', () => {
    const r = resolveFeeds(input({ kind: 'facing', facingDepth: 0.5 }))
    expect(r.engagement).toEqual({ kind: 'stepover', ae: 4.5 })
    expect(r.fields.stepover.unwrap()).toMatchObject({ value: 4.5, source: 'strategy' })
    expect(src(r.fields.stepdown)).toBe('calculator')
    const other = resolveFeeds(input({ kind: 'facing', facingDepth: 0.5, materialClass: 'other' }))
    expect(other.fields.stepdown.unwrap()).toMatchObject({ value: 0.5, source: 'strategy' })
  })

  it('drilling: no stepdown/stepover; a drill has no data (preset or nothing); an end mill bores a helix', () => {
    const d = tool(drill6())
    const bare = resolveFeeds(input({ kind: 'drilling', tool: d }))
    expect(bare.applicable).toEqual(['spindleSpeed', 'feedRate', 'plungeRate'])
    expect(bare.fields.spindleSpeed.isNone() && bare.fields.stepdown.isNone()).toBe(true)
    expect(bare.engagement).toEqual({ kind: 'drill' })
    const withPreset = tool({ ...drill6(), presets: [drillPreset()] })
    const r = resolveFeeds(
      input({
        kind: 'drilling',
        tool: withPreset,
        preset: pickPreset(withPreset, 'aluminum', undefined),
        auto: false,
      }),
    )
    expect(r.fields.feedRate.unwrap()).toMatchObject({ value: 150, source: 'preset' })
    const helix = resolveFeeds(input({ kind: 'drilling', helixPitch: 1 }))
    expect(helix.engagement).toEqual({ kind: 'helix', ap: 1 })
    expect(src(helix.fields.spindleSpeed)).toBe('calculator')
  })
})

describe('pickPreset', () => {
  const t = tool({
    ...flat6(),
    presets: [
      { name: 'Any', spindleSpeed: rpm('10000'), feedRate: feed('500'), plungeRate: feed('100') },
      { ...flat6().presets[0]!, name: 'Alu' },
    ],
  })
  it('by name, else the material class, else one without a class, else none', () => {
    expect(pickPreset(t, 'aluminum', 'Any').unwrap().name).toBe('Any')
    expect(pickPreset(t, 'aluminum', 'Nope').isNone()).toBe(true)
    expect(pickPreset(t, 'aluminum', undefined).unwrap().name).toBe('Alu')
    expect(pickPreset(t, 'hardwood', undefined).unwrap().name).toBe('Any')
    expect(pickPreset(noPreset(), 'hardwood', undefined).isNone()).toBe(true)
  })
})

// docs/modes/plan-v0.1.md#locks-and-auto-mode (task 3.14)
describe('resolveFeeds: auto mode and locks', () => {
  const machine = Some({
    minSpeed: 8000,
    maxSpeed: 24_000,
    maxFeedXY: 5000,
    maxFeedZ: 1000,
    power: None,
    rigidity: 'extrusion' as const,
  })

  it('auto mode: lock states per field; plunge rate and pocket stepover have none', () => {
    const r = resolveFeeds(input({ machine }))
    expect(r.auto).toBe('on')
    expect(r.locks).toEqual({
      spindleSpeed: { state: 'available' },
      feedRate: { state: 'available' },
      plungeRate: { state: 'hidden' },
      stepdown: { state: 'available' },
      stepover: { state: 'hidden' },
    })
    expect(r.recommended.spindleSpeed.unwrap()).toBeCloseTo(N6, 6)
    const facing = resolveFeeds(input({ kind: 'facing', facingDepth: 0.5, machine }))
    expect(facing.locks.stepover).toEqual({ state: 'available' })
  })

  it('a locked spindle speed: the feed follows it', () => {
    const r = resolveFeeds(
      input({ machine, overrides: { spindleSpeed: q(rpm('10000')) }, locked: ['spindleSpeed'] }),
    )
    expect(r.fields.spindleSpeed.unwrap()).toMatchObject({ value: 10000, source: 'override' })
    expect(val(r.fields.feedRate)).toBeCloseTo(10000 * 2 * 0.0254, 6)
    expect(src(r.fields.feedRate)).toBe('calculator')
    expect(r.locked).toEqual(['spindleSpeed'])
    // what the field would be without its entry
    expect(r.recommended.spindleSpeed.unwrap()).toBeCloseTo(N6, 6)
  })

  it('an entered (unlocked) spindle speed does not move the feed', () => {
    const r = resolveFeeds(input({ machine, overrides: { spindleSpeed: q(rpm('10000')) } }))
    expect(val(r.fields.feedRate)).toBeCloseTo(VF6, 6)
    expect(r.recommended.spindleSpeed.unwrap()).toBeCloseTo(N6, 6)
    // the final-value check sees the entered value: 0.0254·N6/10 000 is below the data minimum
    expect(r.warnings.map((w) => [w.code, w.field])).toContainEqual(['feeds.rubbing', 'feedRate'])
  })

  it('a locked stepdown is an input: the calculator suggests none, the strategy is the fallback', () => {
    const r = resolveFeeds(
      input({ machine, overrides: { stepdown: q(len('2')) }, locked: ['stepdown'] }),
    )
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 2, source: 'override' })
    expect(r.recommended.stepdown.unwrap()).toBeCloseTo(0.5 * 6 * 0.3, 9)
  })

  it('a lock that breaks a rule now is inactive with feeds.lockInactive and the rule', () => {
    const r = resolveFeeds(
      input({ machine, overrides: { spindleSpeed: q(rpm('30000')) }, locked: ['spindleSpeed'] }),
    )
    expect(val(r.fields.feedRate)).toBeCloseTo(VF6, 6) // the lock is ignored
    const w = r.warnings.find((x) => x.code === 'feeds.lockInactive')
    expect(w).toMatchObject({ field: 'spindleSpeed', rule: 'spindleRange', severity: 'warning' })
    expect(w?.message).toBe(
      "Spindle speed lock is inactive: 30000 rpm is above this machine's 24000 rpm.",
    )
    expect(r.locks.spindleSpeed).toMatchObject({ state: 'unavailable', rule: 'spindleRange' })
  })

  it('an unlocked value that breaks a rule cannot be locked (reason shown)', () => {
    const r = resolveFeeds(input({ machine, overrides: { feedRate: q(feed('6000')) } }))
    expect(r.locks.feedRate).toEqual({
      state: 'unavailable',
      rule: 'feedLimit',
      reason: "6000 mm/min is above this machine's 5000 mm/min (X/Y).",
    })
  })

  it('outside auto mode no locks or recommendations; stored locks are not reported', () => {
    const t = tool(flat6())
    const r = resolveFeeds(
      input({ tool: t, preset: pickPreset(t, 'aluminum', undefined), auto: false }),
    )
    expect(Object.values(r.locks).every((l) => l.state === 'hidden')).toBe(true)
    expect(r.locked).toEqual([])
  })

  it('auto requested without calculator data: unavailable, stored locks inactive (noData)', () => {
    const r = resolveFeeds(
      input({
        materialClass: 'other',
        overrides: { spindleSpeed: q(rpm('10000')) },
        locked: ['spindleSpeed'],
      }),
    )
    expect(r.auto).toEqual({ unavailable: expect.stringMatching(/^No feeds-and-speeds data/) })
    expect(r.warnings.map((w) => [w.code, w.rule ?? w.code])).toEqual([
      ['feeds.noData', 'feeds.noData'],
      ['feeds.lockInactive', 'noData'],
    ])
    expect(r.locks.spindleSpeed).toEqual({ state: 'hidden' })
  })
})

describe('feedModeIssues (invariants)', () => {
  const op = (over: Partial<PlanOperationDTO>): PlanOperationDTO => ({
    id: 'po1',
    designOperationIds: ['op1'],
    overrides: { spindleSpeed: rpm('10000'), plungeRate: feed('100') },
    strategy: {},
    ...over,
  })
  const rules = (o: PlanOperationDTO, kind: Parameters<typeof lockableFields>[0] = 'pocket') =>
    feedModeIssues(o, kind).map((i) => i.rule)

  it('accepts locks in auto mode on lockable fields with a value', () => {
    expect(rules(op({ auto: true, locked: ['spindleSpeed'] }))).toEqual([])
  })

  it('auto and a preset exclude each other; locks need auto mode', () => {
    expect(rules(op({ auto: true, presetName: 'Alu' }))).toEqual(['autoAndPreset'])
    expect(rules(op({ locked: ['spindleSpeed'] }))).toEqual(['lockOutsideAuto'])
  })

  it('no duplicates, only lockable fields, only fields with a value', () => {
    expect(rules(op({ auto: true, locked: ['spindleSpeed', 'spindleSpeed'] }))).toEqual([
      'duplicateLock',
    ])
    expect(rules(op({ auto: true, locked: ['plungeRate'] }))).toEqual(['notLockable'])
    expect(rules(op({ auto: true, locked: ['feedRate'] }))).toEqual(['lockWithoutValue'])
    expect(lockableFields('facing')).toContain('stepover')
    expect(lockableFields('profile')).not.toContain('stepover')
    expect(lockableFields('drilling')).toEqual(['spindleSpeed', 'feedRate'])
  })
})
