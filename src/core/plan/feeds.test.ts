// Spec: docs/modes/plan-v0.1.md#feeds-and-speeds (resolution order, source per field) against the
// shipped carbide data (docs/architecture/feeds-speeds.md#material-data-v01).
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, type Option } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { feed, len, qty, rpm } from '../library/library.fixture'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { Quantity } from '../quantity/quantity'
import { pickPreset, resolveFeeds, type FeedsInput, type ResolvedFeed } from './feeds'
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
    const r = resolveFeeds(input({ tool: t, preset: pickPreset(t, 'aluminum', undefined) }))
    expect(r.fields.spindleSpeed.unwrap()).toMatchObject({ value: 18000, source: 'preset' })
    expect(r.fields.feedRate.unwrap()).toMatchObject({ value: 800, source: 'preset' })
    expect(r.fields.plungeRate.unwrap()).toMatchObject({ value: 200, source: 'preset' })
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 1, source: 'preset' })
    expect(r.fields.stepover.unwrap()).toMatchObject({ value: 3, source: 'preset' })
    expect(r.warnings).toEqual([]) // calculator unused
  })

  it('an override wins over the preset; the rest keeps its source', () => {
    const t = tool(flat6())
    const r = resolveFeeds(
      input({
        tool: t,
        preset: pickPreset(t, 'aluminum', undefined),
        overrides: { feedRate: q(feed('500')), stepover: q(len('2')) },
      }),
    )
    expect(r.fields.feedRate.unwrap()).toMatchObject({ value: 500, source: 'override' })
    expect(r.fields.stepover.unwrap()).toMatchObject({ value: 2, source: 'override' })
    expect(r.fields.spindleSpeed.unwrap()).toMatchObject({ value: 18000, source: 'preset' })
  })

  it('a preset without stepdown/stepover: calculator stepdown, strategy stepover', () => {
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
    const r = resolveFeeds(input({ tool: t, preset: pickPreset(t, 'aluminum', undefined) }))
    expect(src(r.fields.spindleSpeed)).toBe('preset')
    expect(src(r.fields.stepdown)).toBe('calculator')
    expect(src(r.fields.stepover)).toBe('strategy')
  })

  it('an overridden stepdown is the engagement the calculator uses', () => {
    const r = resolveFeeds(input({ overrides: { stepdown: q(len('2')) } }))
    expect(r.engagement).toEqual({ kind: 'slot', ap: 2 })
    expect(r.fields.stepdown.unwrap()).toMatchObject({ value: 2, source: 'override' })
    expect(src(r.fields.spindleSpeed)).toBe('calculator')
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
