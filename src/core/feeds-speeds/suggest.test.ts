// Spec: docs/architecture/feeds-speeds.md (task 2.12). Material numbers come from the synthetic
// TEST_DATA fixture, so these tests check the calculator's logic, not cutting data – except the
// golden cases on the shipped table, which check the curated rows against their cited charts.
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some, type Option } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import {
  deg,
  flatEndMillValues,
  len,
  machineValues,
  num,
  rpm,
  watt,
} from '../library/library.fixture'
import { Machine } from '../library/machine'
import { MachineValuesDtoSchema, type Rigidity } from '../library/machine.dto'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { MATERIAL_DATA } from './data'
import { TEST_DATA } from './data.fixture'
import { availablePower, plungedRemovalRate, rctf } from './formulas'
import {
  checkCutting,
  cuttingAt,
  finishingAt,
  machineLimits,
  noDataFor,
  suggestCutting,
  type CuttingInput,
  type CuttingSuggestion,
  type Engagement,
  type MachineLimits,
} from './suggest'

function tool(over: Record<string, unknown> = {}): Tool {
  const raw = { ...flatEndMillValues(), toolMaterial: 'carbide', presets: [], ...over }
  return expectOk(parseWith(ToolValuesDtoSchema, raw, 'test').andThen((d) => Tool.fromDTO(d)))
}

const limits = (over: Partial<MachineLimits> = {}): Option<MachineLimits> =>
  Some({
    minSpeed: 0,
    maxSpeed: 1e9,
    maxFeedXY: 1e9,
    maxFeedZ: 1e9,
    power: None,
    rigidity: 'extrusion',
    ...over,
  })

const SLOT: Engagement = { kind: 'slot' }

function suggest(over: Partial<CuttingInput> = {}): CuttingSuggestion {
  return suggestCutting(
    { tool: tool(), materialClass: 'aluminum', engagement: SLOT, machine: None, ...over },
    TEST_DATA,
  )
}

const value = (f: Option<{ value: number }>): number => f.unwrap().value
const codes = (s: CuttingSuggestion) => s.warnings.map((w) => w.code)
const clamped = (s: CuttingSuggestion) => s.warnings.find((w) => w.code === 'feeds.feedClamped')!

describe('suggestCutting: data lookup', () => {
  it('flat 6 mm 2F carbide in aluminum, lowest rigidity: n from vc.min, vf from fz.min, ap = apSlot·D·0.3', () => {
    const s = suggest()
    expect(value(s.spindleSpeed)).toBeCloseTo((100 * 1000) / (Math.PI * 6), 6) // F1
    expect(value(s.feedRate)).toBeCloseTo(value(s.spindleSpeed) * 2 * 0.02, 6) // F2, slot: no RCTF
    expect(value(s.plungeRate)).toBeCloseTo(0.3 * value(s.feedRate), 6) // F9
    expect(value(s.stepdown)).toBeCloseTo(0.5 * 6 * 0.3, 9)
    expect(s.stepover.isNone()).toBe(true) // left to the strategy fallback in v0.1
  })

  it('returns no suggestion with feeds.noData for other material, unset tool material, D > 25 mm', () => {
    for (const s of [
      suggest({ materialClass: 'other' }),
      suggest({ tool: tool({ toolMaterial: undefined }) }),
      suggest({ tool: tool({ toolMaterial: 'other' }) }),
      suggest({ tool: tool({ toolMaterial: 'hss' }) }), // no row in the fixture
      suggest({
        tool: tool({ diameter: len('30'), fluteLength: len('40'), overallLength: len('90') }),
      }),
    ]) {
      expect(s.spindleSpeed.isNone() && s.feedRate.isNone() && s.plungeRate.isNone()).toBe(true)
      expect(s.stepdown.isNone() && s.stepover.isNone() && s.display.isNone()).toBe(true)
      expect(codes(s)).toEqual(['feeds.noData'])
      // no enum keys in the visible text (DF44): "HSS", "sheet good", "flat end mill"
      expect(s.warnings[0]?.message).not.toMatch(/[a-z][A-Z]|\bhss\b/)
    }
  })

  it('names the material class and the tool type in words (DF44)', () => {
    const sheet = suggest({ materialClass: 'sheetGood', tool: tool({ toolMaterial: 'hss' }) })
    expect(sheet.warnings[0]?.message).toContain('HSS in sheet good')
    const drill = suggest({ engagement: { kind: 'drill' } })
    expect(drill.warnings[0]?.message).toContain('does not fit a flat end mill')
  })
})

