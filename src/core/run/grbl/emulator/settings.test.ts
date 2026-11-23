import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../../shared/testing/result'
import { len, machineValues, num, rpm } from '../../../library/library.fixture'
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
      23: 0,
      27: 1,
    })
    const emu = expectOk(GrblEmulator.create({ settings: machineSettings(m) }))
    emu.receive(Uint8Array.from('$$\n', (c) => c.charCodeAt(0)))
    const out = emu.readOutput()
    expect(out).toContain('$22=1\r\n')
    expect(out).toContain('$20=1\r\n')
    expect(out).toContain('$132=100.000\r\n')
    expect(out).toContain('$31=8000\r\n')
  })

  it('takes the homing corner ($23), pull-off ($27) and soft limits off ($20=0)', () => {
    const corners = [
      ['backRight', 0],
      ['backLeft', 1],
      ['frontRight', 2],
      ['frontLeft', 3],
    ] as const
    for (const [homingCorner, mask] of corners) {
      const m = expectOk(Machine.fromDTO({ ...machineValues(), homingCorner, pullOff: len('2') }))
      expect(machineSettings(m)).toMatchObject({ 23: mask, 27: 2 })
      expect(machineSettings(m)[20]).toBeUndefined()
    }
    const off = expectOk(Machine.fromDTO({ ...machineValues(), softLimits: false }))
    expect(machineSettings(off)[20]).toBe(0)
  })

  it('takes junction deviation, arc tolerance and steps/mm when the machine sets them', () => {
    const m = expectOk(
      Machine.fromDTO({
        ...machineValues(),
        junctionDeviation: len('0.02'),
        arcTolerance: len('0.001'),
        stepsPerMm: { x: num('40'), y: num('40'), z: num('400') },
      }),
    )
    expect(machineSettings(m)).toMatchObject({ 11: 0.02, 12: 0.001, 100: 40, 101: 40, 102: 400 })
    const plain = machineSettings(expectOk(Machine.fromDTO(machineValues())))
    expect(plain[11]).toBeUndefined()
    expect(plain[100]).toBeUndefined()
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
