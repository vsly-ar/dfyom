// Probing (G38.2–G38.5) with the simulated touch plate, and the fault hooks.
// Spec: docs/architecture/grbl.md#probing, #fault-injection
import { describe, expect, it } from 'vitest'
import { emulator, outLines, send, settle, statusOf } from '../emulator.fixture'

/** Idle at MPos 0,0,0; plate top at Z −20 unless given. */
function probing(plate: number | undefined = -20) {
  const emu = emulator(plate === undefined ? {} : { probePlate: plate })
  emu.readOutput()
  return emu
}

const prb = (lines: readonly string[]) => lines.find((l) => l.startsWith('[PRB:'))

describe('G38.x parsing', () => {
  it.each([
    ['G38.2 Z-5', 22], // no feed yet
    ['G38.2 F50', 26], // no axis words
    ['G38.1 Z-5 F50', 20],
    ['G38.6 Z-5 F50', 20],
    ['G38.2 G1 Z-5 F50', 24],
    ['G53 G38.2 Z-5 F50', 30],
    ['G38.2 Z0 F50', 33], // the current position
  ])('%s → error:%i', (line, code) => {
    const emu = probing()
    expect(send(emu, `${line}\n`)).toEqual([`error:${code}`])
  })

  it('is refused inside a jog and reported by $G as the motion mode', () => {
    const emu = probing()
    expect(send(emu, '$J=G38.2 Z-5 F50\n')).toEqual(['error:16'])
    send(emu, 'G38.3 Z-1 F100\n')
    settle(emu)
    emu.readOutput()
    expect(send(emu, '$G\n')[0]).toMatch(/^\[GC:G38\.3 /)
  })
})

describe('G38.2 toward the plate', () => {
  it('stops on contact, reports [PRB] (machine coordinates) and then ok', () => {
    const emu = probing(-20)
    send(emu, 'G10 L2 P1 Z-5\n') // a G54 offset: PRB stays in machine coordinates
    expect(send(emu, 'G38.2 Z-30 F100\n')).toEqual([]) // the ok waits for the cycle
    expect(emu.status().state).toBe('Run')
    // no other line is read while probing
    expect(send(emu, 'G0 X1\n')).toEqual([])
    settle(emu)
    const out = outLines(emu)
    expect(out.slice(0, 2)).toEqual(['[PRB:0.000,0.000,-20.000:1]', 'ok'])
    expect(out[2]).toBe('ok') // then the G0 X1
    const z = emu.status().mpos[2]
    // decelerated past the plate by a few µm at probe feed
    expect(z).toBeLessThanOrEqual(-20)
    expect(z).toBeGreaterThan(-20.05)
    expect(send(emu, '$#\n')).toContain('[PRB:0.000,0.000,-20.000:1]')
  })

  it('ALARM:5 when there is no contact within the move (not critical: $X clears it)', () => {
    const emu = probing(-50)
    send(emu, 'G38.2 Z-10 F200\n')
    settle(emu)
    expect(outLines(emu)).toEqual(['ALARM:5', '[PRB:0.000,0.000,-10.000:0]', 'ok'])
    expect(emu.status()).toMatchObject({ state: 'Alarm', mpos: [0, 0, -10] })
    expect(send(emu, 'G0 Z0\n')).toEqual(['error:9'])
    expect(statusOf(emu)).toMatch(/^<Alarm\|/) // reports go on (not critical)
    expect(send(emu, '$X\n')).toEqual(['[MSG:Caution: Unlocked]', 'ok'])
    expect(send(emu, '$#\n')).toContain('[PRB:0.000,0.000,-10.000:0]')
  })

  it('ALARM:4 when the input is already closed (no motion, no [PRB]); no plate → ALARM:5', () => {
    const emu = probing(5) // the plate is above the tool: touching
    expect(send(emu, 'G38.2 Z-10 F200\n')).toEqual(['ALARM:4', 'ok'])
    expect(emu.status()).toMatchObject({ state: 'Alarm', mpos: [0, 0, 0] })
    emu.setProbePlate(undefined)
    send(emu, '$X\n')
    send(emu, 'G38.2 Z-2 F200\n')
    settle(emu)
    expect(outLines(emu)[0]).toBe('ALARM:5')
  })

  it('a reset during the probe is ALARM:3; check mode does not probe', () => {
    const emu = probing(-50)
    send(emu, 'G38.2 Z-40 F100\n')
    emu.advance(500)
    emu.receive(Uint8Array.of(0x18))
    expect(outLines(emu)[0]).toBe('ALARM:3')
    send(emu, '$X\n')
    send(emu, '$C\n')
    const z = emu.status().mpos[2]
    expect(send(emu, 'G38.2 Z-40 F100\n')).toEqual(['ok'])
    settle(emu)
    expect(emu.status().mpos[2]).toBe(z)
  })

  it('a probe target outside the travel is a soft limit before it moves', () => {
    const emu = emulator({ homing: true, settings: { 20: 1, 132: 50 }, probePlate: -100 })
    send(emu, '$H\n')
    settle(emu)
    emu.readOutput()
    expect(send(emu, 'G38.2 Z-60 F100\n')).toEqual(['ALARM:2', '[MSG:Reset to continue]'])
  })
})

describe('G38.3, G38.4, G38.5', () => {
  it('G38.3 misses without an alarm', () => {
    const emu = probing(-50)
    send(emu, 'G38.3 Z-5 F300\n')
    settle(emu)
    expect(outLines(emu)).toEqual(['[PRB:0.000,0.000,-5.000:0]', 'ok'])
    expect(emu.status().state).toBe('Idle')
  })

  it('G38.4 moves away until the input opens; G38.5 misses quietly; open at start → ALARM:4', () => {
    const emu = probing(-20)
    send(emu, 'G38.2 Z-30 F100\n')
    settle(emu)
    emu.readOutput()
    send(emu, 'G38.4 Z-10 F100\n')
    settle(emu)
    const away = outLines(emu)
    expect(prb(away)).toBe('[PRB:0.000,0.000,-20.000:1]')
    expect(emu.status().mpos[2]).toBeGreaterThan(-20)
    // now above the plate: away from it is an open input at the start
    expect(send(emu, 'G38.4 Z0 F100\n')).toEqual(['ALARM:4', 'ok'])
    send(emu, '$X\n')
    send(emu, 'G38.2 Z-30 F100\n')
    settle(emu)
    emu.readOutput()
    emu.setProbePlate(-40) // the plate drops away: the input never opens
    // closed at the start? no: the tool is above −40 now, so G38.5 starts open → ALARM:4
    expect(send(emu, 'G38.5 Z-10 F100\n')).toEqual(['ALARM:4', 'ok'])
  })
})

describe('fault hooks', () => {
  it('triggerHardLimit: motion stops, ALARM:1, silent until a reset', () => {
    const emu = probing()
    send(emu, 'G1 X100 F1000\n')
    emu.advance(1000)
    emu.triggerHardLimit()
    expect(outLines(emu)).toEqual(['ALARM:1', '[MSG:Reset to continue]'])
    const x = emu.status().mpos[0]
    emu.advance(5000)
    expect(emu.status().mpos[0]).toBe(x)
    expect(send(emu, '?')).toEqual([])
    expect(send(emu, 'G0 X0\n')).toEqual([])
    emu.receive(Uint8Array.of(0x18))
    expect(outLines(emu)).toContain("Grbl 1.1h ['$' for help]")
  })

  // DF134: a limit switch hit while idle (the user cleaning the machine after a run)
  it('setLimitPin: a press while idle is a hard limit; ignored in Alarm; Pn and Check Limits', () => {
    const emu = emulator({ homing: true, settings: { 21: 1 } })
    send(emu, '$X\n')
    emu.setLimitPin('x', true)
    expect(outLines(emu)).toEqual(['ALARM:1', '[MSG:Reset to continue]'])
    expect(send(emu, '?')).toEqual([])
    // released before the reset: GRBL ignores pin changes in Alarm
    emu.setLimitPin('x', false)
    expect(outLines(emu)).toEqual([])
    emu.receive(Uint8Array.of(0x18))
    expect(outLines(emu)).toEqual(["Grbl 1.1h ['$' for help]", "[MSG:'$H'|'$X' to unlock]"])
    expect(statusOf(emu)).toMatch(/^<Alarm\|/)
    expect(statusOf(emu)).not.toContain('Pn:')
    // pressed again: no alarm in Alarm, but every report shows it, and a reset checks the limits
    emu.setLimitPin('z', true)
    expect(outLines(emu)).toEqual([])
    expect(statusOf(emu)).toContain('|Pn:Z')
    emu.receive(Uint8Array.of(0x18))
    expect(outLines(emu)).toEqual([
      "Grbl 1.1h ['$' for help]",
      '[MSG:Check Limits]',
      "[MSG:'$H'|'$X' to unlock]",
    ])
    // GRBL unlocks with a pressed switch; letting go of it while Idle is a pin change: ALARM:1
    expect(send(emu, '$X\n')).toEqual(['[MSG:Caution: Unlocked]', 'ok'])
    emu.setLimitPin('z', false)
    expect(outLines(emu)).toEqual(['ALARM:1', '[MSG:Reset to continue]'])
  })

  it('setLimitPin without hard limits ($21=0): only Pn, no alarm', () => {
    const emu = emulator()
    emu.readOutput()
    emu.setLimitPin('y', true)
    expect(outLines(emu)).toEqual([])
    expect(statusOf(emu)).toMatch(/^<Idle\|.*\|Pn:Y/)
  })

  it('the safety door open: Pn:D, and $X and $H are refused (error:13)', () => {
    const emu = emulator({ homing: true })
    emu.readOutput()
    emu.setDoorPin(true)
    emu.readOutput()
    expect(statusOf(emu)).toContain('|Pn:D')
    expect(send(emu, '$X\n')).toEqual(['error:13'])
    expect(send(emu, '$H\n')).toEqual(['error:13'])
  })

  it('setSilent: nothing is answered until it speaks again', () => {
    const emu = probing()
    emu.setSilent(true)
    expect(send(emu, '?$I\n')).toEqual([])
    emu.setSilent(false)
    expect(statusOf(emu)).toMatch(/^<Idle\|/)
  })
})

describe('v0.5 RV8: homing scatter and lost steps', () => {
  const probeDown = (emu: ReturnType<typeof emulator>) => {
    send(emu, 'G53 G0 Z-50\n')
    settle(emu)
    send(emu, 'G38.2 Z-90 F100\n')
    settle(emu)
    return prb(outLines(emu))
  }
  const homeAndProbe = (emu: ReturnType<typeof emulator>) => {
    send(emu, '$H\n')
    settle(emu)
    emu.readOutput()
    return parseFloat(probeDown(emu)?.slice(5).split(',')[2] ?? '')
  }

  it('each $H draws an offset within ±width/2 (seeded); probes see it, reports do not', () => {
    const opts = { homing: true, probePlate: -80, homingScatter: { z: 0.03 }, homingSeed: 7 }
    const a = emulator(opts)
    const b = emulator(opts)
    a.readOutput()
    b.readOutput()
    const za: number[] = []
    const offsets: number[] = []
    for (let k = 0; k < 5; k++) {
      za.push(homeAndProbe(a))
      offsets.push(a.physicalOffset[2])
      expect(homeAndProbe(b)).toBe(za[k]) // the same seed, the same draws
    }
    for (const o of offsets) expect(Math.abs(o)).toBeLessThanOrEqual(0.015)
    expect(new Set(offsets).size).toBe(5)
    // the plate is physical: reported contact = plate − offset (PRB's µm rounding)
    za.forEach((z, k) => expect(z).toBeCloseTo(-80 - offsets[k]!, 3))
    // without scatter homing is exact
    const exact = emulator({ homing: true, probePlate: -80 })
    exact.readOutput()
    expect(homeAndProbe(exact)).toBe(-80)
    expect(exact.physicalOffset).toEqual([0, 0, 0])
  })

  it('lost steps shift the probe until the next homing', () => {
    const emu = emulator({ homing: true, probePlate: -80 })
    emu.readOutput()
    expect(homeAndProbe(emu)).toBe(-80)
    emu.loseSteps('z', 0.25)
    expect(probeDown(emu)).toMatch(/,-80\.250:1\]$/)
    expect(homeAndProbe(emu)).toBe(-80)
  })
})
