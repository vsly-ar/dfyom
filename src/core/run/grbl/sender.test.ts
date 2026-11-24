// GrblSender against the virtual machine on a VirtualClock, and byte-level cases on a scripted
// transport. Spec: docs/modes/run-v0.1.md#sender, #testing
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { clockTimers, VirtualClock } from '../clock'
import { settle } from './emulator.fixture'
import { GrblSender, preflight, REALTIME, type RunSummary } from './sender'
import {
  answerHandshake,
  connected,
  drive,
  flush,
  machine,
  rig,
  RX_BUFFER_SIZE,
  ScriptedTransport,
  start,
  until,
  type Rig,
} from './sender.fixture'

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

const phaseNames = (r: Rig) => r.phases.map((p) => p.phase)

describe('handshake', () => {
  it('reads version, settings, G54 and modes, then polls status', async () => {
    const emu = machine({ settings: { 13: 0 } })
    const r = await connected(emu)
    expect(r.io.written.slice(0, 4)).toEqual(['$I', '$$', '$#', '$G'])
    expect(r.sender.isConnected).toBe(true)
    await until(r.clock, () => r.sender.status !== undefined)
    expect(r.sender.status).toMatchObject({ state: 'Idle', mpos: [0, 0, 0] })
  })

  it('returns the controller info of a homing machine in Alarm', async () => {
    const r = rig(machine({ homing: true }))
    const info = expectOk(await drive(r.clock, r.sender.connect()))
    expect(info.version).toBe('1.1h.20190830')
    expect(info.settings['22']).toBe(1)
    expect(info.workZero).toEqual([0, 0, 0])
    expect(info.modes).toContain('G21')
    expect(r.events).toContainEqual({ kind: 'message', text: "'$H'|'$X' to unlock" })
    await until(r.clock, () => r.sender.status !== undefined)
    expect(r.sender.status?.state).toBe('Alarm')
  })

  it('sends one soft reset when no banner comes, then gives up', async () => {
    const clock = new VirtualClock()
    const t = new ScriptedTransport()
    const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
    const p = s.connect()
    await until(clock, () => t.writes.length > 0)
    expect(clock.now()).toBe(2000)
    expect(t.writes).toEqual(['\x18'])
    expectErrCode(await drive(clock, p), 'machine.connection')
  })

  it('accepts a banner after the reset; refuses a controller other than 1.1', async () => {
    const clock = new VirtualClock()
    const t = new ScriptedTransport()
    answerHandshake(t, '1.0c.20161014')
    const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
    const p = s.connect()
    await until(clock, () => t.writes.includes('\x18'))
    t.reply('\r\nGrbl 1.0c [', "'$' for help]\r\n")
    const e = expectErrCode(await drive(clock, p), 'machine.connection')
    expect(e.message).toMatch(/unsupported controller 1\.0c/)
    expect(s.isConnected).toBe(false)
  })
})

