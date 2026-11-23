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
