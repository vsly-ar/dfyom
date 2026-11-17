// The virtual machine behind ControllerTransport, driven by a test streamer in virtual time.
// Spec: docs/architecture/grbl.md#transport-and-sender, #state-machine
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { VirtualClock } from '../clock'
import { RX_BUFFER_SIZE } from './emulator/emulator'
import { bytes, emulator, send, settle, TestStreamer } from './emulator.fixture'
import { VirtualGrblTransport } from './virtual-transport'

const BANNER = "Grbl 1.1h ['$' for help]"

/** A program shaped like the post-processor's output (grbl.md#output-dialect). */
function program(): string[] {
  const lines = [
    '(DFYOM test program)',
    '(Setup 1, mm)',
    'G90 G94 G17 G21',
    'G54',
    'G0 Z5',
    'M3 S12000',
    'G4 P3',
  ]
  for (let i = 0; i < 40; i++) {
    lines.push(`G1 X${(i % 2) * 20} Y${i} Z-1 F1200`)
    lines.push(`G2 X${(i % 2) * 20 + 2} Y${i + 1} I1 J0.5`)
  }
  lines.push('G0 Z5', 'M5', 'M30')
  return lines
}

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

  it('streams a program with character counting: no errors, no RX overflow, buffer used', () => {
    const s = new TestStreamer(emulator())
    const lines = program()
    s.send(lines)
    expect(s.runUntil(() => s.idle)).toBe(true)
    expect(s.errors).toEqual([])
    expect(s.acked).toBe(lines.length)
    // The emulator records any byte it had to drop; the streamer did fill most of the buffer.
    expect(s.emu.trace.violations).toEqual([])
    expect(s.maxInflight).toBeGreaterThan(RX_BUFFER_SIZE - 30)
    expect(s.received).toContain('[MSG:Pgm End]')
    settle(s.emu)
    expect(s.status()).toMatch(/^<Idle\|MPos:22\.000,40\.000,5\.000\|/)
  })

  it('fills the planner (Bf:0) while streaming and empties it at the end', () => {
    const s = new TestStreamer(emulator({ settings: { 10: 3 } }))
    s.send(program())
    s.runUntil(() => s.clock.now() >= 10_000)
    expect(s.status()).toMatch(/\|Bf:0,\d+\|/)
    s.runUntil(() => s.idle)
    expect(s.status()).toMatch(/\|Bf:15,128\|/)
  })

  it('send-response gives the same motion and timing as character counting', () => {
    const a = new TestStreamer(emulator(), { mode: 'sendResponse' })
    a.send(program())
    a.runUntil(() => a.idle)
    const b = new TestStreamer(emulator())
    b.send(program())
    b.runUntil(() => b.idle)
    expect(a.errors).toEqual([])
    expect(a.emu.status().mpos).toEqual(b.emu.status().mpos)
    expect(a.maxInflight).toBeLessThanOrEqual(Math.max(...program().map((l) => l.length + 1)))
    const timing = (s: TestStreamer) =>
      s.emu.trace.lines.map((l) => [l.text, l.startedAt ?? null, l.endedAt ?? null])
    expect(timing(a)).toEqual(timing(b))
  })

  it('stops sending and feed-holds at the first error', () => {
    const s = new TestStreamer(emulator(), { mode: 'sendResponse', stopOnError: true })
    s.send(['G0 X1', 'G81 X1 Y1 Z-1 R1 F100', 'G0 X2'])
    s.runUntil(() => s.stopped)
    s.runUntil(() => false, 60_000)
    expect(s.errors).toEqual(['error:20'])
    expect(s.emu.trace.lines.map((l) => [l.text, l.response])).toEqual([
      ['G0 X1', 'ok'],
      ['G81 X1 Y1 Z-1 R1 F100', 'error:20'],
    ])
    expect(s.emu.status().state).toBe('Hold:0')
  })

  it('streams 100 000 lines in well under 5 s', () => {
    const s = new TestStreamer(emulator({ trace: false }))
    const lines: string[] = []
    for (let i = 0; i < 100_000; i++) lines.push(`G1 X${i % 2 ? 10 : 0} Y${(i % 1000) / 10} F6000`)
    const start = Date.now()
    s.send(lines)
    expect(s.runUntil(() => s.idle, 1e12)).toBe(true)
    expect(Date.now() - start).toBeLessThan(5000)
    expect(s.acked).toBe(100_000)
    expect(s.errors).toEqual([])
  })
})

