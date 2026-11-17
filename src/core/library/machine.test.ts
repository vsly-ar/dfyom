import { describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { feed, len, machineValues, num, rpm } from './library.fixture'
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
})
