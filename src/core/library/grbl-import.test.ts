import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { parseSettingsText } from '../run/grbl/settings'
import { GRBL_11H_DEFAULTS } from '../run/grbl/settings.fixture'
import { applySettingsChanges, machineSettingsDiff, quantityWithUnit } from './grbl-import'
import { feed, len, machineValues, num, qty, rpm } from './library.fixture'
import { Machine } from './machine'
import type { MachineValuesDTO } from './machine.dto'

const settings = (o: Record<number, number>) =>
  new Map(Object.entries(o).map(([k, v]) => [Number(k), v]))
const gcode = (): MachineValuesDTO => ({
  ...machineValues(),
  spindle: { control: 'gcode', maxSpeed: rpm('24000') },
})
/** A quantity entered in an inch item (bare number = in, in/min). */
const inch = <K extends 'length' | 'feedRate'>(kind: K, s: string) =>
  expectOk(
    Quantity.parse(s, { kind, defaultUnit: kind === 'length' ? 'in' : 'in/min' }),
  ).toDTO() as QuantityDTO & {
    kind: K
  }

describe('machineSettingsDiff', () => {
  it('maps rates, travel with soft limits, $11/$12, spindle and steps/mm of a real dump', () => {
    const dump = parseSettingsText(
      GRBL_11H_DEFAULTS.replace('$20=0', '$20=1').replace('$110=500.000', '$110=5000.000'),
    ).settings
    const d = machineSettingsDiff(gcode(), dump)
    expect(d.read).toBe(34)
    expect(d.changes.map((c) => [c.setting, c.from, c.to])).toEqual([
      ['$111', '5000 mm/min', '500 mm/min'],
      ['$112', '1000 mm/min', '500 mm/min'],
      ['$120', null, '10 mm/s²'],
      ['$121', null, '10 mm/s²'],
      ['$122', null, '10 mm/s²'],
      ['$11', null, '0.01 mm'],
      ['$12', null, '0.002 mm'],
      ['$27', null, '1 mm'],
      ['$130', '800 mm', '200 mm'],
      ['$131', '800 mm', '200 mm'],
      ['$132', '100 mm', '200 mm'],
      ['$30', '24000 rpm', '1000 rpm'],
      ['$100', null, '250 steps/mm'],
      ['$101', null, '250 steps/mm'],
      ['$102', null, '250 steps/mm'],
    ])
    expect(d.changes.find((c) => c.setting === '$120')?.together).toEqual(['$120', '$121', '$122'])
    expect(d.changes.find((c) => c.setting === '$111')?.together).toBeUndefined()
    // $110 equals the stored 5000 mm/min
    expect(d.unchanged).toEqual(['$110'])
    expect(d.skipped).toEqual([
      { setting: '$31', field: 'spindle.minSpeed', value: 0, rule: 'notPositive' },
    ])
    expect(d.ignored).toEqual([0, 1, 2, 3, 4, 5, 6, 10, 13, 21, 22, 23, 24, 25, 26, 32])
  })

  it('skips travel without soft limits and the spindle range of a manual spindle', () => {
    const d = machineSettingsDiff(
      machineValues(),
      settings({ 130: 300, 131: 300, 30: 10000, 31: 100 }),
    )
    expect(d.changes).toEqual([])
    expect(d.skipped.map((s) => [s.setting, s.rule])).toEqual([
      ['$130', 'softLimitsOff'],
      ['$131', 'softLimitsOff'],
      ['$30', 'manualSpindle'],
      ['$31', 'manualSpindle'],
    ])
  })

  it('skips non-positive values and a partial new group, keeps one axis of an existing group', () => {
    const d = machineSettingsDiff(machineValues(), settings({ 110: 0, 120: 50, 121: -1, 100: 80 }))
    expect(d.skipped.map((s) => [s.setting, s.rule])).toEqual([
      ['$110', 'notPositive'],
      ['$121', 'notPositive'],
      ['$120', 'allAxes'],
      ['$100', 'allAxes'],
    ])
    const withAcc = {
      ...machineValues(),
      acceleration: { x: num('10'), y: num('10'), z: num('5') },
    }
    const d2 = machineSettingsDiff(withAcc, settings({ 120: 50 }))
    expect(d2.changes.map((c) => [c.setting, c.from, c.to, c.together])).toEqual([
      ['$120', '10 mm/s²', '50 mm/s²', undefined],
    ])
  })

  it('counts values equal within GRBL’s printed precision as unchanged', () => {
    const m: MachineValuesDTO = {
      ...machineValues(),
      travel: { x: qty('length', '16 in'), y: len('800'), z: len('100') },
    }
    const d = machineSettingsDiff(m, settings({ 20: 1, 130: 406.4, 131: 800.0004, 132: 100.001 }))
    expect(d.unchanged).toEqual(['$130', '$131'])
    expect(d.changes.map((c) => c.setting)).toEqual(['$132'])
  })

  it('writes the GRBL unit out in an inch machine, never converting', () => {
    const m: MachineValuesDTO = {
      ...machineValues(),
      travel: { x: inch('length', '30'), y: inch('length', '30'), z: inch('length', '4') },
      maxFeedRate: {
        x: inch('feedRate', '200'),
        y: inch('feedRate', '200'),
        z: inch('feedRate', '40'),
      },
    }
    const d = machineSettingsDiff(m, settings({ 110: 5000, 11: 0.02, 100: 40, 101: 40, 102: 400 }))
    const c = d.changes.find((x) => x.setting === '$110')!
    expect([c.from, c.to]).toEqual(['200 in/min', '5000 mm/min'])
    expect(c.quantity).toMatchObject({ source: '5000 mm/min', defaultUnit: 'in/min' })
    expect(d.changes.find((x) => x.setting === '$11')!.quantity.source).toBe('0.02 mm')
    expect(d.changes.find((x) => x.setting === '$100')!.quantity.source).toBe('40')
  })
})

describe('applySettingsChanges', () => {
  const dump = settings({ 20: 1, 110: 6000, 120: 400, 121: 400, 122: 100, 130: 750, 11: 0.02 })

  it('applies only the accepted changes; the machine model accepts the result', () => {
    const d = machineSettingsDiff(machineValues(), dump)
    const next = expectOk(
      applySettingsChanges(machineValues(), d, ['$110', '$11', '$120', '$121', '$122']),
    )
    expect(next.maxFeedRate.x).toEqual(feed('6000'))
    expect(next.travel.x).toEqual(len('800'))
    expect(next.junctionDeviation).toEqual(len('0.02'))
    expect(next.acceleration).toEqual({ x: num('400'), y: num('400'), z: num('100') })
    const m = expectOk(Machine.fromDTO(next))
    expect(m.junctionDeviation.unwrap().canonical).toBe(0.02)
  })

  it('rejects settings that are not changes and part of a new group', () => {
    const d = machineSettingsDiff(machineValues(), dump)
    const e = expectErrCode(
      applySettingsChanges(machineValues(), d, ['$999', '$120']),
      'input.malformed',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['accept.0', 'notAChange'],
      ['accept', 'allAxes'],
    ])
  })
})

describe('quantityWithUnit', () => {
  it('writes the bare-number unit, keeps a written one', () => {
    expect(quantityWithUnit(len('6'))).toBe('6 mm')
    expect(quantityWithUnit(qty('length', '1/4 in'))).toBe('1/4 in')
    expect(quantityWithUnit(num('40'), 'steps/mm')).toBe('40 steps/mm')
    expect(quantityWithUnit(num('40'))).toBe('40')
  })
})
