// The machine host on a serial target, over loopback ports (a GRBL emulator behind a USB-like byte
// stream) with fake wall timers. Spec: docs/modes/run-machine.md#testing, docs/modes/run.md#safety
import { describe, expect, it } from 'vitest'
import { fromWire, type AppResult } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { parseWith } from '../../../shared/parse'
import { FakeTimers } from '../clock.fixture'
import { loopbackSerialPorts, type LoopbackOptions } from '../grbl/loopback.fixture'
import { runMachineHost } from './host'
import { HostMessage, PROTOCOL_VERSION, type ConnectedInfo } from './protocol'

const PATH = '/dev/cu.usbmodem1101'
const FAST = { 110: 6000, 111: 6000, 112: 6000, 120: 500, 121: 500, 122: 500 }

function harness(opts: LoopbackOptions = {}) {
  const w = new FakeTimers()
  const ports = loopbackSerialPorts(w, { ...opts, emulator: { settings: FAST, ...opts.emulator } })
  const out: HostMessage[] = []
  let toHost: (m: unknown) => void = () => {}
  runMachineHost(
    {
      post: (m) => out.push(expectOk(parseWith(HostMessage, structuredClone(m), 'test'))),
      onMessage: (l) => (toHost = l),
    },
    { timers: w, proc: 'worker', serial: ports },
  )
  toHost({ type: 'init', protocol: PROTOCOL_VERSION, logLevel: 'warn' })
  let seq = 0
  const pump = async (done: () => boolean, maxMs = 600_000) => {
    for (let t = 0; t <= maxMs; t += 10) {
      await new Promise((r) => setImmediate(r))
      if (done()) return true
      w.advance(10)
    }
    return false
  }
  const request = async (m: Record<string, unknown>): Promise<AppResult<unknown>> => {
    const requestId = `q${++seq}`
    toHost(structuredClone({ ...m, requestId }))
    const found = () => out.find((x) => x.type === 'reply' && x.requestId === requestId)
    expect(await pump(() => found() !== undefined)).toBe(true)
    const r = found()
    if (r?.type !== 'reply') throw new Error('no reply')
    return fromWire(r.result)
  }
  const connect = (path = PATH) =>
    request({
      type: 'connect',
      target: { kind: 'serial', path, baud: 115_200, machineKey: 'k' },
    })
  const of = <T extends HostMessage['type']>(type: T) =>
    out.filter((m): m is Extract<HostMessage, { type: T }> => m.type === type)
  return { w, out, ports, pump, request, connect, of }
}

