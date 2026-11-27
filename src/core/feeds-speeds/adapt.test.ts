// Spec: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
// (slice A1): a recommended preset's machine-free values adapted down to the plan machine.
import { describe, expect, it } from 'vitest'
import { None, Some } from '../../shared/result'
import { random } from '../toolpath/testing/region-fixtures'
import { expectOk } from '../../shared/testing/result'
import type { MaterialClass } from '../library/item'
import { deg, flatEndMillValues, len, num } from '../library/library.fixture'
import { Tool } from '../library/tool'
import type { ToolValuesDTO } from '../library/tool.dto'
import type { UnitSystem } from '../project/document'
import { chamferFullDepth } from './formulas'
import { adaptPreset, presetRecommendation, type AdaptInput, type PresetValues } from './preset'
import {
  checkCutting,
  checkModel,
  type CuttingValues,
  type Engagement,
  type MachineLimits,
} from './suggest'

const tool = (o: object): Tool =>
  expectOk(
    Tool.fromDTO({
      ...flatEndMillValues(),
      toolMaterial: 'carbide',
      presets: [],
      ...o,
    } as ToolValuesDTO),
  )

/** The stored preset: the recommendation rounded as the library stores it (mm). */
function stored(t: Tool, cls: MaterialClass): PresetValues {
  const r = presetRecommendation(t, cls).unwrap()
  return {
    ...(r.spindleSpeed === undefined ? {} : { spindleSpeed: Math.round(r.spindleSpeed) }),
    ...(r.feedRate === undefined ? {} : { feedRate: Math.round(r.feedRate) }),
    ...(r.plungeRate === undefined ? {} : { plungeRate: Math.round(r.plungeRate) }),
    ...(r.stepdown === undefined ? {} : { stepdown: Math.round(r.stepdown * 100) / 100 }),
  }
}

const values = (v: PresetValues): CuttingValues => ({
  n: v.spindleSpeed!,
  vf: v.feedRate!,
  ...(v.stepdown === undefined ? {} : { ap: v.stepdown }),
})

/** Plan mode's machine checks (`feedFindings`) on canonical values. */
function machineFindings(v: PresetValues, m: MachineLimits): string[] {
  const out: string[] = []
  if (v.feedRate !== undefined && v.feedRate > m.maxFeedXY * (1 + 1e-9)) out.push('feedRate')
  if (v.plungeRate !== undefined && v.plungeRate > m.maxFeedZ * (1 + 1e-9)) out.push('plungeRate')
  if (
    v.spindleSpeed !== undefined &&
    (v.spindleSpeed < m.minSpeed - 1e-9 || v.spindleSpeed > m.maxSpeed + 1e-9)
  )
    out.push('spindleSpeed')
  return out
}

// The X3 rerun's machine (research note F5): a 500 W spindle, Z max 1500 mm/min.
const X3: MachineLimits = {
  minSpeed: 8000,
  maxSpeed: 24_000,
  maxFeedXY: 5000,
  maxFeedZ: 1500,
  power: Some(500),
  rigidity: 'extrusion',
}
// The DF131 aluminium cut: a 3020 with an 800 W spindle, 6200–29 300 rpm, 3000 mm/min.
const M3020: MachineLimits = {
  minSpeed: 6200,
  maxSpeed: 29_300,
  maxFeedXY: 3000,
  maxFeedZ: 3000,
  power: Some(800),
  rigidity: 'fixedGantry',
}

const flat6 = () => tool({ diameter: len('6'), fluteLength: len('45'), overallLength: len('75') })
const chamfer82 = () =>
  tool({ type: 'chamferMill', diameter: len('6.35'), angle: deg('82'), fluteCount: num('2') })
const alu633 = () => tool({ diameter: len('6.33'), fluteCount: num('3'), fluteLength: len('20') })
const slot: Engagement = { kind: 'slot' }