describe('streaming', () => {
  it('streams with character counting: no errors, no RX overflow, buffer used', async () => {
    const r = await connected(machine())
    const lines = program()
    const sum = expectOk(await drive(r.clock, start(r, lines)))
    expect(sum).toMatchObject({ lines: lines.length, toolChanges: 0, pauses: 0 })
    expect(r.io.received.filter((l) => l.startsWith('error'))).toEqual([])
    expect(r.emu.trace.violations).toEqual([])
    expect(r.io.maxInflight).toBeLessThanOrEqual(RX_BUFFER_SIZE)
    expect(r.io.maxInflight).toBeGreaterThan(RX_BUFFER_SIZE - 30)
    expect(r.io.received).toContain('[MSG:Pgm End]')
    expect(r.emu.status()).toMatchObject({ state: 'Idle', mpos: [22, 40, 5] })
    expect(phaseNames(r)).toEqual(['streaming', 'done'])
    expect(r.progress.at(-1)).toMatchObject({ done: lines.length, total: lines.length })
  })

  it('reports the planner filling (Bf:0) while streaming', async () => {
    const r = await connected(machine({ settings: { 10: 3 } }))
    const blocks: number[] = []
    r.sender.onStatus((s) => s.buffer !== undefined && blocks.push(s.buffer.blocks))
    expectOk(await drive(r.clock, start(r, program())))
    expect(blocks).toContain(0)
    expect(blocks.at(-1)).toBe(15)
  })

  it('send-response gives the same motion and timing as character counting', async () => {
    const a = await connected(machine(), { mode: 'sendResponse' })
    const b = await connected(machine())
    const sa = expectOk(await drive(a.clock, start(a, program())))
    const sb = expectOk(await drive(b.clock, start(b, program())))
    expect(a.emu.status().mpos).toEqual(b.emu.status().mpos)
    expect(a.io.maxInflight).toBeLessThanOrEqual(Math.max(...program().map((l) => l.length + 1)))
    const timing = (r: Rig) =>
      r.emu.trace.lines.map((l) => [l.text, l.startedAt ?? null, l.endedAt ?? null])
    expect(timing(a).filter((l) => !String(l[0]).startsWith('$'))).toEqual(
      timing(b).filter((l) => !String(l[0]).startsWith('$')),
    )
    expect(sa.seconds).toBeCloseTo(sb.seconds, 6)
  })

  it('labels progress by section', async () => {
    const r = await connected(machine())
    const lines = ['(pocket1)', 'G0 X1', '(drill)', 'G0 X2']
    expectOk(
      await drive(
        r.clock,
        start(r, lines, [
          { fromLine: 1, label: 'pocket1' },
          { fromLine: 3, label: 'drill' },
        ]),
      ),
    )
    const labels = [...new Set(r.progress.map((p) => p.label))]
    expect(labels).toEqual(['pocket1', 'drill'])
  })

  // 20 000 lines through the emulator: ~1 s alone, several times that
  // under a loaded parallel `npm test` (docs/conventions/testing.md#commands)
  it('streams a long program (20 000 lines) without errors', { timeout: 60_000 }, async () => {
    const r = await connected(machine({ trace: false }))
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(`G1 X${i % 2 ? 10 : 0} Y${(i % 1000) / 10} F6000`)
    const sum = expectOk(await drive(r.clock, start(r, lines), 1e12))
    expect(sum.lines).toBe(20_000)
    expect(r.io.maxInflight).toBeLessThanOrEqual(RX_BUFFER_SIZE)
  })

  it('an inch controller ($13=1) reports positions in mm', async () => {
    const r = await connected(machine({ settings: { 13: 1 } }))
    expectOk(await drive(r.clock, start(r, ['G21 G0 X25.4 Y-12.7'])))
    await until(r.clock, () => r.sender.status?.mpos[0] !== 0)
    expect(r.sender.status?.mpos[0]).toBeCloseTo(25.4, 6)
    expect(r.sender.status?.mpos[1]).toBeCloseTo(-12.7, 6)
  })
})

describe('pre-flight', () => {
  it('refuses lines GRBL cannot take, before sending anything', async () => {
    const r = await connected(machine())
    const before = r.io.written.length
    const e = expectErrCode(
      await drive(r.clock, start(r, ['G0 X1', `(${'x'.repeat(80)})`, '(why?)', 'G0 X1 (ø)'])),
      'run.program',
    )
    expect(e.issues.map((i) => [i.params?.['line'], i.rule])).toEqual([
      [2, 'lineLength'],
      [3, 'character'],
      [4, 'character'],
    ])
    expect(r.io.written.length).toBe(before)
    expectOk(preflight(['G0 X1', 'x'.repeat(79)]))
  })

  it('no commands while a program streams', async () => {
    const r = await connected(machine())
    const p = start(r, program())
    expectErrCode(await r.sender.command('$#'), 'run.state')
    expectErrCode(r.sender.continueProgram(), 'run.state')
    expectErrCode(await r.sender.run({ lines: [], sections: [] }), 'run.busy')
    expectOk(await drive(r.clock, p))
  })
})