// Golden cases on the SHIPPED table (task 2.12): each result must lie within the cited chart's
// printed range. Chart values are inch units; doc: docs/architecture/feeds-speeds.md#material-data-v01
describe('shipped material table: golden cases against the cited charts', () => {
  const IN = 25.4
  const hobbyVfd = limits({
    minSpeed: 6000,
    maxSpeed: 24_000,
    maxFeedXY: 10_000,
    maxFeedZ: 5000,
    rigidity: 'hobby',
  })
  const shipped = (over: Partial<CuttingInput>) =>
    suggestCutting({
      tool: tool(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: hobbyVfd,
      ...over,
    })

  it('6 mm 2F carbide flat slotting MDF, hobby: Onsrud 52-200 / Amana 1/8" chip load at 18,000 rpm', () => {
    const s = shipped({ materialClass: 'sheetGood' })
    expect(codes(s)).toEqual(['feeds.powerSkipped'])
    expect(value(s.spindleSpeed)).toBe(18_000) // Amana: CNC operating spindle speed 18,000 RPM
    const fzIn = s.display.unwrap().fz / IN
    expect(fzIn).toBeCloseTo(0.0055, 9) // .005–.007 at rangePos 0.25
    expect(fzIn).toBeGreaterThanOrEqual(0.005) // Onsrud MDF 52-200 1/8": .005–.007; Amana MDF 1/8": same
    expect(fzIn).toBeLessThanOrEqual(0.008) // ≤ the 1/4" maximum (.006–.008) of both charts
    const vfIpm = value(s.feedRate) / IN
    expect(vfIpm).toBeGreaterThanOrEqual(190) // Amana MDF 1/8" feed rate 190–260 IPM
    expect(vfIpm).toBeLessThanOrEqual(260)
    expect(value(s.plungeRate)).toBeCloseTo(value(s.feedRate) / 2, 9) // Amana ramp down = IPM / flutes
    expect(value(s.stepdown)).toBeCloseTo(6 * 1 * 0.5, 9) // 1 x D (Onsrud, Amana) × hobby apFactor
  })

  it('6 mm 2F carbide flat slotting 6061 aluminium, hobby: Harvey Tool SFM, 1/8" chip load scaled for the class (DF131)', () => {
    const s = shipped({})
    expect(codes(s)).toEqual(['feeds.powerSkipped'])
    const d = s.display.unwrap()
    const vcSfm = d.vc / 0.3048
    expect(vcSfm).toBeCloseTo(1000, 6) // the range's top for every class (DF131)
    expect(vcSfm).toBeGreaterThanOrEqual(500) // Harvey guide, Aluminum 440/356/380: 500–1000 SFM
    expect(vcSfm).toBeLessThanOrEqual(1000) // Harvey SF_13900 slotting, wrought: 1000 SFM
    expect(value(s.spindleSpeed)).toBeCloseTo((1000 * 0.3048 * 1000) / (Math.PI * 6), 6)
    // [0.5 × .001, .001] at the hobby class's machining position 0.1
    expect(d.fz / IN).toBeCloseTo(0.00055, 12)
    expect(d.fz / IN).toBeLessThanOrEqual(0.001) // Harvey guide, aluminium 1/8": .001 IPT
    expect(value(s.stepdown)).toBeCloseTo(6 * 0.5 * 0.12, 9) // SF_13900 .50 x Dia × hobby 0.12
  })

  it('1/4" 2F carbide flat slotting hardwood, prosumer: Onsrud / Amana 1/4" chip load and feed', () => {
    const s = shipped({
      materialClass: 'hardwood',
      tool: tool({ diameter: len('6.35') }),
      machine: limits({ maxSpeed: 24_000, rigidity: 'prosumer' }),
    })
    expect(value(s.spindleSpeed)).toBe(18_000)
    const fzIn = s.display.unwrap().fz / IN
    expect(fzIn).toBeCloseTo(0.006, 9) // Onsrud hard wood 52-200 1/4": .005–.007; Amana: same
    const vfIpm = value(s.feedRate) / IN
    expect(vfIpm).toBeGreaterThanOrEqual(190) // Amana hardwood 1/4" feed rate 190–260 IPM
    expect(vfIpm).toBeLessThanOrEqual(260)
    expect(value(s.stepdown)).toBeCloseTo(6.35 * 0.75, 9)
  })

  it('HSS, drills, end mills ≤ 3 mm in metal and under 1 mm have no data (feeds.noData → strategy/preset fallback)', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    for (const s of [
      shipped({ tool: tool({ toolMaterial: 'hss' }) }),
      shipped({ tool: drill, engagement: { kind: 'drill' } }),
      shipped({ tool: tool({ diameter: len('3') }) }), // aluminium: Harvey prints nothing below 1/8"
      shipped({ tool: tool({ diameter: len('0.8') }), materialClass: 'softwood' }),
    ])
      expect(codes(s)).toEqual(['feeds.noData'])
  })

  it('3 mm 2F carbide flat slotting plywood, hobby: Amana MDF 1/16" chip load (DF39)', () => {
    const s = shipped({ tool: tool({ diameter: len('3') }), materialClass: 'sheetGood' })
    expect(codes(s)).toEqual(['feeds.powerSkipped'])
    expect(value(s.spindleSpeed)).toBe(18_000) // Amana: 18,000 RPM
    const fzIn = s.display.unwrap().fz / IN
    expect(fzIn).toBeCloseTo(0.0035, 9) // Amana MDF 1/16": .003–.005 at rangePos 0.25
    const vfIpm = value(s.feedRate) / IN
    expect(vfIpm).toBeGreaterThanOrEqual(110) // Amana MDF 1/16" feed rate 110–190 IPM
    expect(vfIpm).toBeLessThanOrEqual(190)
    expect(s.feedRate.unwrap().derivation.map((d) => d.step)).not.toContain('fzScale')
  })

  it('1.5 mm end mill in hardwood: the 1/16" chip load × D / 1.5875 (fzScale, DF39)', () => {
    const s = shipped({ tool: tool({ diameter: len('1.5') }), materialClass: 'hardwood' })
    const fzIn = s.display.unwrap().fz / IN
    expect(fzIn).toBeCloseTo(0.0025 * (1.5 / 1.5875), 9) // Amana hardwood 1/16": .002–.004
    const scale = s.feedRate.unwrap().derivation.find((d) => d.step === 'fzScale')
    expect(scale?.inputs).toMatchObject({ D: 1.5 })
    expect(scale?.formula).toContain('1.5875')
  })

  // docs/architecture/feeds-speeds.md#tapered-ball-end-mills-hardening-df124 (DF124 T2): F11 at the
  // Line's depth, the 1/8" chip load × De / 3.175, the stepdown solved against De(ap)
  it('tapered ball R0.25 3.6° 2F carbide, a 1 mm Line in hardwood, hobby router: derivation golden', async () => {
    const taper = tool({
      name: 'R0.25 3.6°',
      type: 'taperedBallEndMill',
      diameter: len('3.175'),
      tipDiameter: len('0.5'),
      taperAngle: deg('3.6'),
      fluteLength: len('22'),
      overallLength: len('38'),
    })
    const s = shipped({
      tool: taper,
      materialClass: 'hardwood',
      engagement: { kind: 'taper', depth: 1 },
    })
    expect(codes(s)).toEqual(['feeds.powerSkipped'])
    const d = s.display.unwrap()
    expect(d.dCalc).toBeCloseTo(0.595, 3) // the groove width at 1 mm
    expect(value(s.spindleSpeed)).toBe(18_000) // the router row's chart rpm (no F1)
    // the ≤ 6 mm band's 1/8" chip load (Onsrud hard wood .003–.005 at rangePos 0.25) × De / 3.175
    expect(d.fz / IN).toBeCloseTo(0.0035 * (d.dCalc / 3.175), 9)
    // a light carving feed: n · z · fz = 18,000 · 2 · 0.0167 mm ≈ 600 mm/min
    expect(value(s.feedRate)).toBeCloseTo(18_000 * 2 * d.fz, 6)
    expect(value(s.feedRate)).toBeLessThan(700)
    // hobby: k = apSlot 1 × 0.5; ap = k·A / (1 − k·B) on the cone
    const r = 0.25
    const t = (3.6 * Math.PI) / 180
    const A = (2 * r) / Math.cos(t) - 2 * r * Math.tan(t)
    expect(value(s.stepdown)).toBeCloseTo((0.5 * A) / (1 - 0.5 * 2 * Math.tan(t)), 9)
    const golden = {
      spindleSpeed: s.spindleSpeed.unwrap(),
      feedRate: s.feedRate.unwrap(),
      plungeRate: s.plungeRate.unwrap(),
      stepdown: s.stepdown.unwrap(),
      display: {
        ...d,
        Q: d.Q.unwrapOr(-1),
        Pc: d.Pc.unwrapOr(-1),
        spindleLoad: d.spindleLoad.unwrapOr(-1),
      },
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      '__golden__/tapered-ball-hardwood.json',
    )
  })

  it('ships carbide rows only, one per material class except other', () => {
    expect(MATERIAL_DATA.every((r) => r.toolMaterial === 'carbide')).toBe(true)
    expect(MATERIAL_DATA.map((r) => r.materialClass)).toEqual([
      'softwood',
      'hardwood',
      'sheetGood',
      'plastic',
      'aluminum',
      'brass',
      'steel',
    ])
  })
})

