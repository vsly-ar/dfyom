// Spec: docs/architecture/feeds-speeds.md (task 2.12). Material numbers come from the synthetic
// TEST_DATA fixture, so these tests check the calculator's logic, not cutting data.
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
  machineLimits,
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

  it('the shipped (empty, pending curation) table gives feeds.noData, never invented numbers', () => {
    const s = suggestCutting({
      tool: tool(),
      materialClass: 'aluminum',
      engagement: SLOT,
      machine: None,
    })
    expect(codes(s)).toEqual(['feeds.noData'])
    expect(MATERIAL_DATA).toHaveLength(0)
  })
})

describe('suggestCutting: rigidity scaling', () => {
  const at = (rigidity: Rigidity) => suggest({ machine: limits({ rigidity }) })

  it('rangePos moves vc and fz within their ranges; apFactor scales the stepdown', () => {
    const cases: [Rigidity, number, number, number][] = [
      ['extrusion', 100, 0.02, 0.9],
      ['hobby', 150, 0.03, 1.5],
      ['prosumer', 200, 0.04, 2.25],
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
    const s = suggest({ engagement: { kind: 'slot', ap: 1.2 } })
    expect(s.stepdown.isNone()).toBe(true)
    expect(s.display.unwrap().Q.unwrap()).toBeCloseTo(6 * 1.2 * value(s.feedRate), 6) // F6, slot ae = D
  })

  it('ball nose at ap < RE: n from the effective diameter (F4) and axial thinning (F5)', () => {
    const ball = tool({ type: 'ballEndMill' })
    const s = suggest({ tool: ball, engagement: { kind: 'slot', ap: 1 } })
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

  it('exceeded with a given stepdown: warn only', () => {
    const m = limits({ power: Some(100), maxSpeed: 24_000 })
    const s = suggest({ machine: m, engagement: { kind: 'slot', ap: 5 } })
    expect(s.display.unwrap().spindleLoad.unwrap()).toBeGreaterThan(100)
    expect(codes(s)).toEqual(['feeds.powerExceeded'])
  })

  it('property: Pc is monotonic in ap', () => {
    for (const type of ['flatEndMill', 'ballEndMill'] as const) {
      let last = 0
      for (let ap = 0.1; ap <= 6; ap += 0.1) {
        const s = suggest({
          tool: tool({ type }),
          engagement: { kind: 'slot', ap },
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
