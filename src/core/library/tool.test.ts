import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { deg, feed, flatEndMillValues, len, num, rpm } from './library.fixture'
import { taperHeights, Tool } from './tool'
import { ToolValuesDtoSchema } from './tool.dto'

const load = (raw: unknown) =>
  parseWith(ToolValuesDtoSchema, raw, 'test').andThen((dto) => Tool.fromDTO(dto))

const issues = (raw: unknown) =>
  expectErrCode(load(raw), 'model.invariant').issues.map((i) => [i.path.join('.'), i.rule])

const flat = flatEndMillValues
const preset = flat().presets[0]!

describe('Tool', () => {
  it('round-trips a flat end mill with a preset', () => {
    const t = expectOk(load(flat()))
    expect(t.type).toBe('flatEndMill')
    expect(t.diameter.canonical).toBe(6)
    expect(t.presets).toHaveLength(1)
    expect(t.presets[0]!.materialClass.unwrap()).toBe('aluminum')
    expect(t.toDTO()).toEqual(flat())
  })

  it('round-trips all optional fields', () => {
    const full = {
      ...flat(),
      notes: 'Sorotec',
      stickout: len('25'),
      shankDiameter: len('6'),
      toolMaterial: 'carbide' as const,
      coating: 'ZrN',
    }
    expect(expectOk(load(full)).toDTO()).toEqual(full)
  })

  it('a bull nose end mill needs 0 < cornerRadius < diameter/2', () => {
    const bull = { ...flat(), type: 'bullNoseEndMill', cornerRadius: len('1') }
    expect(expectOk(load(bull)).cornerRadius.unwrap().canonical).toBe(1)
    expect(issues({ ...bull, cornerRadius: len('3') })).toEqual([['cornerRadius', 'range']])
    expect(issues({ ...bull, cornerRadius: len('0') })).toEqual([['cornerRadius', 'range']])
    expect(issues({ ...flat(), type: 'bullNoseEndMill' })).toEqual([['cornerRadius', 'required']])
  })

  it('flat and ball corner radii are derived, not stored', () => {
    expect(issues({ ...flat(), cornerRadius: len('1') })).toEqual([['cornerRadius', 'notAllowed']])
    expect(issues({ ...flat(), type: 'ballEndMill', cornerRadius: len('3') })).toEqual([
      ['cornerRadius', 'notAllowed'],
    ])
  })

  it('a drill needs a point angle 0° < SIG < 180°; other types must not have one', () => {
    const drill = { ...flat(), type: 'drill', presets: [], pointAngle: deg('118') }
    expect(expectOk(load(drill)).pointAngle.unwrap().canonical).toBe(118)
    expect(issues({ ...drill, pointAngle: deg('180') })).toEqual([['pointAngle', 'range']])
    expect(issues({ ...drill, pointAngle: undefined })).toEqual([['pointAngle', 'required']])
    expect(issues({ ...flat(), pointAngle: deg('118') })).toEqual([['pointAngle', 'notAllowed']])
  })

  it('a chamfer mill needs an angle of 10°–150° and a tip 0 ≤ dt < DC; only it stores them', () => {
    const chamfer = {
      ...flat(),
      type: 'chamferMill',
      diameter: len('12'),
      presets: [],
      angle: deg('90'),
    }
    const t = expectOk(load(chamfer))
    expect(t.angle.unwrap().canonical).toBe(90)
    expect(t.tipDiameterMm).toBe(0) // absent = pointed
    expect(t.toDTO()).toEqual(chamfer)
    const flatTip = { ...chamfer, tipDiameter: len('0.5') }
    expect(expectOk(load(flatTip)).tipDiameterMm).toBe(0.5)
    expect(expectOk(load({ ...chamfer, tipDiameter: len('0') })).tipDiameterMm).toBe(0)
    expect(expectOk(load(flatTip)).toDTO()).toEqual(flatTip)
    expect(issues({ ...chamfer, angle: undefined })).toEqual([['angle', 'required']])
    // DF123 (TG #407): engraving V-bits of 10°, 15°, 20° load; under 10° does not
    for (const a of ['10', '15', '20'])
      expect(expectOk(load({ ...chamfer, angle: deg(a) })).angle.unwrap().canonical).toBe(Number(a))
    expect(issues({ ...chamfer, angle: deg('9.9') })).toEqual([['angle', 'range']])
    expect(issues({ ...chamfer, angle: deg('151') })).toEqual([['angle', 'range']])
    expect(expectOk(load({ ...chamfer, angle: deg('150') })).angle.unwrap().canonical).toBe(150)
    expect(issues({ ...chamfer, tipDiameter: len('12') })).toEqual([['tipDiameter', 'range']])
    expect(issues({ ...chamfer, tipDiameter: len('-1') })).toEqual([['tipDiameter', 'range']])
    expect(issues({ ...flat(), angle: deg('90'), tipDiameter: len('0.2') })).toEqual([
      ['angle', 'notAllowed'],
      ['tipDiameter', 'notAllowed'],
    ])
  })

  // docs/modes/tapered-ball-nose.md#tool-model (DF124 T1): the user's R0.25 3.6° on a 1/8" shank
  const tapered = () => ({
    ...flat(),
    name: 'Tapered R0.25 3.6°',
    type: 'taperedBallEndMill',
    diameter: len('1/8"'),
    shankDiameter: len('1/8"'),
    tipDiameter: len('0.5'),
    taperAngle: deg('3.6'),
    fluteLength: len('22'),
    overallLength: len('38'),
    presets: [],
  })

  it('a tapered ball end mill: DC = large end, ball Ø in tipDiameter, 3.6° per side round-trips', () => {
    const t = expectOk(load(tapered()))
    expect(t.type).toBe('taperedBallEndMill')
    expect(t.diameter.canonical).toBeCloseTo(3.175, 12)
    expect(t.tipDiameterMm).toBe(0.5)
    expect(t.taperAngle.unwrap().canonical).toBe(3.6)
    expect(t.effectiveCornerRadius.toNumber()).toBe(0.25) // r = tip / 2, derived
    expect(t.toDTO()).toEqual(tapered())
    // the doc's example: the cone reaches the 1/8" shank 21.5 mm above the tip
    const h = t.taper.unwrap()
    expect(h.tangent).toBeCloseTo(0.25 * (1 - Math.sin((3.6 * Math.PI) / 180)), 12)
    expect(h.largeEnd).toBeCloseTo(21.5, 1)
    expect(taperHeights(0.5, 1.8, 3.175).largeEnd).toBeCloseTo(42.8, 1) // 3.6° included
    expect(expectOk(load(flat())).taper.isNone()).toBe(true)
  })

  it('a tapered ball end mill: tip and taper angle required and in range, the rest not stored', () => {
    expect(issues({ ...tapered(), tipDiameter: undefined, taperAngle: undefined })).toEqual([
      ['tipDiameter', 'required'],
      ['taperAngle', 'required'],
    ])
    for (const a of ['0.5', '1.5', '30'])
      expect(
        expectOk(load({ ...tapered(), taperAngle: deg(a) })).taperAngle.unwrap().canonical,
      ).toBe(Number(a))
    expect(issues({ ...tapered(), taperAngle: deg('0.4') })).toEqual([['taperAngle', 'range']])
    expect(issues({ ...tapered(), taperAngle: deg('30.1') })).toEqual([['taperAngle', 'range']])
    expect(issues({ ...tapered(), tipDiameter: len('0') })).toEqual([['tipDiameter', 'range']])
    expect(issues({ ...tapered(), tipDiameter: len('1/8"') })).toEqual([['tipDiameter', 'range']])
    expect(
      issues({
        ...tapered(),
        cornerRadius: len('0.25'),
        angle: deg('7.2'),
        pointAngle: deg('118'),
      }),
    ).toEqual([
      ['cornerRadius', 'notAllowed'],
      ['pointAngle', 'notAllowed'],
      ['angle', 'notAllowed'],
    ])
    // only a tapered ball stores a taper angle; a chamfer mill keeps its optional tip
    expect(issues({ ...flat(), taperAngle: deg('3.6') })).toEqual([['taperAngle', 'notAllowed']])
    expect(
      issues({
        ...flat(),
        type: 'chamferMill',
        presets: [],
        angle: deg('15'),
        taperAngle: deg('3.6'),
      }),
    ).toEqual([['taperAngle', 'notAllowed']])
    expect(issues({ ...flat(), type: 'ballEndMill', tipDiameter: len('0.5') })).toEqual([
      ['tipDiameter', 'notAllowed'],
    ])
    // the refusals say what to change
    const e = expectErrCode(load({ ...tapered(), taperAngle: deg('45') }), 'model.invariant')
    expect(e.issues[0]!.message).toMatch(/0\.5° and 30° per side/)
    // no rule against the cone's height (Q153: a Library form hint only)
    expect(
      expectOk(load({ ...tapered(), taperAngle: deg('1.8'), fluteLength: len('20') })).type,
    ).toBe('taperedBallEndMill')
  })

  it('checks lengths and the flute count', () => {
    expect(
      issues({
        ...flat(),
        diameter: len('0'),
        overallLength: len('20'),
        stickout: len('20'),
        shankDiameter: len('-1'),
        fluteCount: num('1.5'),
        presets: [],
      }),
    ).toEqual([
      ['diameter', 'positive'],
      ['shankDiameter', 'positive'],
      ['fluteCount', 'integer'],
      ['overallLength', 'greaterThanFluteLength'],
      ['stickout', 'lessThanOverallLength'],
    ])
    expect(issues({ ...flat(), fluteCount: num('0') })).toEqual([['fluteCount', 'integer']])
  })

  it('checks each preset (all issues at once)', () => {
    expect(
      issues({
        ...flat(),
        presets: [
          { ...preset, spindleSpeed: rpm('0') },
          { ...preset, feedRate: feed('0'), plungeRate: feed('-1'), stepdown: len('0') },
        ],
      }),
    ).toEqual([
      ['presets.0.spindleSpeed', 'positive'],
      ['presets.1.feedRate', 'positive'],
      ['presets.1.plungeRate', 'positive'],
      ['presets.1.stepdown', 'positive'],
    ])
  })

  it('checks preset rules that need the tool: stepover ≤ diameter, unique names', () => {
    expectOk(load({ ...flat(), presets: [{ ...preset, stepover: len('6') }] }))
    expect(issues({ ...flat(), presets: [{ ...preset, stepover: len('6.01') }, preset] })).toEqual([
      ['presets.0.stepover', 'atMostDiameter'],
      ['presets.1.name', 'unique'],
    ])
  })

  it('a preset without material class applies to any material', () => {
    const { materialClass: _, ...any } = preset
    const t = expectOk(load({ ...flat(), presets: [any] }))
    expect(t.presets[0]!.materialClass.isNone()).toBe(true)
    expect(t.toDTO().presets).toEqual([any])
  })

  it('recommended presets: stored only when true, and need a material class', () => {
    const rec = { ...preset, recommended: true }
    const t = expectOk(load({ ...flat(), presets: [rec] }))
    expect(t.presets[0]!.recommended).toBe(true)
    expect(t.toDTO().presets).toEqual([rec])
    const off = expectOk(load({ ...flat(), presets: [{ ...preset, recommended: false }] }))
    expect(off.toDTO().presets).toEqual([preset])
    const { materialClass: _, ...any } = rec
    expect(issues({ ...flat(), presets: [any] })).toEqual([
      ['presets.0.recommended', 'recommendedNeedsClass'],
    ])
  })

  it('shape checks: type enum, preset name length, kinds', () => {
    expectErrCode(load({ ...flat(), type: 'vBit' }), 'input.malformed')
    expectErrCode(load({ ...flat(), presets: [{ ...preset, name: '' }] }), 'input.malformed')
    expectErrCode(load({ ...flat(), fluteCount: len('2') }), 'input.malformed')
    expectErrCode(load({ ...flat(), coating: 'x'.repeat(61) }), 'input.malformed')
  })

  it('with() re-checks cross-field rules', () => {
    const t = expectOk(load(flat()))
    const e = expectErrCode(t.with({ type: 'bullNoseEndMill' }), 'model.invariant')
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['cornerRadius'])
    expect(expectOk(t.with({ name: 'Renamed' })).presets).toEqual(t.presets)
  })
})
