// The virtual machine behind ControllerTransport in virtual time, and GRBL protocol facts the
// sender relies on. Streaming itself: sender.test.ts.
// Spec: docs/architecture/grbl.md#transport-and-sender, #state-machine
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { VirtualClock } from '../clock'
import type { GrblEmulator } from './emulator/emulator'
import { bytes, emulator, outLines, send, settle } from './emulator.fixture'
import { VirtualGrblTransport } from './virtual-transport'

const BANNER = "Grbl 1.1h ['$' for help]"

describe('VirtualGrblTransport', () => {
  it('delivers the banner, then answers writes; a closed transport fails', async () => {
    const clock = new VirtualClock()
    const t = new VirtualGrblTransport(emulator(), clock)
    const got: string[] = []
    t.onData((b) => got.push(String.fromCharCode(...b)))
    clock.advance(0)
    expect(got.join('')).toBe(`\r\n${BANNER}\r\n`)
    expectOk(await t.write(bytes('G4 P1\n')))
    expect(got).toHaveLength(1)
    expect(clock.nextAt()).toBe(1000)
    clock.advance(1000)
    expect(got.at(-1)).toBe('ok\r\n')
    expectOk(await t.close())
    expectErrCode(await t.write(bytes('?')), 'machine.connection')
    expect(clock.nextAt()).toBeUndefined()
  })

  it('never delivers a response during write(): a sender can book-keep after awaiting it', async () => {
    const clock = new VirtualClock()
    const t = new VirtualGrblTransport(emulator(), clock)
    const events: string[] = []
    t.onData((b) => events.push(`data:${String.fromCharCode(...b).trim()}`))
    clock.advance(0)
    events.length = 0
    const p = t.write(bytes('G4 P0\n'))
    events.push('written')
    expectOk(await p)
    events.push('booked')
    expect(events).toEqual(['written', 'booked'])
    clock.advance(0)
    expect(events).toEqual(['written', 'booked', 'data:ok'])
  })
})

/** Runs events until `done()` (the machine alone, no sender). */
function stepUntil(emu: GrblEmulator, done: () => boolean): void {
  for (let t = emu.nextEventAt(); !done() && t !== undefined; t = emu.nextEventAt())
    emu.advanceTo(t)
}

describe('M0 pause (what other senders get; GrblSender stops before a tool change instead)', () => {
  const head = ['G21 G90', 'M3 S12000', 'G4 P3', 'G1 X10 F600']
  const marker = '(DFYOM TOOL CHANGE 2: 3 mm flat)'
  const change = ['M5', 'G0 Z5', marker, 'M0', 'M3 S10000', 'G4 P3']
  const tail = ['G1 X20 F600', 'M5', 'M30']

  it('M0 pauses in Hold:0 with the spindle off; ~ resumes', () => {
    const emu = emulator({ settings: { 30: 24000 } })
    outLines(emu)
    const out = send(emu, [...head, ...change, ...tail].map((l) => `${l}\n`).join(''))
    stepUntil(emu, () => emu.status().state === 'Hold:0')
    const m0 = emu.trace.lines.findIndex((l) => l.text === 'M0')
    expect(emu.trace.lines[m0 - 1]).toMatchObject({ text: marker, response: 'ok' })
    expect(emu.trace.lines[m0]?.response).toBeUndefined() // M0's ok comes after ~
    expect(emu.status()).toMatchObject({ spindleSpeed: 0, mpos: [10, 0, 5] })
    emu.advance(60_000) // stays paused
    expect(emu.status().state).toBe('Hold:0')
    const resumeAt = emu.time
    send(emu, '~')
    settle(emu)
    expect([...out, ...outLines(emu)].filter((l) => l.startsWith('error'))).toEqual([])
    const lines = emu.trace.lines
    expect(lines[m0]?.ackedAt).toBe(resumeAt)
    const dwell = lines[m0 + 2]
    expect(dwell).toMatchObject({ text: 'G4 P3', startedAt: resumeAt, endedAt: resumeAt + 3000 })
    expect(lines[m0 + 3]?.startedAt).toBe(resumeAt + 3000)
  })

  it('GRBL does not jog while paused by M0: the jog waits unanswered in RX', () => {
    const emu = emulator()
    outLines(emu)
    send(emu, 'G0 Z5\nM0\n')
    stepUntil(emu, () => emu.status().state === 'Hold:0')
    outLines(emu)
    expect(send(emu, '$J=G91 X5 F300\n')).toEqual([])
    emu.advance(10_000)
    expect(outLines(emu)).toEqual([])
    expect(emu.status()).toMatchObject({ state: 'Hold:0', mpos: [0, 0, 5] })
  })
})

