// A real-length homing cycle (`$H`, 40 s) on scripted controllers that answer `?` during the cycle
// the way GRBL 1.1 and its forks do (DF87, first real-machine test): queued and answered once at
// the end (GRBL 1.1h/f), never answered (a fork that drops it), answered `Idle` (a fork that does
// not report `Home`), answered `Home` (grblHAL). Homing must never be a lost connection, the state
// is `Home` while `$H` is outstanding, and positions come from the first report after it.
// Spec: docs/modes/run-machine.md#homing-on-a-real-controller, docs/modes/run.md#5-watchdogs
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { clockTimers, VirtualClock } from '../clock'
import { GrblSender, homingTimeoutMs, type SenderEvent } from './sender'
import { connected, drive, machine, ScriptedTransport, until } from './sender.fixture'

type DuringHoming = 'queue' | 'drop' | 'idle' | 'home'

const SETTINGS = [
  '$10=1',
  '$13=0',
  '$22=1',
  '$24=100',
  '$25=500',
  '$26=250',
  '$27=3',
  '$130=300',
  '$131=200',
  '$132=80',
]
const BEFORE = '<Idle|MPos:-150.000,-100.000,-40.000|FS:0,0|WCO:0.000,0.000,0.000>'
const AFTER = '<Idle|MPos:-3.000,-3.000,-3.000|FS:0,0>'
const HOMING_MS = 40_000

/**
 * A GRBL controller whose `$H` takes `homingMs` (clock time) and answers `?` during the cycle as
 * `during` says; `ok: false` never acknowledges `$H` (a hung cycle).
 */
async function controller(during: DuringHoming, opts: { ok?: boolean; settings?: string[] } = {}) {
  const clock = new VirtualClock()
  const t = new ScriptedTransport()
  let homing = false
  let queued = false
  let homed = false
  const settings = opts.settings ?? SETTINGS
  t.onWrite = (w) => {
    if (w === '$I\n') t.reply('[VER:1.1f.20250929:]\r\n[OPT:V,15,128]\r\nok\r\n')
    else if (w === '$$\n') t.reply(`${settings.join('\r\n')}\r\nok\r\n`)
    else if (w === '$#\n') t.reply('[G54:0.000,0.000,0.000]\r\n[G92:0.000,0.000,0.000]\r\nok\r\n')
    else if (w === '$G\n') t.reply('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\nok\r\n')
    else if (w === '$H\n') {
      homing = true
      if (opts.ok === false) return
      clock.schedule(clock.now() + HOMING_MS, () => {
        homing = false
        homed = true
        // GRBL 1.1 `mc_homing_cycle`: the `?` that came in is answered (still `Home`), then `ok`
        if (queued) t.reply('<Home|MPos:-3.000,-3.000,-3.000|FS:0,0>\r\n')
        queued = false
        t.reply('ok\r\n')
      })
    } else if (w === '?') {
      if (!homing) t.reply(`${homed ? AFTER : BEFORE}\r\n`)
      else if (during === 'queue') queued = true
      else if (during === 'idle') t.reply(`${BEFORE}\r\n`)
      else if (during === 'home') t.reply('<Home|MPos:-100.000,-60.000,-3.000|FS:500,0>\r\n')
      // 'drop': never answered
    }
  }
  const s = new GrblSender(t, clock, { timers: clockTimers(clock) })
  const events: SenderEvent[] = []
  s.onEvent((e) => events.push(e))
  const states: string[] = []
  s.onStatus((st) => states.push(st.state))
  const c = s.connect()
  t.reply("\r\nGrbl 1.1f ['$' for help]\r\n")
  expectOk(await drive(clock, c))
  return { clock, t, s, events, states }
}

describe('a real-length homing cycle (DF87)', () => {
  for (const during of ['queue', 'drop', 'idle', 'home'] as const) {
    it(`homes for 40 s without a lost connection; ? during $H: ${during}`, async () => {
      const r = await controller(during)
      const p = r.s.command('$H')
      // the state is Home as soon as $H is out, whatever the controller answers meanwhile
      await until(r.clock, () => r.clock.now() > 1000)
      expect(r.s.status?.state).toBe('Home')
      await until(r.clock, () => r.clock.now() > HOMING_MS - 1000)
      expect(r.s.status?.state.startsWith('Home')).toBe(true)
      expect(r.s.isConnected).toBe(true)
      expectOk(await drive(r.clock, p))
      // a report requested after the ok follows at the next poll: Idle at the homed position
      expect(
        await until(r.clock, () => r.s.status?.state === 'Idle' && r.s.status.mpos[0] === -3, 1000),
      ).toBe(true)
      expect(r.s.status?.mpos).toEqual([-3, -3, -3])
      // and polling goes on (no watchdog loss seconds later)
      await until(r.clock, () => false, 10_000)
      expect(r.events.filter((e) => e.kind === 'connectionLost')).toEqual([])
      expect(r.s.isConnected).toBe(true)
      const fresh = await drive(r.clock, r.s.freshStatus())
      expect(fresh?.state).toBe('Idle')
    })
  }

  it('the state shows Home to status listeners at once ($H booked)', async () => {
    const r = await controller('drop')
    const before = r.states.length
    void r.s.command('$H')
    await until(r.clock, () => r.states.length > before, 100)
    expect(r.states.at(-1)).toBe('Home')
  })

  it('a hung homing cycle times out after the travel-based limit, not before', async () => {
    const r = await controller('drop', { ok: false })
    const limit = homingTimeoutMs(new Map([...SETTINGS.map(parse)]))
    expect(limit).toBeGreaterThan(HOMING_MS)
    expect(limit).toBeLessThan(600_000)
    const p = r.s.command('$H')
    let settled = false
    void p.then(() => (settled = true))
    await until(r.clock, () => r.clock.now() > limit - 1000)
    expect(settled).toBe(false)
    expect(r.s.isConnected).toBe(true)
    expectErrCode(await drive(r.clock, p), 'machine.connection')
    expect(r.clock.now()).toBeLessThan(limit + 2000)
    expect(r.events).toContainEqual({ kind: 'connectionLost', reason: 'no reply to $H' })
  })

  it('without homing settings the $H limit is 10 min', () => {
    expect(homingTimeoutMs(new Map())).toBe(600_000)
    expect(homingTimeoutMs(new Map([[130, 300]]))).toBe(600_000)
  })
})