describe('adaptPreset: the X3 hardwood case (500 W, Z max 1500)', () => {
  it('Flat 6 slot: the stepdown is fitted to the 0.3 kW budget, speed and feed kept', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    expect(v).toEqual({ spindleSpeed: 18000, feedRate: 2743, plungeRate: 1372, stepdown: 1.8 })
    const input = {
      tool: t,
      materialClass: 'hardwood' as const,
      engagement: slot,
      machine: Some(X3),
    }
    // the stored values exceed the budget (X3 F5: 0.34 kW against 0.3 kW)
    const before = checkCutting(input, values(v))
    expect(before.map((w) => w.code)).toEqual(['feeds.powerExceeded'])
    expect(before[0]!.params['cuttingPower']).toBeCloseTo(0.337, 3)
    const a = adaptPreset(v, input, X3)
    expect(a.values).toEqual({ ...v, stepdown: 1.6 })
    expect(a.adapted).toEqual({ stepdown: { from: 1.8, reason: 'power' } })
    expect(a.powerExceeded).toBe(false)
    expect(checkCutting(input, values(a.values))).toEqual([])
    expect(machineFindings(a.values, X3)).toEqual([])
  })

  it('Chamfer 82: plunge 2286 → 1500 (Z max), nothing else moves', () => {
    const t = chamfer82()
    const v = stored(t, 'hardwood')
    expect(v.plungeRate).toBe(2286)
    // a 1 mm chamfer: De ≈ 1.7 mm, within the 0.3 kW budget
    const engagement: Engagement = { kind: 'chamfer', depth: 1 }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement, machine: Some(X3) }
    const a = adaptPreset(v, input, X3)
    expect(a.values).toEqual({ ...v, plungeRate: 1500 })
    expect(a.adapted).toEqual({ plungeRate: { from: 2286, reason: 'maxFeedRateZ' } })
    expect(machineFindings(v, X3)).toEqual(['plungeRate'])
    expect(machineFindings(a.values, X3)).toEqual([])
    expect(checkCutting(input, values(a.values)).map((w) => w.code)).not.toContain(
      'feeds.powerExceeded',
    )
  })

  it('Chamfer 82 at the X3 countersink (Ø4.861): the feed drops to the chip-load floor, the power stays flagged', () => {
    const t = chamfer82()
    const v = stored(t, 'hardwood')
    const engagement: Engagement = {
      kind: 'chamfer',
      depth: 4.861 / 2 / Math.tan((41 * Math.PI) / 180),
    }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement, machine: Some(X3) }
    const before = checkCutting(input, values(v))
    expect(before[0]!.params['cuttingPower']).toBeCloseTo(0.71, 2) // X3 F5's 0.71 kW
    const a = adaptPreset(v, input, X3)
    // De 4.861 is in the ≤ 6 mm band (minimum chip 0.0762 mm): 18 000 × 2 × 0.0762 = 2743.2 → 2744
    expect(a.values).toEqual({ ...v, feedRate: 2744, plungeRate: 1500 })
    expect(a.adapted.feedRate).toEqual({ from: 4572, reason: 'power' })
    expect(a.powerExceeded).toBe(true)
    const w = checkCutting(input, values(a.values))
    expect(w.map((x) => x.code)).toEqual(['feeds.powerExceeded'])
    expect(w[0]!.params['cuttingPower']).toBeCloseTo(0.427, 2)
  })
})