describe('tool changes and pauses', () => {
  const head = ['G21 G90', 'M3 S12000', 'G4 P3', 'G1 X10 F600']
  const marker = '(DFYOM TOOL CHANGE 2: 3 mm flat)'
  const change = ['M5', 'G0 Z5', marker, 'M0', 'M3 S10000', 'G4 P3']
  const tail = ['G1 X20 F600', 'M5', 'M30']

  it('stops before the marker, allows jog and zeroing, then sends the marker and skips M0', async () => {
    const r = await connected(machine({ settings: { 30: 24000 } }))
    const lines = [...head, ...change, ...tail]
    const p = start(r, lines)
    expect(await until(r.clock, () => r.sender.phase === 'toolChange')).toBe(true)
    expect(r.phases.at(-1)).toEqual({
      phase: 'toolChange',
      toolChange: { n: 2, name: '3 mm flat' },
    })
    expect(r.progress.at(-1)?.label).toBe('Tool change 2: 3 mm flat')
    expect(r.emu.status()).toMatchObject({ state: 'Idle', spindleSpeed: 0, mpos: [10, 0, 5] })
    // the user jogs down to the new tool's touch-off and zeroes Z there
    expectOk(await drive(r.clock, r.sender.command('$J=G21 G91 Z-7 F300')))
    await until(r.clock, () => r.sender.status?.state === 'Idle' && r.emu.status().state === 'Idle')
    expectOk(await drive(r.clock, r.sender.command('G10 L20 P1 Z0')))
    expect(expectOk(await drive(r.clock, r.sender.readWorkZero()))[2]).toBeCloseTo(-2, 9)
    await drive(r.clock, r.sender.freshStatus())
    expectOk(r.sender.continueProgram())
    const sum = expectOk(await drive(r.clock, p))
    expect(sum).toMatchObject({ lines: lines.length, toolChanges: 1 })
    const texts = r.emu.trace.lines.map((l) => l.text)
    expect(texts).toContain(marker)
    expect(texts).not.toContain('M0')
    expect(r.emu.status().mpos).toEqual([20, 0, -2]) // cut at the new Z0
    expect(r.progress.at(-1)).toMatchObject({ done: lines.length, total: lines.length })
    // waiting time is not machine time
    expect(sum.elapsedSeconds).toBeGreaterThan(sum.seconds)
  })

  it.each([
    [
      'a malformed marker',
      ['(DFYOM TOOL CHANGE 2 3 mm flat)', 'M0'],
      'DFYOM TOOL CHANGE 2 3 mm flat',
    ],
    [
      'a marker not followed by exactly M0',
      [marker, 'M0 (pause)'],
      'DFYOM TOOL CHANGE 2: 3 mm flat',
    ],
    ['a marker inside a longer line', [`G0 Z5 ${marker}`, 'M0'], 'Program paused (M0)'],
  ])('falls back to the plain M0 pause for %s', async (_name, lines, message) => {
    const r = await connected(machine())
    const p = start(r, ['G0 Z5', ...lines, 'G0 X1'])
    expect(await until(r.clock, () => r.sender.phase === 'programPause')).toBe(true)
    expect(r.phases.at(-1)).toEqual({ phase: 'programPause', message })
    expect(r.emu.status().state).toBe('Hold:0')
    expectOk(r.sender.continueProgram())
    expect(expectOk(await drive(r.clock, p))).toMatchObject({ pauses: 1, toolChanges: 0 })
    expect(r.emu.status().mpos).toEqual([1, 0, 5])
  })

  // docs/architecture/grbl.md#pause-messages-hardening-df63
  it('a marker followed by M0 with a ; message is a tool change too; the M0 is skipped', async () => {
    const r = await connected(machine())
    const pause = 'M0 ;Install T2 3 mm flat, 3 mm flat, then zero Z'
    const p = start(r, [...head, 'M5', 'G0 Z5', marker, pause, 'M3 S10000', ...tail])
    expect(await until(r.clock, () => r.sender.phase === 'toolChange')).toBe(true)
    expect(r.phases.at(-1)).toEqual({
      phase: 'toolChange',
      toolChange: { n: 2, name: '3 mm flat' },
    })
    await drive(r.clock, r.sender.freshStatus())
    expectOk(r.sender.continueProgram())
    expect(expectOk(await drive(r.clock, p))).toMatchObject({ toolChanges: 1, pauses: 0 })
    expect(r.emu.trace.lines.map((l) => l.text)).not.toContain(pause)
  })

  // docs/modes/z-reference.md#exported-gcode (DF69)
  it('a tool change carries the Z reference lines before its marker', async () => {
    const r = await connected(machine())
    const p = start(r, [
      ...head,
      'M5',
      'G0 Z5',
      'X50 Y30',
      '(Z0 for tool 2: Facing 1 floor, 0.50 below the stock top)',
      '(Touch off Z here, X50 Y30: set Z0 on that surface)',
      '(Stop the spindle)',
      marker,
      'M0 ;Stop spindle, install T2 3 mm flat, 3 mm flat, then zero Z',
      ...tail,
    ])
    expect(await until(r.clock, () => r.sender.phase === 'toolChange')).toBe(true)
    expect(r.phases.at(-1)).toEqual({
      phase: 'toolChange',
      toolChange: {
        n: 2,
        name: '3 mm flat',
        surface: 'Facing 1 floor, 0.50 below the stock top',
        spot: 'X50 Y30',
      },
    })
    await drive(r.clock, r.sender.freshStatus())
    expectOk(r.sender.continueProgram())
    expect(expectOk(await drive(r.clock, p))).toMatchObject({ toolChanges: 1 })
  })

  it('a plain pause shows the ; message on its M0 line before the comment line above', async () => {
    const r = await connected(machine())
    const p = start(r, ['G0 Z5', '(Other text)', 'M0 ;Set spindle to 10000 rpm', 'G0 X1', 'M30'])
    expect(await until(r.clock, () => r.sender.phase === 'programPause')).toBe(true)
    expect(r.phases.at(-1)).toEqual({ phase: 'programPause', message: 'Set spindle to 10000 rpm' })
    expectOk(r.sender.continueProgram())
    expectOk(await drive(r.clock, p))
  })

  it('manual-spindle prompts pause with their message', async () => {
    const r = await connected(machine())
    const p = start(r, ['M3 S10000', '(Set spindle to 10000 rpm)', 'M0', 'G0 X1', 'M30'])
    expect(await until(r.clock, () => r.sender.phase === 'programPause')).toBe(true)
    expect(r.progress.at(-1)?.label).toBe('Set spindle to 10000 rpm')
    expect(await until(r.clock, () => false, 60_000)).toBe(false) // stays paused
    expectOk(r.sender.continueProgram())
    expectOk(await drive(r.clock, p))
  })
})

