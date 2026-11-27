// Spec: docs/architecture/feeds-speeds.md#formulas (task 2.12). Each golden test names its source.
import { describe, expect, it } from 'vitest'
import {
  actf,
  availablePower,
  chamferEffectiveDiameter,
  chamferFullDepth,
  chipThinning,
  cuttingPower,
  CHIP_THINNING_CAP,
  drillFeed,
  effectiveDiameter,
  feedRate,
  materialRemovalRate,
  plungeRate,
  rctf,
  spindleSpeed,
  taperedStepdown,
  unitPowerFromKp,
} from './formulas'
import { taperedGrooveWidth } from '../library/tool'

const IN = 25.4

describe('F1 spindle speed', () => {
  it('n = vc·1000 / (π·D) [S1 "Spindle speed, r/min"]', () => {
    // vc 300 m/min, D 10 mm: 300 000 / 31.4159… = 9549.3 rpm
    expect(spindleSpeed(300, 10)).toBeCloseTo(9549.297, 3)
    // [MH] inch form n = 12·SFM / (π·D): 500 SFM, D 0.5″ → 3819.7 rpm; same result in metric
    expect(spindleSpeed(500 * 0.3048, 0.5 * IN)).toBeCloseTo((12 * 500) / (Math.PI * 0.5), 6)
  })
})

describe('F2 feed rate', () => {
  it('vf = n · z · fz [S1 "Table feed"]', () => {
    expect(feedRate(10_000, 2, 0.05)).toBeCloseTo(1000, 9)
  })
})

describe('F3 radial chip thinning (RCTF)', () => {
  it('ae/D = 0.075 → ×1.90 [MD]', () => {
    expect(rctf(0.075 * 10, 10)).toBeCloseTo(1.9, 2)
  })

  it('is 1 at ae ≥ D/2 (no thinning)', () => {
    expect(rctf(5, 10)).toBe(1)
    expect(rctf(7.5, 10)).toBe(1)
    expect(rctf(10, 10)).toBe(1)
  })

  it('just below D/2 is continuous with 1', () => {
    expect(rctf(4.999_99, 10)).toBeCloseTo(1, 6)
  })
})

describe('F4 effective diameter', () => {
  it('Kennametal KDMB ball nose D 0.312″, ap 0.047″ → De 0.223″ [K1]', () => {
    const D = 0.312 * IN
    const De = effectiveDiameter(D, D / 2, 0.047 * IN)
    expect(De / IN).toBeCloseTo(0.223, 3)
  })

  it('ball nose: De = 2√(ap(D − ap)) [HT1]', () => {
    expect(effectiveDiameter(10, 5, 1)).toBeCloseTo(2 * Math.sqrt(1 * 9), 9)
  })

  it('De = D when ap ≥ RE, and for a flat end mill (RE = 0)', () => {
    expect(effectiveDiameter(10, 5, 5)).toBe(10)
    expect(effectiveDiameter(10, 1, 3)).toBe(10)
    expect(effectiveDiameter(10, 0, 0.5)).toBe(10)
  })

  it('bull nose below the corner radius: De = D − 2·RE + 2√(ap(2·RE − ap)) [K1]', () => {
    expect(effectiveDiameter(10, 2, 1)).toBeCloseTo(10 - 4 + 2 * Math.sqrt(3), 9)
  })
})

describe('F5 axial chip thinning (ACTF)', () => {
  it('hex = fz·sin κ, cos κ = (RE − ap)/RE [S1]: RE 5, ap 1 → sin κ 0.6 → ×1/0.6', () => {
    expect(actf(5, 1)).toBeCloseTo(1 / 0.6, 9)
  })

  it('none for a flat end mill (κ = 90°) or at ap ≥ RE', () => {
    expect(actf(0, 1)).toBe(1)
    expect(actf(5, 5)).toBe(1)
    expect(actf(5, 8)).toBe(1)
  })
})

describe('chip thinning cap', () => {
  it('RCTF × ACTF is capped at ×3 [MD]', () => {
    expect(CHIP_THINNING_CAP).toBe(3)
    expect(chipThinning(1.9, 1)).toBeCloseTo(1.9, 9)
    expect(chipThinning(rctf(0.01, 10), 1)).toBe(3)
    expect(chipThinning(2, 2)).toBe(3) // the product is capped, not only each factor
    expect(chipThinning(rctf(0, 10), 1)).toBe(3) // ae → 0: unbounded factor, capped
  })
})

