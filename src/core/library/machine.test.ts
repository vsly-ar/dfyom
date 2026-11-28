import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { feed, len, machineValues, num, rpm, watt } from './library.fixture'
import { HOLDER_PRESETS, holderEdited, presetHolderDTO } from './holder'
import { HOLDER_PRESET_IDS } from './holder.dto'
import { Machine } from './machine'
import { MachineValuesDtoSchema } from './machine.dto'

const load = (raw: unknown) =>
  parseWith(MachineValuesDtoSchema, raw, 'test').andThen((dto) => Machine.fromDTO(dto))

const issues = (raw: unknown) =>
  expectErrCode(load(raw), 'model.invariant').issues.map((i) => [i.path.join('.'), i.rule])

describe('Machine', () => {
  it('round-trips a GRBL router', () => {
    const m = expectOk(load(machineValues()))
    expect(m.travel.z.canonical).toBe(100)
    expect(m.acceleration.isNone()).toBe(true)
    expect(m.toDTO()).toEqual(machineValues())
  })

  it('round-trips the optional acceleration and minimum spindle speed', () => {
    const full = {
      ...machineValues(),
      acceleration: { x: num('500'), y: num('500'), z: num('200') },
      spindle: { control: 'gcode' as const, maxSpeed: rpm('24000'), minSpeed: rpm('0') },
    }
    expect(expectOk(load(full)).toDTO()).toEqual(full)
  })

  it('reports every non-positive limit with its axis path', () => {
    expect(
      issues({
        ...machineValues(),
        travel: { x: len('0'), y: len('800'), z: len('100') },
        maxFeedRate: { x: feed('5000'), y: feed('5000'), z: feed('0') },
        acceleration: { x: num('500'), y: num('-1'), z: num('200') },
        spindle: { control: 'gcode', maxSpeed: rpm('0') },
      }),
    ).toEqual([
      ['travel.x', 'positive'],
      ['maxFeedRate.z', 'positive'],
      ['acceleration.y', 'positive'],
      ['spindle.maxSpeed', 'positive'],
    ])
  })

  it('minSpeed must be ≥ 0 and below maxSpeed', () => {
    const spindle = (minSpeed: string) => ({
      ...machineValues(),
      spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm(minSpeed) },
    })
    expect(issues(spindle('24000'))).toEqual([['spindle.minSpeed', 'lessThanMaxSpeed']])
    expect(issues(spindle('-1'))).toEqual([['spindle.minSpeed', 'nonNegative']])
  })

  it('shape checks: controller, tool changer, program units', () => {
    expectErrCode(load({ ...machineValues(), controller: 'marlin' }), 'input.malformed')
    expectErrCode(load({ ...machineValues(), toolChanger: 'carousel' }), 'input.malformed')
    expectErrCode(load({ ...machineValues(), programUnits: 'cm' }), 'input.malformed')
  })

  it('round-trips the optional spindle power and rigidity preset', () => {
    const full = {
      ...machineValues(),
      spindle: { control: 'gcode' as const, maxSpeed: rpm('24000'), power: watt('2.2 kW') },
      rigidity: 'prosumer' as const,
    }
    const m = expectOk(load(full))
    expect(m.spindle.power.unwrap().canonical).toBe(2200)
    expect(m.rigidity.unwrap()).toBe('prosumer')
    expect(m.toDTO()).toEqual(full)
    expect(expectOk(load(machineValues())).rigidity.isNone()).toBe(true)
  })

  it('round-trips the homing corner, pull-off and soft limits; fixedGantry rigidity (DF33, DF36)', () => {
    const full = {
      ...machineValues(),
      rigidity: 'fixedGantry' as const,
      homingCorner: 'frontLeft' as const,
      pullOff: len('3'),
      softLimits: false,
    }
    const m = expectOk(load(full))
    expect(m.homingCorner.unwrap()).toBe('frontLeft')
    expect(m.pullOff.unwrap().canonical).toBe(3)
    expect(m.softLimits.unwrap()).toBe(false)
    expect(m.toDTO()).toEqual(full)
    const plain = expectOk(load(machineValues()))
    expect([
      plain.homingCorner.isNone(),
      plain.pullOff.isNone(),
      plain.softLimits.isNone(),
    ]).toEqual([true, true, true])
    expect(issues({ ...machineValues(), pullOff: len('0') })).toEqual([['pullOff', 'positive']])
    expectErrCode(load({ ...machineValues(), homingCorner: 'topRight' }), 'input.malformed')
  })

  it('round-trips the Z headroom fields; the spoilboard is ≥ 0 and below the nose (DF68)', () => {
    const full = { ...machineValues(), noseToTable: len('120'), spoilboardThickness: len('0') }
    const m = expectOk(load(full))
    expect(m.noseToTable.unwrap().canonical).toBe(120)
    expect(m.spoilboardThickness.unwrap().canonical).toBe(0)
    expect(m.toDTO()).toEqual(full)
    const plain = expectOk(load(machineValues()))
    expect([plain.noseToTable.isNone(), plain.spoilboardThickness.isNone()]).toEqual([true, true])
    expect(
      issues({ ...machineValues(), noseToTable: len('0'), spoilboardThickness: len('-1') }),
    ).toEqual([
      ['noseToTable', 'positive'],
      ['spoilboardThickness', 'nonNegative'],
    ])
    expect(
      issues({ ...machineValues(), noseToTable: len('20'), spoilboardThickness: len('20') }),
    ).toEqual([['spoilboardThickness', 'lessThanNoseToTable']])
  })

  it('spindle power must be > 0; rigidity must be a preset', () => {
    const spindle = { control: 'gcode', maxSpeed: rpm('24000'), power: watt('0') }
    expect(issues({ ...machineValues(), spindle })).toEqual([['spindle.power', 'positive']])
    expectErrCode(load({ ...machineValues(), rigidity: 'granite' }), 'input.malformed')
  })

  it('round-trips the touch plate thickness; it must be > 0 (M4)', () => {
    const full = { ...machineValues(), probePlateThickness: len('12.5') }
    const m = expectOk(load(full))
    expect(m.probePlateThickness.unwrap().canonical).toBe(12.5)
    expect(m.toDTO()).toEqual(full)
    expect(expectOk(load(machineValues())).probePlateThickness.isNone()).toBe(true)
    expect(issues({ ...machineValues(), probePlateThickness: len('0') })).toEqual([
      ['probePlateThickness', 'positive'],
    ])
  })

  it('round-trips the probe settings (v0.5 RV4); lengths and feeds checked', () => {
    const probe = {
      kind: 'xyzPlate' as const,
      wallOffsetX: len('5'),
      wallOffsetY: len('0'),
      retract: len('2'),
    }
    const full = { ...machineValues(), probe }
    const m = expectOk(load(full))
    expect(m.probe.unwrap().kind).toBe('xyzPlate')
    expect(m.toDTO()).toEqual(full)
    expect(expectOk(load(machineValues())).probe.isNone()).toBe(true)
    expect(
      issues({
        ...machineValues(),
        probe: { kind: 'tool', wallOffsetX: len('-1'), retract: len('0') },
      }),
    ).toEqual([
      ['probe.wallOffsetX', 'nonNegative'],
      ['probe.retract', 'positive'],
    ])
    expectErrCode(load({ ...machineValues(), probe: { kind: 'laser' } }), 'input.malformed')
  })

  it('round-trips the work area and margin (v0.5 RV7); usableTravel less marks and margin', () => {
    const workArea = { x: { min: len('-790'), max: len('-5') }, z: { min: len('-95') } }
    const full = { ...machineValues(), workArea, workAreaMargin: len('3') }
    const m = expectOk(load(full))
    expect(m.toDTO()).toEqual(full)
    // x: 790 − 5 − 2×3; y unmarked: the travel; z: 100 less (100 − 95) and the margin
    expect(m.usableTravel('x')).toBeCloseTo(779, 9)
    expect(m.usableTravel('y')).toBe(800)
    expect(m.usableTravel('z')).toBeCloseTo(92, 9)
    // the margin unset: 2 mm
    const d = expectOk(load({ ...machineValues(), workArea }))
    expect(d.workAreaMargin.isNone()).toBe(true)
    expect(d.usableTravel('x')).toBeCloseTo(781, 9)
    expect(expectOk(load(machineValues())).usableTravel('x')).toBe(800)
    expect(
      issues({
        ...machineValues(),
        workArea: { y: { min: len('-5'), max: len('-10') } },
        workAreaMargin: len('-1'),
      }),
    ).toEqual([
      ['workArea.y.min', 'lessThanMax'],
      ['workAreaMargin', 'nonNegative'],
    ])
  })

  describe('holder (tool-holder.md#model, DF132 H1)', () => {
    const er11 = {
      preset: 'er11' as const,
      nutDiameter: len('19'),
      nutLength: len('12'),
      bodyDiameter: len('52'),
      maxShank: len('7'),
    }

    it('round-trips a holder; none by default', () => {
      const full = { ...machineValues(), holder: er11 }
      const m = expectOk(load(full))
      const h = m.holder.unwrap()
      expect([h.nutDiameter.canonical, h.nutLength.canonical, h.bodyDiameter.canonical]).toEqual([
        19, 12, 52,
      ])
      expect(h.preset.unwrap()).toBe('er11')
      expect(m.toDTO()).toEqual(full)
      expect(expectOk(load(machineValues())).holder.isNone()).toBe(true)
      // measured, no preset and no collet capacity
      const measured = { nutDiameter: len('20'), nutLength: len('14'), bodyDiameter: len('20') }
      expect(expectOk(load({ ...machineValues(), holder: measured })).toDTO().holder).toEqual(
        measured,
      )
    })

    it('a preset alone fills the sizes; given sizes win over the preset', () => {
      const m = expectOk(load({ ...machineValues(), holder: { preset: 'er16' } }))
      expect(m.toDTO().holder).toEqual(presetHolderDTO('er16'))
      const edited = expectOk(
        load({ ...machineValues(), holder: { preset: 'er11', nutDiameter: len('22') } }),
      )
      const dto = edited.toDTO().holder!
      expect(dto.nutDiameter!.exact).toEqual({ num: '22', den: '1' })
      expect(dto.nutLength).toEqual(presetHolderDTO('er11').nutLength)
      expect(holderEdited(dto)).toBe(true)
      expect(holderEdited(presetHolderDTO('er11'))).toBe(false)
    })

    it('without a preset the nut and body sizes are required', () => {
      expect(issues({ ...machineValues(), holder: { nutDiameter: len('19') } })).toEqual([
        ['holder.nutLength', 'required'],
        ['holder.bodyDiameter', 'required'],
      ])
    })

    it('sizes are > 0 and the body is at least the nut', () => {
      expect(
        issues({
          ...machineValues(),
          holder: { ...er11, nutLength: len('0'), bodyDiameter: len('18'), maxShank: len('-1') },
        }),
      ).toEqual([
        ['holder.nutLength', 'positive'],
        ['holder.maxShank', 'positive'],
        ['holder.bodyDiameter', 'atLeastNutDiameter'],
      ])
      expect(
        expectOk(load({ ...machineValues(), holder: { ...er11, bodyDiameter: len('19') } })),
      ).toBeDefined()
      expectErrCode(load({ ...machineValues(), holder: { preset: 'er8' } }), 'input.malformed')
    })

    it('every preset builds a valid holder (body ≥ nut, capacity under the nut)', () => {
      expect(Object.keys(HOLDER_PRESETS)).toEqual([...HOLDER_PRESET_IDS])
      for (const id of HOLDER_PRESET_IDS) {
        const h = expectOk(load({ ...machineValues(), holder: { preset: id } })).holder.unwrap()
        expect(h.bodyDiameter.canonical).toBeGreaterThan(h.nutDiameter.canonical)
        expect(h.maxShank.unwrap().canonical).toBeLessThan(h.nutDiameter.canonical)
      }
      const trim = presetHolderDTO('trimRouter')
      expect(trim.maxShank!.exact).toEqual({ num: '127', den: '20' }) // 1/4" = 6.35 mm, exact
    })
  })
})