describe('hold, resume and stop', () => {
  const long = ['G21 G90', 'G1 X300 F3000', 'G1 X0', 'M30']

  it('holds and resumes', async () => {
    const r = await connected(machine())
    const p = start(r, long)
    await until(r.clock, () => r.clock.now() > 2000)
    expectOk(r.sender.hold())
    await until(r.clock, () => r.emu.status().state === 'Hold:0')
    const x = r.emu.status().mpos[0]
    await until(r.clock, () => false, 5000)
    expect(r.emu.status().mpos[0]).toBe(x)
    expectErrCode(r.sender.hold(), 'run.state')
    expectOk(r.sender.resume())
    const sum = expectOk(await drive(r.clock, p))
    expect(phaseNames(r)).toEqual(['streaming', 'held', 'streaming', 'done'])
    expect(sum.elapsedSeconds - sum.seconds).toBeGreaterThanOrEqual(5)
  })

  it('stop: hold, then reset; the position is kept and no alarm is raised', async () => {
    const r = await connected(machine())
    const p = start(r, long)
    await until(r.clock, () => r.clock.now() > 2000)
    const stopped = r.sender.stop()
    expectErrCode(await drive(r.clock, p), 'op.aborted')
    expectOk(await stopped)
    expect(r.io.received.filter((l) => l.startsWith('ALARM'))).toEqual([])
    expect(r.events).toContainEqual({ kind: 'reset', expected: true })
    await until(r.clock, () => r.emu.status().state === 'Idle')
    const x = r.emu.status().mpos[0]
    expect(x).toBeGreaterThan(50)
    await until(r.clock, () => false, 10_000)
    expect(r.emu.status()).toMatchObject({ state: 'Idle', mpos: [x, 0, 0] })
    expect(phaseNames(r)).toEqual(['streaming', 'stopping', 'stopped'])
    // the connection keeps working
    expectOk(await drive(r.clock, r.sender.command('G0 X0')))
  })

  it('stop timeout: motion not stopped in time is reset anyway (ALARM:3)', async () => {
    // 2 mm/s² from 3000 mm/min: 12.5 s to stop
    const r = await connected(machine({ settings: { 120: 2 } }), { holdTimeoutMs: 1000 })
    const p = start(r, long)
    await until(r.clock, () => r.clock.now() > 30_000)
    void r.sender.stop()
    const e = expectErrCode(await drive(r.clock, p), 'machine.alarm')
    expect(e.toJSON().frames[0]?.data).toMatchObject({ code: 3 })
    expect(r.io.received).toContain('ALARM:3')
  })

  it('stop in a tool change only resets', async () => {
    const r = await connected(machine())
    const p = start(r, ['G0 Z5', '(DFYOM TOOL CHANGE 2: x)', 'M0', 'G0 X1'])
    await until(r.clock, () => r.sender.phase === 'toolChange')
    const before = r.io.received.length
    void r.sender.stop()
    expectErrCode(await drive(r.clock, p), 'op.aborted')
    expect(r.io.received.slice(before).filter((l) => l.startsWith('ALARM'))).toEqual([])
  })
})