describe('hobby metal cutting (hardening DF131, TG #425)', () => {
  // The user's first aluminium cut: Ø6.33 3-flute carbide flat end mill (20 mm flutes), 6061-T6,
  // a 3020 with an 800 W spindle (6200–29 300 rpm), 3000 / 1000 mm/min, pocket = slot.
  const flat633 = () =>
    tool({
      diameter: len('6.33'),
      fluteCount: num('3'),
      fluteLength: len('20'),
      overallLength: len('50'),
    })
  const nova = (rigidity: Rigidity) =>
    limits({
      minSpeed: 6200,
      maxSpeed: 29_300,
      maxFeedXY: 3000,
      maxFeedZ: 1000,
      power: Some(800),
      rigidity,
    })
  const userCase = (rigidity: Rigidity, over: Partial<CuttingInput> = {}) =>
    suggestCutting({
      tool: flat633(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: nova(rigidity),
      ...over,
    })

  it('pins the user case inside the hobby band: 15–24k rpm, 0.02–0.04 mm/tooth, slot DOC ≤ 0.1·D, spindle load ≤ 50 %', () => {
    for (const rigidity of ['extrusion', 'fixedGantry'] as const) {
      const s = userCase(rigidity)
      const d = s.display.unwrap()
      const n = value(s.spindleSpeed)
      expect(n).toBeCloseTo((304.8 * 1000) / (Math.PI * 6.33), 6) // 1000 SFM: 15 327 rpm
      expect(n).toBeGreaterThanOrEqual(15_000)
      expect(d.fz).toBeGreaterThanOrEqual(0.02)
      expect(d.fz).toBeLessThanOrEqual(0.04)
      expect(value(s.stepdown)).toBeLessThanOrEqual(0.1 * 6.33)
      expect(d.spindleLoad.unwrap()).toBeLessThanOrEqual(50)
      expect(value(s.feedRate)).toBeLessThanOrEqual(1500)
      expect(codes(s)).toEqual(['feeds.manyFlutes'])
    }
    // before DF131 (fixedGantry): 9043 rpm, 0.0508 mm/tooth, 1378 mm/min, 1.99 mm at 99.9 % load
    const fg = userCase('fixedGantry')
    expect(value(fg.stepdown)).toBeCloseTo(6.33 * 0.5 * 0.16, 9) // 0.506 mm
    expect(fg.display.unwrap().fz).toBeCloseTo(0.0508 * 0.6, 9) // 0.0305 mm
    expect(value(fg.feedRate)).toBeCloseTo(value(fg.spindleSpeed) * 3 * 0.0508 * 0.6, 6) // 1402
    const ex = userCase('extrusion')
    expect(value(ex.stepdown)).toBeCloseTo(6.33 * 0.5 * 0.1, 9) // 0.317 mm
    expect(ex.display.unwrap().fz).toBeCloseTo(0.0254, 9)
  })

  it('"aluminium extrusion" is clearly gentler than every stiffer class (chip load, stepdown, Q)', () => {
    const order: Rigidity[] = ['extrusion', 'hobby', 'prosumer', 'benchMill', 'rigidMill']
    const qs = order.map((r) => userCase(r).display.unwrap().Q.unwrap())
    for (let i = 1; i < qs.length; i++) expect(qs[i]!).toBeGreaterThan(qs[i - 1]!)
    expect(qs[1]! / qs[0]!).toBeGreaterThan(1.2)
  })

  it('the speed is the top of the vc range for every class (a low speed is not the safe side)', () => {
    const speeds = (['extrusion', 'hobby', 'rigidMill'] as const).map((r) =>
      value(userCase(r).spindleSpeed),
    )
    expect(new Set(speeds).size).toBe(1)
  })

  it('power: Machinery’s Handbook feed factor C and wear factor W, against 80 % of Pavail', () => {
    const s = userCase('extrusion')
    const d = s.display.unwrap()
    const C = (0.3048 / d.fz) ** 0.19
    expect(d.Pc.unwrap()).toBeCloseTo((d.Q.unwrap() * 0.6825 * C * 1.25) / 60_000, 9)
    // a big tool at a low speed: the stepdown is cut until Pc ≤ 0.8 · Pavail
    const big = userCase('rigidMill', {
      tool: tool({ diameter: len('12'), fluteLength: len('30'), overallLength: len('75') }),
    })
    const bd = big.display.unwrap()
    const w = big.warnings.find((x) => x.code === 'feeds.powerExceeded')!
    expect(w.params['loadLimit']).toBe(0.8)
    expect(w.message).toContain('80 % of the spindle')
    expect(bd.spindleLoad.unwrap()).toBeLessThanOrEqual(80 + 1e-6)
    expect(bd.spindleLoad.unwrap()).toBeGreaterThan(70)
  })

  it('wood rows keep the plain F7 and the full spindle power', () => {
    const s = userCase('extrusion', { materialClass: 'hardwood', tool: tool() })
    const d = s.display.unwrap()
    expect(d.Pc.unwrap()).toBeCloseTo((d.Q.unwrap() * 0.6825) / 60_000, 12)
  })

  it('feeds.manyFlutes: 3+ flutes slotting aluminium on a router class; not 2 flutes, not a mill', () => {
    expect(codes(userCase('extrusion'))).toContain('feeds.manyFlutes')
    expect(codes(userCase('benchMill'))).not.toContain('feeds.manyFlutes')
    expect(codes(userCase('extrusion', { tool: tool() }))).not.toContain('feeds.manyFlutes')
    expect(codes(userCase('extrusion', { engagement: { kind: 'stepover', ae: 1 } }))).not.toContain(
      'feeds.manyFlutes',
    )
  })

  it('the final-value check flags the failed run’s power only above 80 % (it was 67 %)', () => {
    // run 2 of TG #425: 12 043 rpm, 1178.2 mm/min, 1.089 mm stepdown (entered)
    const input: CuttingInput = {
      tool: flat633(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: nova('fixedGantry'),
    }
    const at = cuttingAt(input, { n: 12_043, vf: 1178.2, ap: 1.089 }).unwrap()
    expect(at.spindleLoad.unwrap()).toBeGreaterThan(60)
    expect(at.spindleLoad.unwrap()).toBeLessThan(80)
    expect(checkCutting(input, { n: 12_043, vf: 1178.2, ap: 1.089 })).toEqual([])
    expect(checkCutting(input, { n: 12_043, vf: 1178.2, ap: 1.5 }).map((w) => w.code)).toEqual([
      'feeds.powerExceeded',
    ])
  })

  // hardening DF138 F5 (X3): a recommended feed rounded to whole mm/min fell 0.008 % under the
  // data minimum and warned of rubbing
  it('the chip load range allows the rounding of whole rpm and mm/min (0.1 %)', () => {
    const input: CuttingInput = {
      tool: flat633(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: nova('fixedGantry'),
    }
    const n = 12_000
    const z = flat633().fluteCount.canonical
    const slow = checkCutting(input, { n, vf: 1, ap: 0.5 }).find((w) => w.code === 'feeds.rubbing')
    const min = slow!.params!['minimum'] as number
    const codes = (fz: number) =>
      checkCutting(input, { n, vf: fz * n * z, ap: 0.5 }).map((w) => w.code)
    expect(codes(min * (1 - 1e-4))).not.toContain('feeds.rubbing')
    expect(codes(min * (1 - 1e-2))).toContain('feeds.rubbing')
  })

  it('finishing pass in metal: no faster than the roughing pass removes material', () => {
    const s = userCase('extrusion')
    const values = { n: value(s.spindleSpeed), vf: value(s.feedRate), ap: value(s.stepdown) }
    const input: CuttingInput = {
      tool: flat633(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: nova('extrusion'),
    }
    const f = finishingAt(input, values, 0.2, 7).unwrap()
    expect(f.feedRate).toBeCloseTo((6.33 * values.ap * values.vf) / (0.2 * 7), 6) // ≈ 1672
    expect(f.clamped).toBe(false)
    // wood keeps the chip-load-keeping feed (DF74)
    const wood = finishingAt({ ...input, materialClass: 'hardwood' }, values, 0.2, 7).unwrap()
    expect(wood.feedRate).toBe(3000)
  })
})

describe('suggestCutting: rigidity scaling', () => {
  const at = (rigidity: Rigidity) => suggest({ machine: limits({ rigidity }) })

  it('rangePos moves vc and fz within their ranges; apFactor scales the stepdown', () => {
    const cases: [Rigidity, number, number, number][] = [
      ['extrusion', 100, 0.02, 0.9],
      ['hobby', 150, 0.03, 1.5],
      ['prosumer', 200, 0.04, 2.25],
      ['fixedGantry', 220, 0.044, 2.55],
      ['benchMill', 250, 0.05, 2.7],
      ['rigidMill', 300, 0.06, 3],
    ]
    for (const [r, vc, fz, ap] of cases) {
      const s = at(r)
      expect(s.display.unwrap().vc, r).toBeCloseTo(vc, 9)
      expect(s.display.unwrap().fz, r).toBeCloseTo(fz, 9)
      expect(value(s.stepdown), r).toBeCloseTo(ap, 9)
    }
  })

  it('no machine → lowest preset', () => {
    expect(value(suggest().stepdown)).toBeCloseTo(value(at('extrusion').stepdown), 12)
  })

  it('stepdown never exceeds the flute length', () => {
    const s = suggest({
      tool: tool({ fluteLength: len('2') }),
      machine: limits({ rigidity: 'rigidMill' }),
    })
    expect(value(s.stepdown)).toBe(2)
  })
})

describe('suggestCutting: engagement and chip thinning', () => {
  it('stepover ae/D = 0.075 multiplies fz by RCTF ≈ 1.90 [MD]', () => {
    const s = suggest({ engagement: { kind: 'stepover', ae: 0.45 } })
    expect(s.display.unwrap().chipThinning).toBeCloseTo(rctf(0.45, 6), 9)
    expect(value(s.feedRate)).toBeCloseTo(value(s.spindleSpeed) * 2 * 0.02 * rctf(0.45, 6), 6)
  })

  it('no RCTF at ae ≥ D/2; capped at ×3 for tiny ae', () => {
    expect(
      suggest({ engagement: { kind: 'stepover', ae: 4.5 } }).display.unwrap().chipThinning,
    ).toBe(1)
    expect(
      suggest({ engagement: { kind: 'stepover', ae: 0.01 } }).display.unwrap().chipThinning,
    ).toBe(3)
  })

  it('a given stepdown (override/preset) is used and not re-suggested', () => {
    const s = suggest({ locked: { ap: 1.2 } })
    expect(s.stepdown.isNone()).toBe(true)
    expect(s.display.unwrap().Q.unwrap()).toBeCloseTo(6 * 1.2 * value(s.feedRate), 6) // F6, slot ae = D
  })

  it('ball nose at ap < RE: n from the effective diameter (F4) and axial thinning (F5)', () => {
    const ball = tool({ type: 'ballEndMill' })
    const s = suggest({ tool: ball, locked: { ap: 1 } })
    const De = 2 * Math.sqrt(1 * (6 - 1))
    expect(s.display.unwrap().dCalc).toBeCloseTo(De, 9)
    expect(value(s.spindleSpeed)).toBeCloseTo((100 * 1000) / (Math.PI * De), 6)
    expect(s.display.unwrap().chipThinning).toBeCloseTo(1 / Math.sqrt(1 - (2 / 3) ** 2), 9)
  })

  it('helix: treated as a slot with ap = helixPitch', () => {
    const s = suggest({ engagement: { kind: 'helix', ap: 1.5 } })
    expect(s.stepdown.isNone()).toBe(true)
    expect(s.display.unwrap().Q.unwrap()).toBeCloseTo(6 * 1.5 * value(s.feedRate), 6)
  })

  it('drill: F1 with the drill diameter, F8 feed, plungeRate = feedRate, no stepdown', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    const s = suggest({ tool: drill, engagement: { kind: 'drill' } })
    const n = (100 * 1000) / (Math.PI * 5)
    expect(value(s.spindleSpeed)).toBeCloseTo(n, 6)
    expect(value(s.feedRate)).toBeCloseTo(0.05 * n, 6)
    expect(value(s.plungeRate)).toBe(value(s.feedRate))
    expect(s.stepdown.isNone() && s.stepover.isNone()).toBe(true)
  })

  it('drill feed clamped to the Z maximum: n lowered to keep fn, the warning says so (DF56)', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    const s = suggest({
      tool: drill,
      engagement: { kind: 'drill' },
      machine: limits({ maxFeedZ: 50 }),
    })
    expect(value(s.feedRate)).toBe(50)
    expect(value(s.spindleSpeed)).toBeCloseTo(50 / 0.05, 6)
    expect(clamped(s).message).toBe(
      'Drilling feed limited to the machine maximum (Z); spindle speed lowered with it, so the feed per revolution stays.',
    )
    expect(clamped(s).params['chipLoad']).toBeCloseTo(0.05, 9)
  })

  it('drill engagement with an end mill (or the reverse) has no data', () => {
    expect(codes(suggest({ engagement: { kind: 'drill' } }))).toEqual(['feeds.noData'])
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    expect(codes(suggest({ tool: drill }))).toEqual(['feeds.noData'])
  })

  // Doc: docs/architecture/feeds-speeds.md#chamfer-mills-v04 (F10, task C1)
  const vbit = (over: Record<string, unknown> = {}) =>
    tool({ type: 'chamferMill', diameter: len('12'), angle: deg('90'), ...over })

  it('chamfer: speed and chip load of a flat end mill of the effective diameter De (F10)', () => {
    // 90° V-bit 2.5 mm deep: De = 5 mm → the ≤ 6 mm band (fz 0.02), not DC's ≤ 12 mm band
    const s = suggest({ tool: vbit(), engagement: { kind: 'chamfer', depth: 2.5 } })
    const n = (100 * 1000) / (Math.PI * 5)
    expect(value(s.spindleSpeed)).toBeCloseTo(n, 6)
    expect(value(s.feedRate)).toBeCloseTo(n * 2 * 0.02, 6)
    expect(s.stepdown.isNone()).toBe(true) // one pass at the chamfer depth
    expect(s.display.unwrap().dCalc).toBeCloseTo(5, 9)
    const steps = s.spindleSpeed.unwrap().derivation.map((d) => d.step)
    expect(steps).toEqual(['data', 'F10', 'F1'])
    // a flat tip adds to De; past the cone De stays DC
    const tipped = suggest({
      tool: vbit({ tipDiameter: len('1') }),
      engagement: { kind: 'chamfer', depth: 2.5 },
    })
    expect(tipped.display.unwrap().dCalc).toBeCloseTo(6, 9)
    const deep = suggest({ tool: vbit(), engagement: { kind: 'chamfer', depth: 20 } })
    expect(deep.display.unwrap().dCalc).toBe(12)
  })

  // Doc: docs/architecture/feeds-speeds.md#plunged-chamfers-hardening-df141
  it('DF141: a plunged chamfer: power is F12 at the plunge rate; an excess lowers the plunge only', () => {
    // 90° V-bit, tip 2.5 mm deep: De = 5 mm at the face, plunged into a Ø3 hole
    const plunged: Engagement = { kind: 'chamfer', depth: 2.5, plunge: { edgeDiameter: 3 } }
    const machine = limits({ power: Some(1000), maxSpeed: 24_000, rigidity: 'rigidMill' })
    const s = suggest({ tool: vbit(), engagement: plunged, machine })
    const contour = suggest({ tool: vbit(), engagement: { kind: 'chamfer', depth: 2.5 }, machine })
    expect(value(s.feedRate)).toBeCloseTo(value(contour.feedRate), 9)
    expect(value(s.plungeRate)).toBeCloseTo(value(contour.plungeRate), 9)
    // π/4 · (25 − 9) = 4π mm² per mm of plunge
    const pr = value(s.plungeRate)
    expect(plungedRemovalRate(5, 3, pr)).toBeCloseTo(4 * Math.PI * pr, 9)
    expect(s.display.unwrap().Q.unwrap()).toBeCloseTo(4 * Math.PI * pr, 6)
    expect(s.plungeRate.unwrap().derivation.map((d) => d.step)).toContain('F12')
    expect(codes(s)).not.toContain('feeds.powerExceeded')
    // a 5 W spindle: the plunge is lowered to fit, the (unused) feed is not
    const weak = limits({ power: Some(5), maxSpeed: 24_000, rigidity: 'rigidMill' })
    const w = suggest({ tool: vbit(), engagement: plunged, machine: weak })
    expect(value(w.feedRate)).toBeCloseTo(value(s.feedRate), 9)
    expect(value(w.plungeRate)).toBeLessThan(pr)
    expect(w.plungeRate.unwrap().derivation.map((d) => d.step)).toContain('power')
    expect(w.display.unwrap().spindleLoad.unwrap()).toBeLessThanOrEqual(100 + 1e-6)
    expect(w.warnings.find((x) => x.code === 'feeds.powerExceeded')?.message).toBe(
      'Cutting power exceeds the spindle: suggested plunge rate reduced to fit.',
    )
    // the final-value check and the display read the plunge rate
    const input = { tool: vbit(), materialClass: 'aluminum' as const, engagement: plunged }
    const at = { n: value(w.spindleSpeed), vf: value(w.feedRate), vp: value(w.plungeRate) }
    expect(checkCutting({ ...input, machine: weak }, at, TEST_DATA)).toEqual([])
    const over = checkCutting({ ...input, machine: weak }, { ...at, vp: 2 * at.vp }, TEST_DATA)
    expect(over.map((x) => [x.code, x.field])).toEqual([['feeds.powerExceeded', 'plungeRate']])
    expect(
      cuttingAt({ ...input, machine: weak }, at, TEST_DATA)
        .unwrap()
        .Q.unwrap(),
    ).toBeCloseTo(4 * Math.PI * at.vp, 6)
  })

  it('chamfer: De below the smallest charted diameter scales that chip load by De / 3.175', () => {
    // pointed 90° V-bit 0.5 mm deep: De = 1 mm (the ≤ 3 mm band is empty); fz = 0.02 · 1 / 3.175
    const s = suggest({ tool: vbit(), engagement: { kind: 'chamfer', depth: 0.5 } })
    expect(codes(s)).not.toContain('feeds.noData')
    const n = (100 * 1000) / Math.PI
    expect(value(s.spindleSpeed)).toBeCloseTo(n, 6)
    expect(s.display.unwrap().fz).toBeCloseTo(0.02 / 3.175, 9)
    expect(value(s.feedRate)).toBeCloseTo((n * 2 * 0.02) / 3.175, 6)
    expect(s.feedRate.unwrap().derivation.map((d) => d.step)).toContain('fzScale')
    // continuous at the charted diameter: De = 3.175 takes the chart value unscaled
    const at = suggest({ tool: vbit(), engagement: { kind: 'chamfer', depth: 3.175 / 2 } })
    expect(at.display.unwrap().fz).toBeCloseTo(0.02, 9)
  })

  it('DF123: a 15° engraving V-bit at a shallow depth: tiny De, the spindle clamp, a modest feed', () => {
    // Ø3.175, 15°, 0.5 mm deep: De = 2 · 0.5 · tan 7.5° = 0.132 mm, fz scaled by De / 3.175
    const v15 = vbit({ diameter: len('3.175'), angle: deg('15') })
    const v60 = vbit({ diameter: len('3.175'), angle: deg('60') })
    const de = Math.tan((7.5 * Math.PI) / 180)
    const machine = limits({ maxSpeed: 24_000, rigidity: 'rigidMill' })
    const at = (t: Tool) =>
      suggest({ tool: t, engagement: { kind: 'chamfer', depth: 0.5 }, machine })
    const s = at(v15)
    const s60 = at(v60)
    expect(s.display.unwrap().dCalc).toBeCloseTo(de, 9)
    expect(value(s.spindleSpeed)).toBe(24_000)
    expect(value(s60.spindleSpeed)).toBe(24_000)
    // chip load (and so the feed at the clamped speed) in proportion to De: never above a 60° bit's
    const ratio = de / (2 * 0.5 * Math.tan(Math.PI / 6))
    expect(s.display.unwrap().fz / s60.display.unwrap().fz).toBeCloseTo(ratio, 9)
    expect(value(s.feedRate) / value(s60.feedRate)).toBeCloseTo(ratio, 9)
    expect(value(s.feedRate)).toBeLessThan(150) // mm/min in aluminium: a light engraving feed
  })

  it('chamfer engagement needs a chamfer mill, and a chamfer mill a chamfer engagement', () => {
    expect(codes(suggest({ engagement: { kind: 'chamfer', depth: 1 } }))).toEqual(['feeds.noData'])
    expect(codes(suggest({ tool: vbit() }))).toEqual(['feeds.noData'])
  })
})

describe('suggestCutting: machine clamps', () => {
  it('rpm above the machine: n = max, fz kept, actual vc lower', () => {
    const s = suggest({
      tool: tool({ diameter: len('3') }),
      machine: limits({ maxSpeed: 24_000, rigidity: 'rigidMill' }),
    })
    expect(value(s.spindleSpeed)).toBe(24_000)
    expect(value(s.feedRate)).toBeCloseTo(24_000 * 2 * 0.03, 6)
    expect(s.display.unwrap().vc).toBeCloseTo((Math.PI * 3 * 24_000) / 1000, 6)
    expect(codes(s)).toEqual(['feeds.rpmAboveMachine', 'feeds.powerSkipped'])
  })

  it('rpm below the machine (router floor): n = min, fz kept, actual vc too high', () => {
    const s = suggest({ machine: limits({ minSpeed: 10_000 }) })
    expect(value(s.spindleSpeed)).toBe(10_000)
    expect(s.display.unwrap().fz).toBeCloseTo(0.02, 9)
    expect(codes(s)).toContain('feeds.rpmBelowMachine')
  })

  it('feed clamped: vf = max, n lowered to keep fz', () => {
    const s = suggest({ machine: limits({ maxFeedXY: 100 }) })
    expect(value(s.feedRate)).toBe(100)
    expect(value(s.spindleSpeed)).toBeCloseTo(100 / (2 * 0.02), 6)
    expect(s.display.unwrap().fz).toBeCloseTo(0.02, 9)
    expect(codes(s)).toContain('feeds.feedClamped')
    expect(codes(s)).not.toContain('feeds.rubbing')
    // DF56: the warning says the speed came down and the chip load stayed
    const w = clamped(s)
    expect(w.message).toBe(
      'Feed rate limited to the machine maximum (X/Y); spindle speed lowered with it, so the chip load stays.',
    )
    expect(w.params['spindleSpeed']).toBeCloseTo(100 / (2 * 0.02), 6)
    expect(w.params['suggestedSpindleSpeed']).toBeGreaterThan(w.params['spindleSpeed'] as number)
    expect(w.params['chipLoad']).toBeCloseTo(0.02, 9)
    expect(w.params['suggestedChipLoad']).toBeCloseTo(0.02, 9)
    expect(w.params['chipLoadDrop']).toBe(0)
  })

  it('feed clamped below the rpm floor: fz drops and the tool rubs', () => {
    const s = suggest({ machine: limits({ maxFeedXY: 100, minSpeed: 10_000 }) })
    expect(value(s.spindleSpeed)).toBe(10_000)
    expect(value(s.feedRate)).toBe(100)
    expect(s.display.unwrap().fz).toBeCloseTo(100 / (10_000 * 2), 9)
    expect(codes(s)).toEqual(expect.arrayContaining(['feeds.feedClamped', 'feeds.rubbing']))
    // DF56: the warning names the floor and the resulting chip load
    const w = clamped(s)
    expect(w.message).toBe(
      'Feed rate limited to the machine maximum (X/Y); the spindle speed stops at the machine minimum, so the chip load drops by 75 %.',
    )
    expect(w.params['chipLoad']).toBeCloseTo(0.005, 9)
    expect(w.params['suggestedChipLoad']).toBeCloseTo(0.02, 9)
    expect(w.params['chipLoadDrop']).toBeCloseTo(75, 6)
  })

  it('plunge rate is clamped to the Z maximum', () => {
    const s = suggest({ machine: limits({ maxFeedZ: 50 }) })
    expect(value(s.plungeRate)).toBe(50)
    expect(codes(s)).toContain('feeds.feedClamped')
  })

  it('property: n within the machine range and vf ≤ max feed for many inputs', () => {
    for (const d of ['1', '3', '6', '10', '20'])
      for (const r of ['extrusion', 'prosumer', 'rigidMill'] as const)
        for (const ae of [0.05, 0.3, 0.9]) {
          const D = Number(d)
          const m = limits({
            minSpeed: 8000,
            maxSpeed: 24_000,
            maxFeedXY: 2500,
            maxFeedZ: 800,
            rigidity: r,
          })
          const s = suggest({
            tool: tool({ diameter: len(d), fluteLength: len('30'), overallLength: len('80') }),
            engagement: { kind: 'stepover', ae: ae * D },
            machine: m,
          })
          const n = value(s.spindleSpeed)
          expect(n).toBeGreaterThanOrEqual(8000)
          expect(n).toBeLessThanOrEqual(24_000)
          expect(value(s.feedRate)).toBeLessThanOrEqual(2500)
          expect(value(s.plungeRate)).toBeLessThanOrEqual(800)
        }
  })
})

describe('suggestCutting: power check', () => {
  it('without spindle power the check is skipped (info)', () => {
    const s = suggest({ machine: limits() })
    expect(s.warnings.find((w) => w.code === 'feeds.powerSkipped')?.severity).toBe('info')
    expect(s.display.unwrap().Pc.isSome()).toBe(true)
    expect(s.display.unwrap().spindleLoad.isNone()).toBe(true)
  })

  it('computes Pc = Q·u/60 000 and the spindle load', () => {
    const s = suggest({
      machine: limits({ power: Some(1000), maxSpeed: 24_000, rigidity: 'rigidMill' }),
    })
    const d = s.display.unwrap()
    expect(d.Q.unwrap()).toBeCloseTo(6 * 3 * value(s.feedRate), 6)
    expect(d.Pc.unwrap()).toBeCloseTo((d.Q.unwrap() * 0.6) / 60_000, 9)
    const avail = availablePower(1000, value(s.spindleSpeed), 24_000)
    expect(d.spindleLoad.unwrap()).toBeCloseTo((d.Pc.unwrap() / avail) * 100, 6)
    expect(codes(s)).toEqual([])
  })

  it('exceeded with a calculator-owned stepdown: stepdown reduced until Pc fits', () => {
    const m = limits({ power: Some(100), maxSpeed: 24_000, rigidity: 'rigidMill' })
    const s = suggest({ machine: m })
    expect(value(s.stepdown)).toBeLessThan(3)
    expect(s.display.unwrap().spindleLoad.unwrap()).toBeLessThanOrEqual(100)
    expect(codes(s)).toEqual(['feeds.powerExceeded'])
    expect(s.stepdown.unwrap().derivation.map((d) => d.step)).toContain('power')
  })

  it('exceeded with a locked stepdown: the unlocked feed is reduced to fit (n kept)', () => {
    const m = limits({ power: Some(100), maxSpeed: 24_000 })
    const free = suggest({ machine: limits({ maxSpeed: 24_000 }), locked: { ap: 5 } })
    const s = suggest({ machine: m, locked: { ap: 5 } })
    expect(value(s.spindleSpeed)).toBeCloseTo(value(free.spindleSpeed), 9)
    expect(value(s.feedRate)).toBeLessThan(value(free.feedRate))
    expect(s.display.unwrap().spindleLoad.unwrap()).toBeLessThanOrEqual(100)
    expect(codes(s)).toEqual(expect.arrayContaining(['feeds.powerExceeded', 'feeds.rubbing']))
    expect(s.feedRate.unwrap().derivation.map((d) => d.step)).toContain('power')
  })

  it('exceeded with locked stepdown and feed: warn only', () => {
    const m = limits({ power: Some(100), maxSpeed: 24_000 })
    const s = suggest({ machine: m, locked: { ap: 5, vf: 600 } })
    expect(value(s.feedRate)).toBe(600)
    expect(s.display.unwrap().spindleLoad.unwrap()).toBeGreaterThan(100)
    expect(codes(s)).toContain('feeds.powerExceeded')
  })

  it('property: Pc is monotonic in ap', () => {
    for (const type of ['flatEndMill', 'ballEndMill'] as const) {
      let last = 0
      for (let ap = 0.1; ap <= 6; ap += 0.1) {
        const s = suggest({
          tool: tool({ type }),
          locked: { ap },
          machine: limits({ maxSpeed: 24_000 }),
        })
        const pc = s.display.unwrap().Pc.unwrap()
        expect(pc, `${type} ap ${ap}`).toBeGreaterThanOrEqual(last)
        last = pc
      }
    }
  })
})

describe('suggestCutting: explanation', () => {
  it('each field lists its formula steps with inputs and results', () => {
    const s = suggest({
      engagement: { kind: 'stepover', ae: 0.45 },
      machine: limits({ maxSpeed: 5000 }),
    })
    const steps = s.feedRate.unwrap().derivation
    expect(steps.map((d) => d.step)).toEqual(['data', 'F1', 'rpmClamp', 'data', 'F3', 'F5', 'F2'])
    const f1 = steps.find((d) => d.step === 'F1')!
    expect(f1.formula).toBe('n = vc·1000 / (π·Dcalc)')
    expect(f1.inputs).toEqual({ vc: 100, Dcalc: 6 })
    expect(f1.result).toBeCloseTo((100 * 1000) / (Math.PI * 6), 6)
    expect(f1.unit).toBe('rpm')
    const f2 = steps.find((d) => d.step === 'F2')!
    expect(f2.result).toBe(value(s.feedRate))
    expect(s.spindleSpeed.unwrap().derivation.map((d) => d.step)).toEqual([
      'data',
      'F1',
      'rpmClamp',
    ])
    expect(s.plungeRate.unwrap().derivation.at(-1)?.step).toBe('F9')
    expect(s.stepdown.unwrap().derivation.map((d) => d.step)).toEqual(['data', 'rigidity'])
  })

  it('the data step cites the row sources', () => {
    const s = suggest()
    const data = s.spindleSpeed.unwrap().derivation[0]!
    expect(data.sources).toEqual(['test fixture (synthetic)'])
  })

  it('warnings carry a message and params for the UI and agents', () => {
    const s = suggest({ machine: limits({ minSpeed: 10_000 }) })
    const w = s.warnings.find((x) => x.code === 'feeds.rpmBelowMachine')!
    expect(w.severity).toBe('warning')
    expect(w.message).toMatch(/minimum/)
    expect(w.params).toMatchObject({ minSpeed: 10_000 })
  })
})

describe('machineLimits', () => {
  it('reads the machine: min(x, y) feed, z feed, speeds, power, rigidity (default lowest)', () => {
    const raw = {
      ...machineValues(),
      spindle: {
        control: 'gcode' as const,
        maxSpeed: rpm('24000'),
        minSpeed: rpm('8000'),
        power: watt('1.5 kW'),
      },
    }
    const m = expectOk(
      parseWith(MachineValuesDtoSchema, raw, 'test').andThen((d) => Machine.fromDTO(d)),
    )
    const { power, ...rest } = machineLimits(m)
    expect(rest).toEqual({
      minSpeed: 8000,
      maxSpeed: 24_000,
      maxFeedXY: 5000,
      maxFeedZ: 1000,
      rigidity: 'extrusion',
    })
    expect(power.unwrap()).toBe(1500)
  })
})

// docs/architecture/feeds-speeds.md#locked-inputs (task 3.14)
describe('suggestCutting: locked inputs', () => {
  const n0 = (100 * 1000) / (Math.PI * 6) // F1 at vc.min, D 6
  it('locked n replaces F1 and the rpm clamp; vf follows it with the data chip load', () => {
    const s = suggest({ locked: { n: 5000 }, machine: limits({ maxSpeed: 4000 }) })
    expect(value(s.spindleSpeed)).toBe(5000)
    expect(s.spindleSpeed.unwrap().derivation.map((d) => d.step)).toEqual(['locked'])
    expect(value(s.feedRate)).toBeCloseTo(5000 * 2 * 0.02, 6)
    expect(codes(s)).not.toContain('feeds.rpmAboveMachine')
  })

  it('locked n with a feed above the machine: vf clamped, n stays, fz drops (rubbing)', () => {
    const s = suggest({ locked: { n: 5000 }, machine: limits({ maxFeedXY: 100 }) })
    expect(value(s.spindleSpeed)).toBe(5000)
    expect(value(s.feedRate)).toBe(100)
    expect(s.display.unwrap().fz).toBeCloseTo(100 / (5000 * 2), 9)
    expect(codes(s)).toEqual(expect.arrayContaining(['feeds.feedClamped', 'feeds.rubbing']))
    expect(clamped(s).message).toBe(
      'Feed rate limited to the machine maximum (X/Y); the spindle speed is locked, so the chip load drops by 50 %.',
    )
    expect(clamped(s).params['spindleSpeed']).toBe(5000)
    expect(clamped(s).params['suggestedSpindleSpeed']).toBe(5000)
  })

  it('locked vf: n = vf / (z·fz) from the data chip load', () => {
    const s = suggest({ locked: { vf: 400 } })
    expect(value(s.feedRate)).toBe(400)
    expect(value(s.spindleSpeed)).toBeCloseTo(400 / (2 * 0.02), 6)
    expect(s.display.unwrap().fz).toBeCloseTo(0.02, 9)
    expect(value(s.plungeRate)).toBeCloseTo(0.3 * 400, 6) // F9 follows the locked feed
  })

  it('locked vf with n clamped to the spindle range: fz follows (chipLoadHigh / rubbing)', () => {
    const high = suggest({ locked: { vf: 4000 }, machine: limits({ maxSpeed: 10_000 }) })
    expect(value(high.spindleSpeed)).toBe(10_000)
    expect(high.display.unwrap().fz).toBeCloseTo(4000 / (10_000 * 2), 9)
    expect(codes(high)).toContain('feeds.chipLoadHigh')
    expect(codes(high)).not.toContain('feeds.rpmAboveMachine')
    const low = suggest({ locked: { vf: 100 }, machine: limits({ minSpeed: 10_000 }) })
    expect(value(low.spindleSpeed)).toBe(10_000)
    expect(codes(low)).toContain('feeds.rubbing')
  })

  it('locked n and vf: chip load is derived and only warns', () => {
    const s = suggest({ locked: { n: 1000, vf: 1000 } })
    expect(value(s.spindleSpeed)).toBe(1000)
    expect(value(s.feedRate)).toBe(1000)
    expect(s.display.unwrap().fz).toBeCloseTo(0.5, 9)
    expect(codes(s)).toContain('feeds.chipLoadHigh')
  })

  it('locked ap: used for F4–F7, no stepdown suggested', () => {
    const s = suggest({ locked: { ap: 2 } })
    expect(s.stepdown.isNone()).toBe(true)
    expect(value(s.spindleSpeed)).toBeCloseTo(n0, 6)
    expect(s.display.unwrap().Q.unwrap()).toBeCloseTo(6 * 2 * value(s.feedRate), 6)
  })

  it('locked ae (facing): the engagement uses it instead of the strategy stepover', () => {
    const s = suggest({ engagement: { kind: 'stepover', ae: 4.5 }, locked: { ae: 0.45 } })
    expect(s.display.unwrap().chipThinning).toBeCloseTo(rctf(0.45, 6), 9)
    // a slot ignores ae
    expect(suggest({ locked: { ae: 0.45 } }).display.unwrap().chipThinning).toBe(1)
  })

  it('drilling: locked n → vf = fn·n; locked vf → n = vf / fn, clamped (fn follows)', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    const e: Engagement = { kind: 'drill' }
    const byN = suggest({ tool: drill, engagement: e, locked: { n: 2000 } })
    expect(value(byN.feedRate)).toBeCloseTo(0.05 * 2000, 6)
    const byVf = suggest({ tool: drill, engagement: e, locked: { vf: 200 } })
    expect(value(byVf.spindleSpeed)).toBeCloseTo(200 / 0.05, 6)
    const clamped = suggest({
      tool: drill,
      engagement: e,
      locked: { vf: 2000 },
      machine: limits({ maxSpeed: 5000 }),
    })
    expect(value(clamped.spindleSpeed)).toBe(5000)
    expect(codes(clamped)).toContain('feeds.chipLoadHigh')
  })
})

describe('noDataFor', () => {
  it('returns the feeds.noData warning only when there is no data', () => {
    const input = { tool: tool(), materialClass: 'aluminum' as const, engagement: SLOT }
    expect(noDataFor({ ...input, machine: None }, TEST_DATA).isNone()).toBe(true)
    expect(
      noDataFor({ ...input, materialClass: 'other', machine: None }, TEST_DATA).unwrap().code,
    ).toBe('feeds.noData')
  })

  it('a tapered ball end mill only by its taper engagement, never a flat end mill of its large end Ø', () => {
    const taper = tool({
      type: 'taperedBallEndMill',
      diameter: len('3.175'),
      tipDiameter: len('0.5'),
      taperAngle: deg('3.6'),
      presets: [],
    })
    const w = noDataFor(
      { tool: taper, materialClass: 'aluminum', engagement: SLOT, machine: None },
      TEST_DATA,
    ).unwrap()
    expect(w.code).toBe('feeds.noData')
    expect(w.message).toMatch(/slot cut does not fit a tapered ball end mill/)
    const chamfer = tool({ type: 'chamferMill', diameter: len('6'), angle: deg('90') })
    expect(
      noDataFor(
        {
          tool: chamfer,
          materialClass: 'aluminum',
          engagement: { kind: 'taper', depth: 1 },
          machine: None,
        },
        TEST_DATA,
      ).unwrap().code,
    ).toBe('feeds.noData')
  })
})

// docs/architecture/feeds-speeds.md#final-value-check (task 3.14)
describe('checkCutting', () => {
  const input = (over: Partial<CuttingInput> = {}): CuttingInput => ({
    tool: tool(),
    materialClass: 'aluminum',
    engagement: SLOT,
    machine: None,
    ...over,
  })
  const check = (over: Partial<CuttingInput>, values: Parameters<typeof checkCutting>[1]) =>
    checkCutting(input(over), values, TEST_DATA).map((w) => [w.code, w.field])

  it('chip load inside the data range: no warning', () => {
    expect(check({}, { n: 1000, vf: 1000 * 2 * 0.04, ap: 1 })).toEqual([])
  })

  it('chip load below / above the data range warns on the feed', () => {
    expect(check({}, { n: 1000, vf: 10, ap: 1 })).toEqual([['feeds.rubbing', 'feedRate']])
    expect(check({}, { n: 1000, vf: 1000, ap: 1 })).toEqual([['feeds.chipLoadHigh', 'feedRate']])
  })

  it('chip thinning at the final facing stepover is credited', () => {
    // fz 0.07 is above the 0.06 max at ae = D, but within it after RCTF at ae = 0.45
    const facing = { engagement: { kind: 'stepover', ae: 4.5 } as Engagement }
    expect(check(facing, { n: 1000, vf: 140, ap: 1, ae: 6 })).toEqual([
      ['feeds.chipLoadHigh', 'feedRate'],
    ])
    expect(check(facing, { n: 1000, vf: 140, ap: 1, ae: 0.45 })).toEqual([])
  })

  it('power at the final values warns on the stepdown', () => {
    const machine = limits({ power: Some(100), maxSpeed: 24_000 })
    expect(check({ machine }, { n: 24_000, vf: 2000, ap: 5 })).toEqual([
      ['feeds.powerExceeded', 'stepdown'],
    ])
    expect(check({ machine }, { n: 24_000, vf: 2000, ap: 0.05 })).toEqual([])
  })

  it('no data → no warnings', () => {
    expect(check({ materialClass: 'other' }, { n: 1000, vf: 1, ap: 1 })).toEqual([])
  })
})

describe('cuttingAt', () => {
  const input = (over: Partial<CuttingInput> = {}): CuttingInput => ({
    tool: tool(),
    materialClass: 'aluminum',
    engagement: SLOT,
    machine: None,
    ...over,
  })

  it('slot: vc from n and D, chip load without thinning, Q = D·ap·vf, Pc = Q·u/60000', () => {
    const d = cuttingAt(input(), { n: 10_000, vf: 1000, ap: 2 }, TEST_DATA).unwrap()
    expect(d.dCalc).toBe(6)
    expect(d.vc).toBeCloseTo((Math.PI * 6 * 10_000) / 1000, 9)
    expect(d.chipThinning).toBe(1)
    expect(d.fz).toBeCloseTo(1000 / (10_000 * 2), 12)
    expect(d.Q.unwrap()).toBeCloseTo(6 * 2 * 1000, 9)
    expect(d.Pc.unwrap()).toBeCloseTo((12_000 * 0.6) / 60_000, 12)
    expect(d.spindleLoad).toEqual(None) // no machine power
  })

  it('facing at the used stepover credits chip thinning; spindle load against Pavail', () => {
    const machine = limits({ power: Some(1000), maxSpeed: 20_000 })
    const d = cuttingAt(
      input({ engagement: { kind: 'stepover', ae: 4.5 }, machine }),
      { n: 10_000, vf: 1000, ap: 1, ae: 0.6 },
      TEST_DATA,
    ).unwrap()
    expect(d.chipThinning).toBeCloseTo(rctf(0.6, 6), 12)
    expect(d.fz).toBeCloseTo(1000 / (10_000 * 2 * rctf(0.6, 6)), 12)
    const pc = (0.6 * 1 * 1000 * 0.6) / 60_000
    expect(d.spindleLoad.unwrap()).toBeCloseTo((pc / availablePower(1000, 10_000, 20_000)) * 100, 9)
  })

  it('drill: fn = vf / n, no power values', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    const d = cuttingAt(
      input({ tool: drill, engagement: { kind: 'drill' } }),
      { n: 2000, vf: 200 },
      TEST_DATA,
    ).unwrap()
    expect(d.fz).toBeCloseTo(0.1, 12)
    expect(d.Q).toEqual(None)
    expect(d.Pc).toEqual(None)
  })

  it('no data or no speed: None', () => {
    expect(cuttingAt(input({ materialClass: 'other' }), { n: 1, vf: 1 }, TEST_DATA)).toEqual(None)
    expect(cuttingAt(input(), { n: 0, vf: 1 }, TEST_DATA)).toEqual(None)
  })
})