describe('machine host: serial target (loopback)', { timeout: 30_000 }, () => {
  it('lists ports USB first', async () => {
    const h = harness()
    const ports = expectOk(await h.request({ type: 'listPorts' })) as { path: string }[]
    expect(ports.map((p) => p.path)).toEqual([PATH, '/dev/tty.Bluetooth-Incoming-Port'])
  })

  it('handshakes on the banner, reads $$, starts unhomed and real time', async () => {
    const h = harness({ bannerDelayMs: 1500 })
    const info = expectOk(await h.connect()) as ConnectedInfo
    expect(info).toMatchObject({ target: 'serial', port: { path: PATH, baud: 115_200 } })
    expect(info.homed).toBe(false)
    expect(info.settings['22']).toBe(1)
    expect(info.settings['110']).toBe(6000)
    // the time scale is the virtual machine's only
    const r = await h.request({ type: 'timeScale', scale: 'max' })
    expectErrCode(r, 'run.state')
    expect(r.unwrapErr().issues.map((i) => i.rule)).toContain('virtualOnly')
  })

  it('a board that does not reset on open answers after one 0x18', async () => {
    const h = harness({ silentUntilReset: true })
    expectOk(await h.connect())
    expect(h.ports.opened[0]!.written[0]).toBe(0x18)
  })

  it('refuses an unknown port and a busy one; nothing stays open', async () => {
    expectErrCode(await harness().connect('/dev/nope'), 'machine.connection')
    const h = harness({ openError: 'Resource busy' })
    const r = await h.connect()
    expectErrCode(r, 'machine.connection')
    expect(r.unwrapErr().message).toContain('Resource busy')
    // the host is free for another attempt
    expectErrCode(await h.connect(), 'machine.connection')
  })

  it('homes although GRBL is silent during $H (no watchdog loss)', async () => {
    const h = harness()
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    expect(h.of('event').filter((e) => e.kind === 'connectionLost')).toEqual([])
    expect(h.of('status').at(-1)?.status).toMatchObject({ state: 'Idle', homed: true })
  })

  for (const silentHoming of [true, 'drop'] as const)
    it(`a real-length silent homing (about 1 min): Homing, then homed with the position (DF87, ${String(silentHoming)})`, async () => {
      // GRBL defaults for the homing rates, from the middle of the travel: ~1 min with no report
      const h = harness({
        emulator: {
          settings: { ...FAST, 24: 25, 25: 200, 27: 3 },
          position: [-150, -100, -40],
          silentHoming,
        },
      })
      expectOk(await h.connect())
      const t0 = h.w.now()
      const statuses = () => h.of('status').map((m) => m.status)
      const home = h.request({ type: 'machine', action: { kind: 'home' } })
      // the badge's state while $H is out: Home, not the Idle of the last report
      expect(await h.pump(() => statuses().at(-1)?.state === 'Home')).toBe(true)
      expect(statuses().at(-1)?.homed).toBe(false)
      expectOk(await home)
      expect(h.w.now() - t0).toBeGreaterThan(40_000)
      expect(h.of('event').filter((e) => e.kind === 'connectionLost')).toEqual([])
      const last = statuses().at(-1)!
      expect(last).toMatchObject({ state: 'Idle', homed: true })
      expect(last.mpos).toEqual([-3, -3, -3])
      // still connected and polling seconds later
      await h.pump(() => false, 5000)
      expect(h.of('event').filter((e) => e.kind === 'connectionLost')).toEqual([])
      expectOk(
        await h.request({ type: 'machine', action: { kind: 'jog', by: [-1, 0, 0], feed: 500 } }),
      )
    })

  it('a controller that resets on its own while idle keeps homed: GRBL kept the position (M2, DF87 follow-up)', async () => {
    const h = harness()
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    expect(h.of('status').at(-1)?.status.homed).toBe(true)
    // a reset DFYOM did not send, while Idle: the banner, then Idle
    h.ports.opened[0]!.emulator.receive(Uint8Array.of(0x18))
    expect(
      await h.pump(() =>
        h
          .of('event')
          .some(
            (e) =>
              e.kind === 'reset' &&
              e.data['expected'] === false &&
              e.data['positionLost'] === false,
          ),
      ),
    ).toBe(true)
    expect(h.of('status').at(-1)?.status.homed).toBe(true)
  })

  it('a controller that resets on its own during motion is no longer homed (M2)', async () => {
    const h = harness()
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    expectOk(
      await h.request({
        type: 'machine',
        action: { kind: 'jog', by: [-1, 0, 0], feed: 500, continuous: true },
      }),
    )
    const emu = h.ports.opened[0]!.emulator
    expect(await h.pump(() => emu.status().state === 'Jog')).toBe(true)
    // ALARM:3, Alarm, then the banner
    emu.receive(Uint8Array.of(0x18))
    expect(
      await h.pump(
        () =>
          h.of('event').some((e) => e.kind === 'reset' && e.data['positionLost'] === true) &&
          h.of('status').at(-1)?.status.homed === false,
      ),
    ).toBe(true)
  })

  it('a fork that prints its banner when $H ends: homed, with the position (DF87 follow-up)', async () => {
    const h = harness({ emulator: { bannerAfterHoming: true, settings: { ...FAST, 27: 3 } } })
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    expect(await h.pump(() => h.of('event').some((e) => e.kind === 'reset'))).toBe(true)
    expect(h.of('event').find((e) => e.kind === 'reset')?.data).toEqual({
      expected: false,
      positionLost: false,
    })
    await h.pump(() => false, 500)
    const last = h.of('status').at(-1)!.status
    expect(last).toMatchObject({ state: 'Idle', homed: true })
    expect(last.mpos).toEqual([-3, -3, -3])
    expect(h.of('event').filter((e) => e.kind === 'connectionLost')).toEqual([])
    expectOk(
      await h.request({ type: 'machine', action: { kind: 'jog', by: [-1, 0, 0], feed: 500 } }),
    )
  })

  it('a banner after $H followed by Alarm: machine.reset, not homed (DF87 follow-up)', async () => {
    const h = harness({ emulator: { bannerAfterHoming: 'alarm' } })
    expectOk(await h.connect())
    const r = await h.request({ type: 'machine', action: { kind: 'home' } })
    expectErrCode(r, 'machine.reset')
    expect(h.of('event').find((e) => e.kind === 'reset')?.data).toEqual({
      expected: false,
      positionLost: true,
    })
    expect(await h.pump(() => h.of('status').at(-1)?.status.homed === false)).toBe(true)
  })

  it('a continuous jog goes to the travel edge until cancelled (M3)', async () => {
    const h = harness()
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    const port = h.ports.opened[0]!
    const jog = (by: number[]) =>
      h.request({ type: 'machine', action: { kind: 'jog', by, feed: 2000, continuous: true } })
    // one axis only
    const two = await jog([1, 1, 0])
    expectErrCode(two, 'input.malformed')
    expect(two.unwrapErr().issues[0]?.rule).toBe('oneAxis')
    // -X: to -travel ($130), an absolute machine move
    const before = port.written.length
    expectOk(await jog([-1, 0, 0]))
    const sent = String.fromCharCode(...port.written.slice(before))
    expect(sent).toMatch(/\$J=G21 G53 G90 X-\d+(\.\d+)? F2000/)
    const x0 = h.of('status').at(-1)!.status.mpos[0]
    expect(await h.pump(() => (h.of('status').at(-1)?.status.mpos[0] ?? 0) < x0 - 5)).toBe(true)
    expectOk(await h.request({ type: 'machine', action: { kind: 'jogCancel' } }))
    expect(await h.pump(() => h.of('status').at(-1)?.status.state === 'Idle')).toBe(true)
    // +X runs to 0, then +X again is at the edge
    expectOk(await jog([1, 0, 0]))
    expect(
      await h.pump(() => {
        const s = h.of('status').at(-1)?.status
        return s?.state === 'Idle' && Math.abs(s.mpos[0]) < 1e-3
      }),
    ).toBe(true)
    const edge = await jog([1, 0, 0])
    expectErrCode(edge, 'run.travel')
    expect(edge.unwrapErr().frames[0]?.data).toMatchObject({ axis: 'x', atEdge: true, max: 0 })
  })

  it('a pulled cable is a lost connection', async () => {
    const h = harness()
    expectOk(await h.connect())
    h.ports.opened[0]!.unplug()
    expect(await h.pump(() => h.of('event').some((e) => e.kind === 'connectionLost'))).toBe(true)
    const lost = h.of('event').find((e) => e.kind === 'connectionLost')
    expect(JSON.stringify(lost?.data)).toContain('device disconnected')
  })

  it('disconnect resets the controller (0x18) and closes the port', async () => {
    const h = harness()
    expectOk(await h.connect())
    const port = h.ports.opened[0]!
    const before = port.written.length
    expectOk(await h.request({ type: 'disconnect' }))
    expect(port.written.slice(before)).toContain(0x18)
    expect(port.isClosed).toBe(true)
  })
})

