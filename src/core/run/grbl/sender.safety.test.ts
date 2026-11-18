// Safety cases of GrblSender from the 3.9 review: stop and close always reach the reset, critical
// alarms, command timeouts, lost acknowledgements, stale reports after `~`, tool-change continue
// checks and the work coordinate offset. Spec: docs/modes/run-v0.1.md#sender, #safety-v01
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { clockTimers, VirtualClock } from '../clock'
import { GrblSender, REALTIME } from './sender'
import {
  answerHandshake,
  answerStatus,
  connected,
  drive,
  flush,
  machine,
  RX_BUFFER_SIZE,
  ScriptedTransport,
  start,
  until,
  type Rig,
} from './sender.fixture'

const IDLE = '<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>'

/** A sender on a scripted controller; `report` answers each `?` after the handshake. */
async function scripted(report: () => string | undefined = () => IDLE) {
  const clock = new VirtualClock()
  const t = new ScriptedTransport()
  answerHandshake(t)
  const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
  const c = s.connect()
  t.reply("\r\nGrbl 1.1h ['$' for help]\r\n")
  expectOk(await drive(clock, c))
  answerStatus(t, report)
  return { clock, t, s }
}

const TOOL_CHANGE = ['G21 G90', 'G0 Z5', '(DFYOM TOOL CHANGE 2: 3 mm flat)', 'M0', 'G0 X1', 'M30']

async function atToolChange(): Promise<{ r: Rig; p: ReturnType<typeof start> }> {
  const r = await connected(machine())
  const p = start(r, TOOL_CHANGE)
  expect(await until(r.clock, () => r.sender.phase === 'toolChange')).toBe(true)
  return { r, p }
}

describe('stop and close always end in a reset', () => {
  it('a second stop() while stopping waits for the end of the run', async () => {
    const r = await connected(machine())
    const p = start(r, ['G21 G91', 'G1 X300 F3000'])
    await until(r.clock, () => r.emu.status().state === 'Run')
    void r.sender.stop()
    let second = false
    void r.sender.stop().then(() => (second = true))
    await flush()
    expect(second).toBe(false)
    expectErrCode(await drive(r.clock, p), 'op.aborted')
    await flush()
    expect(second).toBe(true)
  })

  it('close() during a run resets the controller first (spindle off, buffers flushed)', async () => {
    const r = await connected(machine({ settings: { 30: 24000 } }))
    const p = start(r, ['G21 G91', 'M3 S10000', 'G1 X300 F3000'])
    await until(r.clock, () => r.emu.status().state === 'Run' && r.emu.status().spindleSpeed > 0)
    expectOk(await r.sender.close())
    expectErrCode(await p, 'machine.connection')
    expect(r.io.realtime.at(-1)).toBe(REALTIME.reset) // nothing after it: the transport is closed
    expect(r.emu.status()).toMatchObject({ spindleSpeed: 0, rxFree: RX_BUFFER_SIZE })
  })

  it('stop at a tool change during a jog cancels the jog first: no ALARM:3', async () => {
    const { r, p } = await atToolChange()
    expectOk(await drive(r.clock, r.sender.command('$J=G21 G91 X200 F600')))
    await until(r.clock, () => r.emu.status().state === 'Jog')
    void r.sender.stop()
    expectErrCode(await drive(r.clock, p), 'op.aborted')
    expect(r.io.received.filter((l) => l.startsWith('ALARM'))).toEqual([])
    expect(r.io.realtime).toContain(REALTIME.jogCancel)
  })
})

describe('critical alarms and command timeouts', () => {
  it('after a critical alarm only a reset is accepted; queued and pending commands fail', async () => {
    let answering = true
    const { clock, s, t } = await scripted(() => (answering ? IDLE : undefined))
    const answer = t.onWrite
    t.onWrite = (w) => (w === '$#\n' ? undefined : answer?.(w))
    const pending = s.command('$#') // never answered
    answering = false
    t.reply('ALARM:1\r\n[MSG:Reset to continue]\r\n')
    expectErrCode(await pending, 'machine.alarm')
    const refused = await s.command('G10 L20 P1 Z0')
    expectErrCode(refused, 'run.state')
    // GRBL sends nothing until a reset: not a lost connection
    await until(clock, () => false, 10_000)
    expect(s.isConnected).toBe(true)
    expectOk(s.realtime(REALTIME.reset))
  })

  it('a command without a reply times out with machine.connection', async () => {
    const { clock, s, t } = await scripted()
    const handshake = t.onWrite
    t.onWrite = (w) => (w === '$#\n' ? undefined : handshake?.(w))
    const r = await drive(clock, s.command('$#'), 60_000)
    expectErrCode(r, 'machine.connection')
    expect(clock.now()).toBeLessThan(20_000)
  })

  it('a lost ok (Idle with a line in flight) loses the connection instead of stalling', async () => {
    const { clock, s } = await scripted()
    const p = s.run({ lines: ['G0 X1'], sections: [] })
    expectErrCode(await drive(clock, p, 60_000), 'machine.connection')
    expect(clock.now()).toBeLessThan(15_000)
  })

  it('a dwell in flight is not a lost ok', async () => {
    const r = await connected(machine())
    expectOk(await drive(r.clock, start(r, ['G4 P20', 'G0 X1'])))
  })
})

