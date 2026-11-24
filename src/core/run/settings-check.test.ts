/**
 * The settings check's spindle range: `$30`/`$31` against the usable speeds, or against the
 * controller PWM range when the machine sets one. Spec: docs/modes/run-machine.md#settings-check
 */
import { describe, expect, it } from 'vitest'
import { machineValues, rpm } from '../library/library.fixture'
import type { MachineValuesDTO } from '../library/machine.dto'
import { settingsCheck } from './settings-check'

const machine = (spindle: Partial<MachineValuesDTO['spindle']> = {}): MachineValuesDTO => ({
  ...machineValues(),
  spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('6200'), ...spindle },
})
const controller = { '22': 1, '30': 24000, '31': 2930 }

describe('settingsCheck: spindle range', () => {
  it('compares $31 with minSpeed when no controller range is set', () => {
    const c = settingsCheck(machine(), controller, 'machine')
    expect(c.matches).toBe(false)
    expect(c.differences).toEqual([
      { setting: '$31', field: 'spindle.minSpeed', controller: '2930 rpm', machine: '6200 rpm' },
    ])
  })

  it('compares $31/$30 with controllerMinSpeed/controllerMaxSpeed when set', () => {
    const ok = settingsCheck(machine({ controllerMinSpeed: rpm('2930') }), controller, 'machine')
    expect(ok.matches).toBe(true)
    expect(ok.differences).toEqual([])
    const off = settingsCheck(
      machine({ controllerMinSpeed: rpm('3000'), controllerMaxSpeed: rpm('25000') }),
      controller,
      'machine',
    )
    expect(off.differences.map((d) => [d.setting, d.field])).toEqual([
      ['$30', 'spindle.controllerMaxSpeed'],
      ['$31', 'spindle.controllerMinSpeed'],
    ])
  })
})