describe('an unexpected controller reset (DF87)', () => {
  it('fails the command in flight with machine.reset, not machine.connection', async () => {
    const r = await controller('queue')
    // a `$#` whose reply never comes: the controller restarts instead
    r.t.onWrite = ((w0) => (w: string) => (w === '$#\n' ? undefined : w0?.(w)))(r.t.onWrite)
    const p = r.s.command('$#')
    await until(r.clock, () => false, 10)
    r.t.reply("\r\nGrbl 1.1f ['$' for help]\r\n")
    const e = expectErrCode(await drive(r.clock, p), 'machine.reset')
    expect(e.message).toContain('restarted')
    // the next report says Idle: GRBL kept the position (a soft reset while idle)
    await until(r.clock, () => r.events.some((x) => x.kind === 'reset'))
    expect(r.events).toContainEqual({ kind: 'reset', expected: false, positionLost: false })
    expect(r.s.isConnected).toBe(true)
  })

  it('a banner followed by Alarm: position lost (DF87 follow-up)', async () => {
    const r = await controller('queue')
    const w0 = r.t.onWrite
    r.t.onWrite = (w: string) =>
      w === '?' ? r.t.reply('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\n') : w0?.(w)
    r.t.reply("\r\nGrbl 1.1f ['$' for help]\r\n[MSG:'$H'|'$X' to unlock]\r\n")
    await until(r.clock, () => r.events.some((x) => x.kind === 'reset'))
    expect(r.events).toContainEqual({ kind: 'reset', expected: false, positionLost: true })
  })

  it('a banner with no report after it: position lost', async () => {
    const r = await controller('queue')
    const w0 = r.t.onWrite
    r.t.onWrite = (w: string) => (w === '?' ? undefined : w0?.(w))
    r.t.reply("\r\nGrbl 1.1f ['$' for help]\r\n")
    await until(r.clock, () => r.events.some((x) => x.kind === 'reset'), 5000)
    expect(r.events).toContainEqual({ kind: 'reset', expected: false, positionLost: true })
  })

  it('commands wait while the banner is checked, then go out', async () => {
    const r = await controller('queue')
    r.t.reply("\r\nGrbl 1.1f ['$' for help]\r\n")
    await until(r.clock, () => false, 0)
    const p = r.s.command('$#')
    expectOk(await drive(r.clock, p))
    expect(r.events).toContainEqual({ kind: 'reset', expected: false, positionLost: false })
  })
})

function parse(line: string): [number, number] {
  const m = /^\$(\d+)=(.*)$/.exec(line)
  return [Number(m?.[1]), Number(m?.[2])]
}

describe('positions after homing for every $10 and $13 (DF87)', () => {
  for (const mask of [0, 1, 2, 3])
    for (const inch of [0, 1])
      it(`$10=${mask} $13=${inch}: MPos and WPos from the first report after $H`, async () => {
        const r = await connected(
          machine({
            homing: true,
            silentHoming: true,
            position: [-150, -100, -40],
            settings: { 10: mask, 13: inch },
          }),
        )
        expectOk(await drive(r.clock, r.sender.command('$H')))
        expectOk(await drive(r.clock, r.sender.command('G21 G10 L2 P1 X-200 Y-150 Z-30')))
        expectOk(await drive(r.clock, r.sender.readWorkZero()))
        const s = await drive(r.clock, r.sender.freshStatus())
        const emu = r.emu.status()
        expect(s?.state).toBe('Idle')
        for (let i = 0; i < 3; i++) {
          expect(s?.mpos[i]).toBeCloseTo(emu.mpos[i]!, 2)
          expect(s?.wco[i]).toBeCloseTo(emu.wco[i]!, 2)
          expect(s?.wpos[i]).toBeCloseTo(emu.mpos[i]! - emu.wco[i]!, 2)
        }
        expect(s?.wco[0]).toBeCloseTo(-200, 2)
      })
})