describe('adaptPreset: the DF131 aluminium case (3020, 800 W, 0.8 budget)', () => {
  const input = { tool: alu633(), materialClass: 'aluminum' as const, engagement: slot }

  it('the conservative library values fit: unchanged, never raised to the fixedGantry values', () => {
    const v = stored(input.tool, 'aluminum')
    // DF131's extrusion row: 15 327 rpm, 1168 mm/min, 0.32 mm
    expect(v).toEqual({ spindleSpeed: 15327, feedRate: 1168, plungeRate: 292, stepdown: 0.32 })
    const a = adaptPreset(v, input, M3020)
    expect(a.values).toEqual(v)
    expect(a.adapted).toEqual({})
    expect(checkCutting({ ...input, machine: Some(M3020) }, values(v))).toEqual([])
  })

  it('a weaker spindle: the stepdown fits 80 % of the available power', () => {
    const weak = { ...M3020, power: Some(100) }
    const v = stored(input.tool, 'aluminum')
    const a = adaptPreset(v, input, weak)
    expect(a.adapted.stepdown?.reason).toBe('power')
    expect(a.values.stepdown!).toBeLessThan(0.32)
    const p = checkModel({ ...input, machine: Some(weak) })
      .unwrap()
      .power(values(a.values))
      .unwrap()
    expect(p.pc).toBeLessThanOrEqual(p.budget * (1 + 1e-9))
    // the budget is 0.8 × Pavail (machining row)
    expect(p.budget).toBeCloseTo(0.1 * 0.8 * (15327 / 29300) * 0.8, 9)
    expect(checkCutting({ ...input, machine: Some(weak) }, values(a.values))).toEqual([])
  })
})

describe('adaptPreset: spindle range (Q214) and feed limits', () => {
  it('above the maximum: the speed is clamped and the feed follows, keeping the chip load', () => {
    const t = tool({ diameter: len('3.175'), fluteLength: len('12') })
    const v = stored(t, 'aluminum')
    expect(v.spindleSpeed).toBeGreaterThan(24_000)
    const m = { ...X3, power: None }
    const a = adaptPreset(v, { tool: t, materialClass: 'aluminum', engagement: slot }, m)
    expect(a.values.spindleSpeed).toBeLessThanOrEqual(24_000)
    expect(a.values.spindleSpeed).toBeGreaterThan(23_900)
    expect(a.values.feedRate!).toBeLessThan(v.feedRate!)
    expect(Number.isInteger(a.values.feedRate)).toBe(true)
    // the chip load is never thinner than the stored one
    const chip = (x: PresetValues) => x.feedRate! / x.spindleSpeed!
    expect(chip(a.values)).toBeGreaterThanOrEqual(chip(v))
    expect(chip(a.values)).toBeLessThan(chip(v) * 1.001)
    expect(a.adapted.spindleSpeed).toEqual({ from: v.spindleSpeed, reason: 'spindleRange' })
    expect(a.adapted.feedRate).toEqual({ from: v.feedRate, reason: 'spindleRange' })
  })

  it('below the minimum: the speed rises to it, the feed stays (a thinner chip warns)', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    const m = { ...X3, minSpeed: 20_000, power: None }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement: slot }
    const a = adaptPreset(v, input, m)
    expect(a.values).toEqual({ ...v, spindleSpeed: 20_000 })
    expect(a.adapted).toEqual({ spindleSpeed: { from: 18_000, reason: 'spindleRange' } })
    expect(
      checkCutting({ ...input, machine: Some(m) }, values(a.values)).map((w) => w.code),
    ).toEqual(['feeds.rubbing'])
  })

  it('X/Y max feed: the speed is lowered with the feed, not below the minimum', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    const input = { tool: t, materialClass: 'hardwood' as const, engagement: slot }
    const a = adaptPreset(v, input, { ...X3, maxFeedXY: 2000, power: None })
    expect(a.values.feedRate).toBe(2000)
    expect(a.values.spindleSpeed).toBe(Math.floor((18000 * 2000) / 2743))
    expect(a.adapted.feedRate?.reason).toBe('maxFeedRate')
    expect(a.adapted.spindleSpeed?.reason).toBe('maxFeedRate')
    const floor = adaptPreset(v, input, { ...X3, maxFeedXY: 1000, minSpeed: 10_000, power: None })
    expect(floor.values.feedRate).toBe(1000)
    expect(floor.values.spindleSpeed).toBe(10_000)
  })

  it('without spindle power: clamps only, the stepdown stays', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    const a = adaptPreset(
      v,
      { tool: t, materialClass: 'hardwood', engagement: slot },
      { ...X3, power: None },
    )
    expect(a.values).toEqual(v)
    expect(a.adapted).toEqual({})
  })
})

