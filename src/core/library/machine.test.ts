import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { feed, len, machineValues, num, rpm, watt } from './library.fixture'
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
})
