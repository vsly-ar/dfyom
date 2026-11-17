import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../../shared/testing/result'
import { machineValues, num, rpm } from '../../../library/library.fixture'
import { Machine } from '../../../library/machine'
import { GrblEmulator } from './emulator'
import { machineSettings, Settings } from './settings'

describe('settings', () => {
  it('takes travel, rates, acceleration and spindle range from the machine snapshot', () => {
    const m = expectOk(
      Machine.fromDTO({
        ...machineValues(),
        acceleration: { x: num('500'), y: num('400'), z: num('200') },
        spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('8000') },
      }),
    )
    expect(machineSettings(m)).toEqual({
      110: 5000,
      111: 5000,
      112: 1000,
      120: 500,
      121: 400,
      122: 200,
      130: 800,
      131: 800,
      132: 100,
      30: 24000,
      31: 8000,
    })
    const emu = expectOk(GrblEmulator.create({ settings: machineSettings(m) }))
    emu.receive(Uint8Array.from('$$\n', (c) => c.charCodeAt(0)))
    const out = emu.readOutput()
    expect(out).toContain('$22=1\r\n')
    expect(out).toContain('$20=1\r\n')
    expect(out).toContain('$132=100.000\r\n')
    expect(out).toContain('$31=8000\r\n')
  })

  it('keeps GRBL defaults for acceleration when the machine has none', () => {
    const m = expectOk(Machine.fromDTO(machineValues()))
    expect(machineSettings(m)[120]).toBeUndefined()
    expect(expectOk(Settings.create(machineSettings(m), true)).get(120)).toBe(10)
  })

  it('stores booleans as 0/1 and truncates integer settings', () => {
    const s = expectOk(Settings.create({}, true))
    expect(s.store(13, 5)).toBe(0)
    expect(s.get(13)).toBe(1)
    expect(s.store(26, 99.7)).toBe(0)
    expect(s.get(26)).toBe(99)
    expect(s.store(22, 0)).toBe(0)
    expect(s.get(20)).toBe(0)
  })
})