describe('F6 material removal rate', () => {
  it('Q = ae · ap · vf (mm³/min) [S1 "Metal removal rate" × 1000]', () => {
    expect(materialRemovalRate(6, 2, 1000)).toBe(12_000)
  })
})

describe('F7 cutting power', () => {
  it('agrees with S1 net power Pc = ae·ap·vf·kc / (60·10⁶) for u = kc / 1000 [S1]', () => {
    // ae 6, ap 2, vf 1000, kc 800 N/mm²: Pc = 6·2·1000·800 / 6e7 = 0.16 kW
    const Q = materialRemovalRate(6, 2, 1000)
    expect(cuttingPower(Q, 800 / 1000)).toBeCloseTo(0.16, 12)
    expect(cuttingPower(Q, 0.8)).toBeCloseTo((6 * 2 * 1000 * 800) / 60e6, 12)
  })

  it('u = Kp · 2.73: 1 hp/(in³/min) = 745.7 W·60 s / 16 387 mm³ [MH], [AD]', () => {
    const exact = (745.6998715822702 * 60) / IN ** 3
    expect(exact).toBeCloseTo(2.73, 2)
    expect(unitPowerFromKp(0.25)).toBeCloseTo(0.6825, 9)
  })

  it('available power: η = 0.8, constant torque below max speed', () => {
    expect(availablePower(1000, 24_000, 24_000)).toBeCloseTo(0.8, 12)
    expect(availablePower(1000, 12_000, 24_000)).toBeCloseTo(0.4, 12)
    expect(availablePower(1000, 30_000, 24_000)).toBeCloseTo(0.8, 12)
  })
})

describe('F8 drilling feed', () => {
  it('vf = fn · n [S2]', () => {
    expect(drillFeed(0.1, 2000)).toBeCloseTo(200, 9)
  })
})

describe('F9 plunge rate', () => {
  it('plungeRate = kPlunge · vf (doc examples 0.5 wood/plastic, 0.3 metals)', () => {
    expect(plungeRate(0.5, 2000)).toBe(1000)
    expect(plungeRate(0.3, 1000)).toBeCloseTo(300, 9)
  })
})

describe('F10 chamfer mill effective diameter (v0.4 C1)', () => {
  it('De = dt + 2·depth·tan(α/2), at most DC', () => {
    // 90° V-bit: De = 2·depth; 1.5 mm deep → Ø3
    expect(chamferEffectiveDiameter(0, 1.5, 90, 12)).toBeCloseTo(3, 9)
    // 60° with a 0.5 mm flat tip, 2 mm deep: 0.5 + 4·tan 30° = 2.809
    expect(chamferEffectiveDiameter(0.5, 2, 60, 12)).toBeCloseTo(0.5 + 4 / Math.sqrt(3), 9)
    // the cone ends at DC
    expect(chamferEffectiveDiameter(0, 10, 90, 12)).toBe(12)
    expect(chamferEffectiveDiameter(0.2, 0, 90, 12)).toBe(0.2)
  })

  it('the full depth is where De reaches DC', () => {
    const depth = chamferFullDepth(0.5, 60, 6)
    expect(chamferEffectiveDiameter(0.5, depth, 60, 6)).toBeCloseTo(6, 9)
    expect(chamferFullDepth(0, 90, 12)).toBeCloseTo(6, 9)
  })
})

// docs/architecture/feeds-speeds.md#tapered-ball-end-mills-hardening-df124
describe('F11 tapered ball end mill: stepdown against the groove width (DF124 T2)', () => {
  const W = (ap: number) => taperedGrooveWidth(0.5, 3.6, 3.175, ap)
  it('the largest ap with ap ≤ k · De(ap): on the cone, the ball and beyond the cone', () => {
    // the doc's example: R0.25, 3.6°, k = 1 → ≈ 0.54 mm (on the cone)
    const cone = taperedStepdown(0.5, 3.6, 3.175, 1)
    expect(cone).toBeCloseTo(0.537, 3)
    expect(cone).toBeCloseTo(W(cone), 9)
    // small k: on the ball (below h_t = 0.234 mm)
    const ball = taperedStepdown(0.5, 3.6, 3.175, 0.3)
    expect(ball).toBeLessThan(0.234)
    expect(ball).toBeCloseTo(0.3 * W(ball), 9)
    // huge k: De is DC beyond the cone (h_D = 21.5 mm)
    expect(taperedStepdown(0.5, 3.6, 3.175, 10)).toBeCloseTo(31.75, 9)
    expect(taperedStepdown(0.5, 3.6, 3.175, 0)).toBe(0)
  })
})