describe('adaptPreset: power without a preset stepdown (Q213)', () => {
  it('a chamfer (fixed depth): the feed is reduced at the kept speed', () => {
    const t = chamfer82()
    const v = stored(t, 'hardwood')
    // 1 mm deep: De ≈ 1.7 mm takes the scaled chip-load range, so the floor is below the stored chip
    const engagement: Engagement = { kind: 'chamfer', depth: 1 }
    const m = { ...X3, power: Some(100) }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement }
    const a = adaptPreset(v, input, m)
    expect(a.values.spindleSpeed).toBe(v.spindleSpeed)
    expect(a.adapted.feedRate?.reason).toBe('power')
    expect(a.values.feedRate!).toBeLessThan(v.feedRate!)
    expect(a.powerExceeded).toBe(false)
    const codes = checkCutting({ ...input, machine: Some(m) }, values(a.values)).map((w) => w.code)
    expect(codes).not.toContain('feeds.powerExceeded')
    expect(codes).not.toContain('feeds.rubbing')
  })

  it('power still above the budget at the chip-load floor: flagged, the feed stops there', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    const m = { ...X3, power: Some(1) }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement: slot }
    const a = adaptPreset(v, input, m)
    expect(a.powerExceeded).toBe(true)
    expect(a.values.stepdown).toBe(0.01)
    const codes = checkCutting({ ...input, machine: Some(m) }, values(a.values)).map((w) => w.code)
    expect(codes).toEqual(['feeds.powerExceeded']) // not rubbing: the feed stops at the floor
  })
})

describe('adaptPreset: rounding never ends above a limit', () => {
  it('inch: feeds in 0.1 in/min and lengths in 0.001 in, at or below every limit', () => {
    const t = flat6()
    const v = stored(t, 'hardwood')
    const m = { ...X3, maxFeedXY: 2001.7, maxFeedZ: 999.9 }
    const input = { tool: t, materialClass: 'hardwood' as const, engagement: slot }
    const a = adaptPreset(v, input, m, 'inch')
    expect(a.values.feedRate!).toBeLessThanOrEqual(2001.7)
    expect(a.values.plungeRate!).toBeLessThanOrEqual(999.9)
    const tenths = (x: number) =>
      Math.abs((x / 2.54) % 1) < 1e-6 || Math.abs((x / 2.54) % 1) > 1 - 1e-6
    expect(tenths(a.values.feedRate!)).toBe(true)
    expect(tenths(a.values.plungeRate!)).toBe(true)
    expect(checkCutting({ ...input, machine: Some(m) }, values(a.values))).toEqual([])
    expect(machineFindings(a.values, m)).toEqual([])
  })
})