describe('jogging', () => {
  it('jogs in Jog state, rejects gCode meanwhile, and cancels with 0x85', () => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, '$J=G91 X100 F3000\n')).toEqual(['ok'])
    expect(emu.status().state).toBe('Jog')
    expect(send(emu, 'G0 X0\n')).toEqual(['error:9'])
    expect(send(emu, '$J=G91 X10 F3000\n')).toEqual(['ok']) // jogs queue
    emu.advance(1000) // x = 37.5 at 50 mm/s
    send(emu, '\x85')
    settle(emu)
    expect(emu.status()).toMatchObject({ state: 'Idle', plannerFree: 15 })
    expect(emu.status().mpos[0]).toBeCloseTo(50, 9)
    // The parser continues from where the jog stopped.
    send(emu, 'G91 G0 X1\n')
    settle(emu)
    expect(emu.status().mpos[0]).toBeCloseTo(51, 9)
  })

  it('feed hold cancels a jog', () => {
    const emu = emulator()
    send(emu, '$J=X100 F3000\n')
    emu.advance(1000)
    send(emu, '!')
    expect(emu.status().state).toBe('Jog')
    settle(emu)
    expect(emu.status().state).toBe('Idle')
  })

  it('ignores the feed override and checks jog targets against soft limits', () => {
    const emu = emulator({ homing: true })
    send(emu, '$H\n')
    settle(emu)
    emu.readOutput()
    expect(send(emu, '$J=G91 X2 F100\n')).toEqual(['error:15']) // homed at X-1
    expect(emu.status().state).toBe('Idle')
    send(emu, '\x92'.repeat(5))
    send(emu, '$J=G91 X-100 F3000\n')
    settle(emu)
    expect(emu.trace.lines.at(-1)?.endedAt).toBeCloseTo(
      emu.trace.lines.at(-1)!.receivedAt + 2500,
      6,
    )
  })

  it.each([
    ['$J=G0 X1 F100', 'error:16'],
    ['$J=G4 P1 F100', 'error:16'],
    ['$J=M3 X1 F100', 'error:16'],
    ['$J=X1', 'error:22'],
    ['$J=X1 F100 S10', 'error:36'],
    ['$J X1 F100', 'error:3'],
    ['$J=G20 G53 X1 F10', 'ok'],
  ])('%s → %s', (line, response) => {
    const emu = emulator()
    emu.readOutput()
    expect(send(emu, `${line}\n`)).toEqual([response])
  })
})

describe('safety door', () => {
  it('0x84 (no door pin): stops motion and spindle, Door:0, ~ restores the spindle for 4 s', () => {
    const emu = emulator({ settings: { 30: 24000 } })
    send(emu, 'M3 S12000\nG1 X100 F3000\n')
    emu.advance(1000)
    emu.readOutput()
    expect(send(emu, '\x84')).toEqual(['[MSG:Check Door]'])
    expect(emu.status().state).toBe('Door:2')
    settle(emu)
    expect(emu.status()).toMatchObject({ state: 'Door:0', spindleSpeed: 0 })
    send(emu, '~')
    expect(emu.status()).toMatchObject({ state: 'Door:3', spindleSpeed: 12000 })
    emu.advance(4000)
    expect(emu.status().state).toBe('Run')
    settle(emu)
    expect(emu.status()).toMatchObject({ state: 'Idle', mpos: [100, 0, 0] })
    expect(emu.trace.transitions.map((t) => t.to)).toEqual([
      'Run',
      'Door:2',
      'Door:0',
      'Door:3',
      'Run',
      'Idle',
    ])
  })

  it('with the door pin open (test hook) waits in Door:1 until it closes', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000)
    emu.setDoorPin(true)
    expect(emu.status().state).toBe('Door:2')
    settle(emu)
    expect(emu.status().state).toBe('Door:1')
    send(emu, '~')
    expect(emu.status().state).toBe('Door:1') // door still open
    emu.setDoorPin(false)
    expect(emu.status().state).toBe('Door:0')
    send(emu, '~')
    expect(emu.status().state).toBe('Run')
  })

  it('opens in Idle as Door:0 and resumes at once without a spindle', () => {
    const emu = emulator()
    send(emu, '\x84')
    expect(emu.status().state).toBe('Door:0')
    send(emu, '~')
    expect(emu.status().state).toBe('Idle')
  })

  it('a door during a jog stays in Jog until the jog cancel completes', () => {
    const emu = emulator()
    send(emu, '$J=G91 X100 F3000\n')
    emu.advance(1000)
    send(emu, '\x84')
    expect(emu.status().state).toBe('Jog')
    settle(emu)
    expect(emu.status()).toMatchObject({ state: 'Door:0', plannerFree: 15 })
    expect(emu.status().mpos[0]).toBeCloseTo(50, 9)
    send(emu, '~')
    expect(emu.status().state).toBe('Idle')
  })

  it('reset during the door deceleration raises ALARM:3', () => {
    const emu = emulator()
    send(emu, 'G1 X100 F3000\n')
    emu.advance(1000)
    send(emu, '\x84')
    expect(send(emu, '\x18')[0]).toBe('ALARM:3')
  })
})

describe('feed hold and spindle stop', () => {
  it('toggles the spindle off in Hold:0 with 0x9E and restores it on resume', () => {
    const emu = emulator({ settings: { 30: 24000 } })
    send(emu, 'M3 S12000\nG1 X100 F3000\n')
    emu.advance(500)
    send(emu, '!')
    settle(emu)
    emu.readOutput()
    send(emu, '\x9e')
    expect(emu.status().spindleSpeed).toBe(0)
    expect(send(emu, '~')).toEqual(['[MSG:Restoring spindle]'])
    expect(emu.status()).toMatchObject({ state: 'Run', spindleSpeed: 12000 })
  })
})