describe('errors, alarms and the connection', () => {
  it('error:N holds and resets at once: machine.error with the line', async () => {
    // The emulator applies `!` the instant it arrives, so here no later line starts. On real GRBL
    // lines already planned may begin before the hold decelerates (docs/modes/run-v0.1.md).
    const r = await connected(machine())
    const p = start(r, ['G0 X1', 'G81 X1 Y1 Z-1 R1 F100', 'G0 X2'])
    const e = expectErrCode(await drive(r.clock, p), 'machine.error')
    expect(e.toJSON().frames[0]?.data).toMatchObject({ code: 20, line: 2 })
    expect(r.events).toContainEqual(expect.objectContaining({ kind: 'error', code: 20, line: 2 }))
    // `!`, then the reset that flushes GRBL's buffers
    expect(r.io.realtime.lastIndexOf(0x18)).toBeGreaterThan(r.io.realtime.indexOf(0x21))
    expect(r.io.realtime.indexOf(0x21)).toBeGreaterThanOrEqual(0)
    const later = r.emu.trace.lines.find((l) => l.text === 'G0 X2')
    expect(later?.startedAt).toBeUndefined()
    settle(r.emu)
    expect(r.emu.status().mpos[0]).toBeLessThanOrEqual(1)
  })

  it('a soft-limit alarm fails the run with machine.alarm', async () => {
    const r = await connected(machine({ homing: true }))
    expectOk(await drive(r.clock, r.sender.command('$H')))
    const p = start(r, ['G53 G0 X-10', 'G0 X10'])
    const e = expectErrCode(await drive(r.clock, p), 'machine.alarm')
    expect(e.toJSON().frames[0]?.data).toMatchObject({ code: 2 })
    // GRBL sends nothing until a reset; the watchdog does not count that as a lost connection
    await until(r.clock, () => false, 10_000)
    expect(r.sender.isConnected).toBe(true)
    expectOk(r.sender.realtime(REALTIME.reset))
    expectOk(await drive(r.clock, r.sender.command('$X')))
  })

  it('a banner mid-run (controller reset by itself) fails with machine.connection', async () => {
    const r = await connected(machine())
    const p = start(r, ['G4 P10', 'G0 X1'])
    await until(r.clock, () => r.clock.now() > 1000)
    r.emu.receive(Uint8Array.of(0x18)) // someone else reset it, during a dwell
    r.clock.advance(0)
    expectErrCode(await drive(r.clock, p), 'machine.connection')
    expect(r.events).toContainEqual({ kind: 'reset', expected: false })
    expect(r.sender.isConnected).toBe(true)
    // during motion GRBL reports ALARM:3 first: the run fails with that alarm
    const q = start(r, ['G1 X300 F3000'])
    await until(r.clock, () => r.emu.status().state === 'Run')
    r.emu.receive(Uint8Array.of(0x18))
    r.clock.advance(0)
    expectErrCode(await drive(r.clock, q), 'machine.alarm')
  })

  it('a write failure or a missing status reply loses the connection', async () => {
    const clock = new VirtualClock()
    const t = new ScriptedTransport()
    answerHandshake(t)
    const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
    const lost: string[] = []
    s.onEvent((e) => e.kind === 'connectionLost' && lost.push(e.reason))
    const c = s.connect()
    t.reply("\r\nGrbl 1.1h ['$' for help]\r\n")
    expectOk(await drive(clock, c))
    t.onWrite = undefined // never answers `?` any more
    const p = s.run({ lines: ['G0 X1'], sections: [] })
    expectErrCode(await drive(clock, p), 'machine.connection')
    expect(lost).toEqual(['no status reply'])
    expect(clock.now()).toBeLessThan(3000)
    expectErrCode(await s.command('$#'), 'machine.connection')

    const t2 = new ScriptedTransport()
    answerHandshake(t2)
    const s2 = new GrblSender(t2, clock, { timers: clockTimers(clock) })
    const c2 = s2.connect()
    t2.reply("\r\nGrbl 1.1h ['$' for help]\r\n")
    expectOk(await drive(clock, c2))
    t2.failWrites = true
    const q = s2.command('G0 X1')
    await flush()
    expectErrCode(await q, 'machine.connection')
  })

  it('splits responses across chunk boundaries and several per chunk', async () => {
    const clock = new VirtualClock()
    const t = new ScriptedTransport()
    answerHandshake(t)
    const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
    const c = s.connect()
    t.reply('\r\nGr', "bl 1.1h ['$' for help]\r", '\n')
    expectOk(await drive(clock, c))
    t.onWrite = undefined
    const p = s.run({ lines: ['G0 X1', 'G0 X2', 'G0 X3'], sections: [] })
    expect(t.writes.slice(-3)).toEqual(['G0 X1\n', 'G0 X2\n', 'G0 X3\n'])
    t.reply('ok\r\nok', '\r\nok\r\n<Idle|MPos:3.000,0.000,0.000|FS:0,0>\r', '\n')
    // the report came before a status request after the last ok: one more poll decides
    await until(clock, () => t.writes.at(-1) === '?')
    t.reply('<Idle|MPos:3.000,0.000,0.000|FS:0,0>\r\n')
    const sum: RunSummary = expectOk(await drive(clock, p))
    expect(sum.lines).toBe(3)
    expect(s.status?.mpos).toEqual([3, 0, 0])
  })

  it('close fails a running program and closes the transport', async () => {
    const r = await connected(machine())
    const p = start(r, ['G1 X300 F3000'])
    await until(r.clock, () => r.clock.now() > 100)
    expectOk(await r.sender.close())
    expectErrCode(await p, 'machine.connection')
    expectErrCode(await r.sender.command('$#'), 'machine.connection')
  })
})
