// Spec: docs/architecture/feeds-speeds.md (task 2.12). Material numbers come from the synthetic
// TEST_DATA fixture, so these tests check the calculator's logic, not cutting data – except the
// golden cases on the shipped table, which check the curated rows against their cited charts.
import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { None, Some, type Option } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { deg, flatEndMillValues, len, machineValues, rpm, watt } from '../library/library.fixture'
import { Machine } from '../library/machine'
import { MachineValuesDtoSchema, type Rigidity } from '../library/machine.dto'
import { Tool } from '../library/tool'
import { ToolValuesDtoSchema } from '../library/tool.dto'
import { MATERIAL_DATA } from './data'
import { TEST_DATA } from './data.fixture'
import { availablePower, rctf } from './formulas'
import {
  checkCutting,
  cuttingAt,
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
    }
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

  it('6 mm 2F carbide flat slotting 6061 aluminium, hobby: Harvey Tool SFM and 1/8" chip load', () => {
    const s = shipped({})
    expect(codes(s)).toEqual(['feeds.powerSkipped'])
    const d = s.display.unwrap()
    const vcSfm = d.vc / 0.3048
    expect(vcSfm).toBeCloseTo(537.5, 6) // 500–650 SFM at rangePos 0.25
    expect(vcSfm).toBeGreaterThanOrEqual(500) // Harvey guide, Aluminum 440/356/380: 500–1000 SFM
    expect(vcSfm).toBeLessThanOrEqual(1000) // Harvey SF_13900 slotting, wrought: 1000 SFM
    expect(value(s.spindleSpeed)).toBeCloseTo((537.5 * 0.3048 * 1000) / (Math.PI * 6), 6)
    expect(d.fz / IN).toBeCloseTo(0.001, 12) // Harvey guide, aluminium 1/8": .001 IPT
    expect(d.fz / IN).toBeLessThanOrEqual(0.00151) // Harvey SF_13900 slotting 0.125": .00151
    expect(value(s.stepdown)).toBeCloseTo(6 * 0.5 * 0.5, 9) // SF_13900 slot axial .50 x Dia × hobby
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

  it('HSS, drills and tools ≤ 3 mm have no data (feeds.noData → strategy/preset fallback)', () => {
    const drill = tool({ type: 'drill', diameter: len('5'), pointAngle: deg('118') })
    for (const s of [
      shipped({ tool: tool({ toolMaterial: 'hss' }) }),
      shipped({ tool: drill, engagement: { kind: 'drill' } }),
      shipped({ tool: tool({ diameter: len('3') }), materialClass: 'softwood' }),
    ])
      expect(codes(s)).toEqual(['feeds.noData'])
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
  })

  it('feed clamped below the rpm floor: fz drops and the tool rubs', () => {
    const s = suggest({ machine: limits({ maxFeedXY: 100, minSpeed: 10_000 }) })
    expect(value(s.spindleSpeed)).toBe(10_000)
    expect(value(s.feedRate)).toBe(100)
    expect(s.display.unwrap().fz).toBeCloseTo(100 / (10_000 * 2), 9)
    expect(codes(s)).toEqual(expect.arrayContaining(['feeds.feedClamped', 'feeds.rubbing']))
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