// docs/architecture/feeds-speeds.md#finishing-pass-feed-hardening-df74
describe('finishingAt', () => {
  const input = (over: Partial<CuttingInput> = {}): CuttingInput => ({
    tool: tool(),
    materialClass: 'aluminum',
    engagement: { kind: 'stepover', ae: 2.4 },
    machine: None,
    ...over,
  })

  it('keeps the roughing chip load at the allowance: vf · kf / kr', () => {
    const f = finishingAt(input(), { n: 10_000, vf: 1000, ap: 6, ae: 2.4 }, 0.2, 6, TEST_DATA)
    const kr = rctf(2.4, 6)
    const kf = rctf(0.2, 6)
    expect(f.unwrap()).toMatchObject({ allowance: 0.2, clamped: false, minimum: 0.02 })
    expect(f.unwrap().chipThinning).toBeCloseTo(kf, 12)
    expect(f.unwrap().feedRate).toBeCloseTo((1000 * kf) / kr, 9)
    // the same chip as roughing
    expect(f.unwrap().fz).toBeCloseTo(1000 / (10_000 * 2 * kr), 12)
  })

  it('held at the machine feed limit: the chip thins (clamped)', () => {
    const machine = limits({ maxFeedXY: 1500 })
    const f = finishingAt(
      input({ machine }),
      { n: 10_000, vf: 1000, ap: 6, ae: 2.4 },
      0.2,
      6,
      TEST_DATA,
    )
    expect(f.unwrap().feedRate).toBe(1500)
    expect(f.unwrap().clamped).toBe(true)
    expect(f.unwrap().fz).toBeCloseTo(1500 / (10_000 * 2 * rctf(0.2, 6)), 12)
  })

  it('a slot roughs at full width; no allowance, drills or no data: None', () => {
    const f = finishingAt(
      input({ engagement: SLOT }),
      { n: 10_000, vf: 600, ap: 3 },
      0.5,
      6,
      TEST_DATA,
    )
    expect(f.unwrap().feedRate).toBeCloseTo(600 * rctf(0.5, 6), 9)
    expect(finishingAt(input(), { n: 10_000, vf: 1000 }, 0, 6, TEST_DATA)).toEqual(None)
    expect(
      finishingAt(input({ materialClass: 'other' }), { n: 10_000, vf: 1000 }, 0.2, 6, TEST_DATA),
    ).toEqual(None)
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    expect(
      finishingAt(
        input({ tool: drill, engagement: { kind: 'drill' } }),
        { n: 1, vf: 1 },
        0.2,
        6,
        TEST_DATA,
      ),
    ).toEqual(None)
  })
})