// Properties over random tools, classes, engagements and machines: the result is never more
// aggressive than the stored values, and lies within every machine limit or is flagged.
describe('adaptPreset: properties', () => {
  const CLASSES: MaterialClass[] = [
    'hardwood',
    'softwood',
    'sheetGood',
    'plastic',
    'aluminum',
    'brass',
    'steel',
  ]
  const rnd = random(139)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const between = (a: number, b: number) => a + rnd() * (b - a)

  it('never more aggressive on any axis; within the limits or flagged (400 cases)', () => {
    let adaptedCount = 0
    for (let i = 0; i < 400; i++) {
      const D = pick([1.5, 2, 3.175, 4, 6, 6.35, 8, 12])
      const type = pick([
        'flatEndMill',
        'flatEndMill',
        'ballEndMill',
        'chamferMill',
        'drill',
      ] as const)
      const t = tool({
        type,
        diameter: len(String(D)),
        fluteLength: len(String(D * 3)),
        overallLength: len(String(D * 3 + 30)),
        fluteCount: num(String(pick([1, 2, 3]))),
        ...(type === 'chamferMill' ? { angle: deg(String(pick([60, 82, 90]))) } : {}),
        ...(type === 'drill' ? { pointAngle: deg('118') } : {}),
      })
      const cls = pick(CLASSES)
      const rec = presetRecommendation(t, cls)
      if (rec.isErr()) continue
      const v = stored(t, cls)
      const minSpeed = pick([0, 6000, 8000, 12_000, 20_000])
      const m: MachineLimits = {
        minSpeed,
        maxSpeed: minSpeed + pick([4000, 12_000, 18_000, 24_000]),
        maxFeedXY: pick([800, 1500, 3000, 5000, 10_000]),
        maxFeedZ: pick([300, 800, 1500, 3000]),
        power: rnd() < 0.2 ? None : Some(between(50, 2200)),
        rigidity: pick(['extrusion', 'hobby', 'rigidMill'] as const),
      }
      const engagement: Engagement =
        type === 'drill'
          ? { kind: 'drill' }
          : type === 'chamferMill'
            ? { kind: 'chamfer', depth: chamferFullDepth(0, t.angle.unwrap().canonical, D) * rnd() }
            : rnd() < 0.3
              ? { kind: 'stepover', ae: D * between(0.1, 0.9) }
              : slot
      const input: AdaptInput = { tool: t, materialClass: cls, engagement }
      const units: UnitSystem = rnd() < 0.3 ? 'inch' : 'mm'
      const a = adaptPreset(v, input, m, units)
      const out = a.values
      if (Object.keys(a.adapted).length > 0) adaptedCount++
      const ctx = JSON.stringify({ D, type, cls, m, engagement, v, out })
      // never more aggressive: feed, plunge, stepdown only go down; the speed only rises into range
      expect(out.feedRate!, ctx).toBeLessThanOrEqual(v.feedRate! + 1e-9)
      expect(out.plungeRate!, ctx).toBeLessThanOrEqual(v.plungeRate! + 1e-9)
      if (v.stepdown !== undefined)
        expect(out.stepdown!, ctx).toBeLessThanOrEqual(v.stepdown + 1e-9)
      if (out.spindleSpeed! > v.spindleSpeed!)
        expect(out.spindleSpeed!, ctx).toBe(Math.ceil(m.minSpeed))
      const model = checkModel({ ...input, machine: Some(m) }).unwrap()
      const powerOf = (x: PresetValues) => model.power(values(x))
      if (powerOf(v).isSome()) {
        const [pin, pout] = [powerOf(v).unwrap(), powerOf(out).unwrap()]
        // the spindle load never rises (beyond whole-rpm rounding)
        expect(pout.pc / pout.budget, ctx).toBeLessThanOrEqual((pin.pc / pin.budget) * 1.002)
        // the cutting power never rises, unless the speed rose into the range (thinner chips)
        if (out.spindleSpeed! <= v.spindleSpeed!)
          expect(pout.pc, ctx).toBeLessThanOrEqual(pin.pc * 1.002)
      }
      // within every machine limit
      expect(machineFindings(out, m), ctx).toEqual([])
      // within the power budget, or flagged
      const p = model.power(values(out))
      if (p.isSome() && !a.powerExceeded)
        expect(p.unwrap().pc, ctx).toBeLessThanOrEqual(p.unwrap().budget * (1 + 1e-9))
      if (a.powerExceeded) expect(p.unwrap().pc, ctx).toBeGreaterThan(p.unwrap().budget)
      // no power warning from the final-value check unless flagged
      const codes = checkCutting({ ...input, machine: Some(m) }, values(out)).map((w) => w.code)
      if (!a.powerExceeded) expect(codes, ctx).not.toContain('feeds.powerExceeded')
      // every adapted field records the stored value
      for (const [f, x] of Object.entries(a.adapted))
        expect(x.from, ctx).toBe(v[f as keyof PresetValues])
    }
    expect(adaptedCount).toBeGreaterThan(100)
  })
})