describe('machine host: probing and overrides (M4, M6)', { timeout: 30_000 }, () => {
  const probe = { kind: 'probeZ', plateThickness: 5, maxTravel: 25, feed: 300, retract: 2 }
  const sentText = (h: ReturnType<typeof harness>, from = 0) =>
    String.fromCharCode(...h.ports.opened[0]!.written.slice(from))

  it('probes Z: G38.2, G54 Z = contact − plate, retract, modal state back', async () => {
    const h = harness({ emulator: { probePlate: -10 } })
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    const before = h.ports.opened[0]!.written.length
    const r = expectOk(await h.request({ type: 'machine', action: probe })) as {
      workZero: number[]
      contact: number[]
    }
    expect(r.contact[2]).toBeCloseTo(-10, 3)
    expect(r.workZero[2]).toBeCloseTo(-15, 3)
    const sent = sentText(h, before)
    expect(sent).toMatch(/G21 G90 G38\.2 Z-26(\.0+)? F300/)
    expect(sent).toContain('G21 G10 L2 P1 Z-15')
    expect(sent).toContain('G21 G53 G0 Z-8')
    expect(sent).toContain('G21 G90 G0\n')
    const s = h.of('status').at(-1)!.status
    expect(s).toMatchObject({ state: 'Idle', homed: true })
    expect(s.mpos[2]).toBeCloseTo(-8, 3)
    expect(s.workZero[2]).toBeCloseTo(-15, 3)
  })

  it('a miss is ALARM:5 (homed kept); unlock puts the modal state back', async () => {
    const h = harness()
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    const r = await h.request({ type: 'machine', action: probe })
    expectErrCode(r, 'machine.alarm')
    expect(r.unwrapErr().frames[0]?.data).toMatchObject({ code: 5 })
    expect(h.of('status').at(-1)!.status).toMatchObject({ homed: true, alarm: { code: 5 } })
    // GRBL refuses gCode in Alarm: nothing else moves
    expectErrCode(
      await h.request({ type: 'machine', action: { kind: 'jog', by: [0, 0, 1], feed: 500 } }),
      'run.state',
    )
    const before = h.ports.opened[0]!.written.length
    expectOk(await h.request({ type: 'machine', action: { kind: 'unlock' } }))
    expect(sentText(h, before)).toMatch(/\$X\nG21 G90 G0\n/)
    expect(await h.pump(() => h.of('status').at(-1)?.status.alarm === undefined)).toBe(true)
  })

  it('the probe never targets below the travel', async () => {
    const h = harness({ emulator: { settings: { ...FAST, 132: 20 } } })
    expectOk(await h.connect())
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    const before = h.ports.opened[0]!.written.length
    // from Z −1 with 20 mm travel: at most 18.99 mm down, a miss without a soft-limit alarm
    const r = await h.request({ type: 'machine', action: probe })
    expect(r.unwrapErr().frames[0]?.data).toMatchObject({ code: 5 })
    expect(sentText(h, before)).toMatch(/G38\.2 Z-19\.99/)
  })

  it('overrides send one real-time byte and report Ov; a reset puts them at 100 %', async () => {
    const h = harness()
    expectOk(await h.connect())
    const port = h.ports.opened[0]!
    const ov = (which: string, action: string) =>
      h.request({ type: 'machine', action: { kind: 'override', which, action } })
    expect(expectOk(await ov('feed', '+10'))).toMatchObject({ overrides: { feed: 110 } })
    expect(port.written).toContain(0x91)
    expect(expectOk(await ov('rapid', '25'))).toMatchObject({ overrides: { rapid: 25 } })
    expect(expectOk(await ov('spindle', '-10'))).toMatchObject({
      overrides: { feed: 110, rapid: 25, spindle: 90 },
    })
    expectErrCode(await ov('rapid', '+10'), 'input.malformed')
    expectOk(await h.request({ type: 'machine', action: { kind: 'reset' } }))
    expect(await h.pump(() => h.of('status').at(-1)?.status.overrides?.feed === 100)).toBe(true)
    expect(h.of('status').at(-1)!.status.overrides).toEqual({
      feed: 100,
      rapid: 100,
      spindle: 100,
    })
  })
})