describe('guided tool change', () => {
  const head = ['G21 G90', 'M3 S12000', 'G4 P3', 'G1 X10 F600']
  const marker = '(DFYOM TOOL CHANGE 2: 3 mm flat)'
  const change = ['M5', 'G0 Z5', marker, 'M0', 'M3 S10000', 'G4 P3']
  const tail = ['G1 X20 F600', 'M5', 'M30']

  it('other senders: M0 pauses in Hold:0 with the spindle off; ~ resumes', () => {
    const s = new TestStreamer(emulator({ settings: { 30: 24000 } }))
    s.send([...head, ...change, ...tail])
    s.runUntil(() => s.emu.status().state === 'Hold:0')
    const m0 = s.emu.trace.lines.findIndex((l) => l.text === 'M0')
    expect(s.emu.trace.lines[m0 - 1]).toMatchObject({ text: marker, response: 'ok' })
    expect(s.emu.trace.lines[m0]?.response).toBeUndefined() // M0's ok comes after ~
    expect(s.emu.status()).toMatchObject({ spindleSpeed: 0, mpos: [10, 0, 5] })
    expect(s.runUntil(() => s.idle, 60_000)).toBe(false) // stays paused
    const resumeAt = s.clock.now()
    s.realtime('~')
    s.runUntil(() => s.idle)
    expect(s.errors).toEqual([])
    const lines = s.emu.trace.lines
    expect(lines[m0]?.ackedAt).toBe(resumeAt)
    const dwell = lines[m0 + 2]
    expect(dwell).toMatchObject({ text: 'G4 P3', startedAt: resumeAt, endedAt: resumeAt + 3000 })
    expect(lines[m0 + 3]?.startedAt).toBe(resumeAt + 3000)
  })

  it('GRBL does not jog while paused by M0: the jog waits unanswered in RX', () => {
    const s = new TestStreamer(emulator())
    s.send(['G0 Z5', 'M0'])
    s.runUntil(() => s.emu.status().state === 'Hold:0')
    const before = s.received.length
    s.manual(['$J=G91 X5 F300'])
    s.runUntil(() => false, 10_000)
    expect(s.received.slice(before)).toEqual([])
    expect(s.emu.status()).toMatchObject({ state: 'Hold:0', mpos: [0, 0, 5] })
  })

  it('DFYOM sender: stops before the marker, jogs, zeroes Z with G10 L20, skips M0', () => {
    const s = new TestStreamer(emulator({ settings: { 30: 24000 } }), { toolChange: 'dfyom' })
    s.send([...head, ...change, ...tail])
    expect(s.runUntil(() => s.toolChangeReady)).toBe(true)
    expect(s.toolChange).toEqual({ tool: 2, name: '3 mm flat' })
    expect(s.emu.status()).toMatchObject({ spindleSpeed: 0, mpos: [10, 0, 5] })
    // Guide the user: jog down to the new tool's touch-off and zero Z there.
    s.manual(['$J=G91 G21 Z-7 F300'])
    s.runUntil(() => s.emu.status().state === 'Jog')
    s.runUntil(() => s.inflightLines === 0 && s.emu.status().state === 'Idle')
    expect(s.emu.status().mpos[2]).toBeCloseTo(-2, 9)
    s.manual(['G10 L20 P1 Z0'])
    s.runUntil(() => s.inflightLines === 0)
    expect(s.emu.status().wco).toEqual([0, 0, -2])
    s.resumeToolChange()
    s.runUntil(() => s.idle)
    expect(s.errors).toEqual([])
    const texts = s.emu.trace.lines.map((l) => l.text)
    expect(texts).toContain(marker)
    expect(texts).not.toContain('M0')
    settle(s.emu)
    expect(s.emu.status().mpos).toEqual([20, 0, -2]) // cut at the new Z0
    // The jog did not change the modal state: still G90.
    expect(send(s.emu, '$G\n')[0]).toMatch(/G90 G94/)
  })

  it.each([
    ['a malformed marker', ['(DFYOM TOOL CHANGE 2 3 mm flat)', 'M0']],
    ['a marker not followed by exactly M0', [marker, 'M0 (pause)']],
    ['a marker inside a longer line', [`G0 Z5 ${marker}`, 'M0']],
  ])('DFYOM sender falls back to the plain M0 pause for %s', (_name, lines) => {
    const s = new TestStreamer(emulator(), { toolChange: 'dfyom' })
    s.send(['G0 Z5', ...lines, 'G0 X1'])
    s.runUntil(() => s.emu.status().state === 'Hold:0')
    expect(s.toolChange).toBeUndefined()
    s.realtime('~')
    s.runUntil(() => s.idle)
    expect(s.errors).toEqual([])
    settle(s.emu)
    expect(s.emu.status().mpos).toEqual([1, 0, 5])
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