describe('reports after cycle start', () => {
  /** Runs `act` right after the next `?` reached the machine, before its reply arrives. */
  const afterNextPoll = (r: Rig, act: () => void) => {
    r.io.afterWrite = (b) => {
      if (b.length !== 1 || b[0] !== REALTIME.status) return
      r.io.afterWrite = undefined
      act()
    }
  }

  it('a Hold:0 report requested before ~ does not put the run back to held', async () => {
    const r = await connected(machine())
    const p = start(r, ['G21 G91', 'G1 X100 F3000', 'G1 X-100'])
    await until(r.clock, () => r.emu.status().state === 'Run')
    expectOk(r.sender.hold())
    await until(r.clock, () => r.emu.status().state === 'Hold:0')
    afterNextPoll(r, () => expectOk(r.sender.resume()))
    expectOk(await drive(r.clock, p))
    expect(r.phases.map((x) => x.phase)).toEqual(['streaming', 'held', 'streaming', 'done'])
  })

  it('an M0 pause is counted once', async () => {
    const r = await connected(machine())
    const p = start(r, ['G0 Z5', '(Set spindle)', 'M0', 'G0 X1'])
    await until(r.clock, () => r.sender.phase === 'programPause')
    afterNextPoll(r, () => expectOk(r.sender.continueProgram()))
    expect(expectOk(await drive(r.clock, p))).toMatchObject({ pauses: 1 })
  })

  it('hold during a tool change waits for resume: continue is refused meanwhile', async () => {
    const { r, p } = await atToolChange()
    expectOk(r.sender.hold())
    expectErrCode(r.sender.continueProgram(), 'run.state')
    expectOk(r.sender.resume())
    expectOk(r.sender.continueProgram())
    expectOk(await drive(r.clock, p))
  })
})

describe('continue at a tool change', () => {
  it('is refused during a jog or with a command in flight', async () => {
    const { r, p } = await atToolChange()
    expectOk(await drive(r.clock, r.sender.command('$J=G21 G91 X20 F600')))
    // the jog's ok came; the last report may still say Idle
    expectErrCode(r.sender.continueProgram(), 'run.state')
    await until(r.clock, () => r.emu.status().state === 'Idle')
    await until(r.clock, () => r.sender.status?.state === 'Idle', 1000)
    await until(r.clock, () => false, 500)
    const g10 = r.sender.command('G10 L20 P1 Z0')
    expectErrCode(r.sender.continueProgram(), 'run.state')
    expectOk(await drive(r.clock, g10))
    await until(r.clock, () => false, 500)
    expectOk(r.sender.continueProgram())
    expectOk(await drive(r.clock, p))
    expect(r.io.received.filter((l) => l.startsWith('error'))).toEqual([])
  })

  it('keeps the RX budget: never more than 128 bytes outstanding', async () => {
    const r = await connected(machine())
    const long = `(${'x'.repeat(60)})`
    const lines = ['G21 G90', ...Array.from({ length: 6 }, () => long), ...TOOL_CHANGE.slice(1)]
    const p = start(r, lines)
    await until(r.clock, () => r.sender.phase === 'toolChange')
    // two 57-byte commands fit together (114 bytes); the marker must wait for them
    const g10 = `G10 L20 P1 Z0 (${'y'.repeat(40)})`
    void r.sender.command(g10)
    void r.sender.command(g10)
    r.sender.continueProgram()
    await until(r.clock, () => false, 1000)
    if (r.sender.phase === 'toolChange') expectOk(r.sender.continueProgram())
    expectOk(await drive(r.clock, p))
    expect(r.io.maxInflight).toBeLessThanOrEqual(RX_BUFFER_SIZE)
  })
})

describe('work coordinate offset', () => {
  it('is taken from WCO reports, not seeded with G54 (G92 and TLO add to it)', async () => {
    let n = 0
    const clock = new VirtualClock()
    const t = new ScriptedTransport()
    answerHandshake(t)
    const handshake = t.onWrite
    t.onWrite = (w) => {
      if (w === '$#\n') t.reply('[G54:-10.000,0.000,0.000]\r\n[G92:5.000,0.000,0.000]\r\nok\r\n')
      else if (w === '?')
        t.reply(
          n++ < 5
            ? '<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n'
            : '<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:-5.000,0.000,0.000>\r\n',
        )
      else handshake?.(w)
    }
    const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
    const c = s.connect()
    t.reply("\r\nGrbl 1.1h ['$' for help]\r\n")
    const info = expectOk(await drive(clock, c))
    expect(info.workZero).toEqual([-10, 0, 0])
    expect(s.status?.wpos).toEqual([5, 0, 0])
  })
})
