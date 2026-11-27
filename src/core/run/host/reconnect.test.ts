// Auto-reconnect (hardening DF129, RC4): port matching by path and USB serial number, the backoff
// and the 2-minute limit (fake timers), a port's arrival; and on the loopback port and the virtual
// machine: a connection lost mid-run comes back by itself with nothing sent but the handshake and
// reads, never at launch, after a user's disconnect, while idle or with the setting off.
// Spec: docs/modes/run-recovery.md#auto-reconnect, #implementation-rc4
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, Ok, type AppResult } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { systemTimerHost, type TimerHost } from '../clock'
import { FAST } from '../grbl/emulator.fixture'
import { loopbackSerialNumber, loopbackSerialPorts } from '../grbl/loopback.fixture'
import type { SerialPortInfo } from '../serial'
import type { RunStatus } from '../service'
import { MachineClient, SIMULATED_UNPLUG_MS } from './client'
import { inProcessHostFactory } from './in-process'
import { matchPort, RECONNECT_WINDOW_MS, Reconnector, type ReconnectProgress } from './reconnect'

const usb = (path: string, serialNumber?: string, extra: Partial<SerialPortInfo> = {}) => ({
  path,
  usb: true,
  vendorId: '2341',
  productId: '0043',
  ...(serialNumber === undefined ? {} : { serialNumber }),
  ...extra,
})

describe('matchPort', () => {
  const lost = {
    path: '/dev/cu.usbmodem1101',
    serialNumber: 'A1',
    vendorId: '2341',
    productId: '0043',
  }

  it('the same path, or the same serial number under a new path; never another device', () => {
    expect(matchPort([usb('/dev/cu.usbmodem1101', 'A1')], lost)).toBe('/dev/cu.usbmodem1101')
    // re-enumerated: the OS gave the device a new path
    expect(matchPort([usb('/dev/cu.usbmodem1201', 'A1')], lost)).toBe('/dev/cu.usbmodem1201')
    // another device took the path, ours is elsewhere
    expect(
      matchPort([usb('/dev/cu.usbmodem1101', 'B2'), usb('/dev/cu.usbmodem1301', 'A1')], lost),
    ).toBe('/dev/cu.usbmodem1301')
    expect(matchPort([usb('/dev/cu.usbmodem1101', 'B2')], lost)).toBeUndefined()
    // the same serial number on another VID:PID is another device
    expect(
      matchPort([usb('/dev/cu.usbmodem1201', 'A1', { vendorId: '1a86', productId: '7523' })], lost),
    ).toBeUndefined()
    expect(matchPort([usb('/dev/cu.usbmodem1201', 'B2')], lost)).toBeUndefined()
    expect(matchPort([], lost)).toBeUndefined()
  })

  it('without a serial number: the path only', () => {
    const bare = { path: '/dev/ttyUSB0' }
    expect(matchPort([usb('/dev/ttyUSB0')], bare)).toBe('/dev/ttyUSB0')
    expect(matchPort([usb('/dev/ttyUSB1', 'A1')], bare)).toBeUndefined()
    // the OS reports no serial number at the path: still the path
    expect(matchPort([usb('/dev/cu.usbmodem1101')], lost)).toBe('/dev/cu.usbmodem1101')
  })
})

describe('Reconnector (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const timers: TimerHost = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms)
      return () => clearTimeout(h)
    },
  }

  function setup(opts: {
    ok?: (n: number) => boolean
    ports?: () => SerialPortInfo[]
    serial?: boolean
  }) {
    const t0 = Date.now()
    const at: number[] = []
    const paths: (string | undefined)[] = []
    const changes: ReconnectProgress[] = []
    const r = new Reconnector({
      timers,
      attempt: (path) => {
        at.push(Date.now() - t0)
        paths.push(path)
        return Promise.resolve(
          opts.ok?.(at.length) === true
            ? Ok(undefined)
            : (fail('machine.connection', 'no port') as AppResult<unknown>),
        )
      },
      ...(opts.serial === false
        ? {}
        : {
            serial: {
              lost: { path: '/dev/cu.usbmodem1101', serialNumber: 'A1' },
              list: () => Promise.resolve(Ok(opts.ports?.() ?? [])),
            },
          }),
      onChange: (p) => changes.push(p),
    })
    return { r, at, paths, changes }
  }

  it('tries at once, then after 1, 2, 4 and 8 s, then every 10 s, and gives up after 2 minutes', async () => {
    // the port stays listed (the controller does not answer): no arrival, the backoff only
    const s = setup({ ports: () => [usb('/dev/cu.usbmodem1101', 'A1')] })
    s.r.start()
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS - 1)
    expect(s.at).toEqual([
      0, 1000, 3000, 7000, 15000, 25000, 35000, 45000, 55000, 65000, 75000, 85000, 95000, 105000,
      115000,
    ])
    expect(s.r.progress.phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(s.r.progress).toEqual({ phase: 'gaveUp', attempt: 15 })
    expect(s.r.active).toBe(false)
    // nothing after giving up
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.at).toHaveLength(15)
    expect(s.changes.at(-1)?.phase).toBe('gaveUp')
    // each attempt says so, then the wait for the next
    expect(s.changes.slice(0, 2)).toEqual([
      { phase: 'connecting', attempt: 1 },
      { phase: 'waiting', attempt: 1, nextInMs: 1000 },
    ])
  })

  it('a port that appears is tried at once; reconnected ends it', async () => {
    let listed = false
    const s = setup({
      ports: () => (listed ? [usb('/dev/cu.usbmodem1201', 'A1')] : []),
      ok: () => listed,
    })
    s.r.start()
    await vi.advanceTimersByTimeAsync(5000)
    // at 0 (nothing listed: no attempt reaches a port), then the backoff's 1 s and 3 s
    expect(s.paths).toEqual([])
    listed = true
    await vi.advanceTimersByTimeAsync(1000)
    // the scan saw it within a second, before the backoff's 7 s
    expect(s.at).toEqual([6000])
    expect(s.paths).toEqual(['/dev/cu.usbmodem1201'])
    expect(s.r.progress).toEqual({ phase: 'reconnected', attempt: 4 })
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS)
    expect(s.at).toHaveLength(1)
  })

  it('cancel stops trying at once', async () => {
    const s = setup({ serial: false })
    s.r.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.at).toEqual([0, 1000])
    expect(s.paths).toEqual([undefined, undefined])
    s.r.cancel()
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS)
    expect(s.at).toHaveLength(2)
  })
})

/** Timers fired by hand (the reconnect's backoff), each followed by real time for the attempt. */
class ManualTimers implements TimerHost {
  private t = 0
  private seq = 0
  private timers: { at: number; seq: number; fn: () => void }[] = []
  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, seq: this.seq++, fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      const next = this.timers
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (next === undefined) break
      this.timers = this.timers.filter((x) => x !== next)
      this.t = next.at
      next.fn()
      await new Promise((r) => setTimeout(r, 15))
    }
    this.t = end
  }
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return cond()
}

const clients: MachineClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

describe('auto-reconnect on the loopback port', { timeout: 60_000 }, () => {
  const PATH = '/dev/cu.usbmodem1101'
  const NEW_PATH = '/dev/cu.usbmodem1201'
  const program = {
    lines: ['G21 G91', 'M3 S1000', ...Array.from({ length: 200 }, () => 'G1 X-1 F600')],
    sections: [],
  }

  async function connected(opts: { enabled?: boolean; timers?: TimerHost } = {}) {
    const ports = loopbackSerialPorts(systemTimerHost, {
      emulator: { settings: { ...FAST } },
      timeScale: 'max',
    })
    const statuses: RunStatus[] = []
    const client = new MachineClient({
      factory: inProcessHostFactory({ timers: systemTimerHost, serial: ports }),
      logLevel: 'warn',
      reconnect: {
        ...(opts.enabled === undefined ? {} : { enabled: () => opts.enabled === true }),
        ...(opts.timers === undefined ? {} : { timers: opts.timers }),
      },
    })
    clients.push(client)
    client.onStatus((s) => statuses.push(s))
    expectOk(await client.connect({ kind: 'serial', path: PATH, baud: 115_200, machineKey: 'k' }))
    return { ports, client, statuses, port: ports.opened[0]! }
  }

  async function runThenUnplug(c: Awaited<ReturnType<typeof connected>>) {
    expectOk(await c.client.machine({ kind: 'home' }))
    c.port.setTimeScale(1)
    const started = expectOk(
      await c.client.startJob(
        'job-1',
        program,
        { progress: () => {}, phase: () => {} },
        { workZero: c.client.status().workZero, machineKey: 'k' },
      ),
    )
    expect(await waitFor(() => (c.client.status().job?.line ?? 0) > 5)).toBe(true)
    c.port.unplug()
    expectErrCode(await started.ended, 'machine.connection')
  }

  it('re-enumerated under a new path with the same serial number: reconnects, sends only the handshake and reads', async () => {
    const c = await connected()
    // the USB identity is in the record for matching
    await runThenUnplug(c)
    expect(c.client.runRecord()?.machine.usb).toEqual({
      serialNumber: loopbackSerialNumber(0),
      vendorId: '2341',
      productId: '0043',
    })
    expect(c.client.runRecord()).toMatchObject({ state: 'interrupted', reason: 'connectionLost' })
    expect(c.client.status().connection).toMatchObject({
      state: 'closed',
      lost: { target: 'serial' },
      reconnect: { phase: expect.stringMatching(/waiting|connecting/) },
    })
    c.port.replug({ afterMs: 1500, path: NEW_PATH })
    expect(
      await waitFor(() => c.client.status().connection.reconnect?.phase === 'reconnected'),
    ).toBe(true)
    const s = c.client.status()
    expect(s.connection).toMatchObject({ state: 'open', port: { path: NEW_PATH } })
    expect(s.connection.lost).toBeUndefined()
    // the controller restarted: locked, not homed; G54 kept
    expect(s.homed).toBe(false)
    expect(s.state).toMatch(/^Alarm/)
    const second = c.ports.opened[1]!
    expect(second.emulator).toBe(c.port.emulator)
    const mpos = second.emulator.status().mpos
    // nothing more is sent while it waits for the user
    await new Promise((r) => setTimeout(r, 1500))
    expect(second.emulator.status().mpos).toEqual(mpos)
    expect(second.emulator.status().state).toBe('Alarm')
    // the exact bytes: the handshake's reads and status polls, never $H, $X, a jog or a line
    const sent = String.fromCharCode(...second.written)
    expect(sent.replaceAll('?', '')).toBe('$I\n$$\n$#\n$G\n')
    expect(c.statuses.some((x) => x.connection.reconnect?.phase === 'waiting')).toBe(true)
    // the next run clears "Reconnected"; a disconnect too
    expectOk(await c.client.disconnect())
    expect(c.client.status().connection.reconnect).toBeUndefined()
  })

  it('gives up after 2 minutes when the port never comes back', async () => {
    const timers = new ManualTimers()
    const c = await connected({ timers })
    await runThenUnplug(c)
    await timers.advance(RECONNECT_WINDOW_MS - 1000)
    expect(c.client.status().connection.reconnect?.phase).toBe('waiting')
    await timers.advance(1000)
    expect(c.client.status().connection).toMatchObject({
      state: 'closed',
      lost: { target: 'serial' },
      reconnect: { phase: 'gaveUp' },
    })
    // the port was never there: no attempt opened anything
    expect(c.ports.opened).toHaveLength(1)
    // a manual connect clears it
    c.port.replug()
    expectOk(await c.client.connect({ kind: 'serial', path: PATH, baud: 115_200, machineKey: 'k' }))
    expect(c.client.status().connection.reconnect).toBeUndefined()
  })

  it('"Stop trying" ends it; the lost warning stays', async () => {
    const timers = new ManualTimers()
    const c = await connected({ timers })
    await runThenUnplug(c)
    c.client.cancelReconnect()
    c.port.replug()
    await timers.advance(RECONNECT_WINDOW_MS)
    expect(c.client.status().connection.reconnect).toBeUndefined()
    expect(c.client.status().connection).toMatchObject({
      state: 'closed',
      lost: { target: 'serial' },
    })
    expect(c.ports.opened).toHaveLength(1)
  })

  it('never at launch, after a user disconnect, after a loss while idle, or with the setting off', async () => {
    // launch: a connect that fails is not retried
    const timers = new ManualTimers()
    const ports = loopbackSerialPorts(systemTimerHost, { openError: 'Resource busy' })
    const launch = new MachineClient({
      factory: inProcessHostFactory({ timers: systemTimerHost, serial: ports }),
      logLevel: 'error',
      reconnect: { timers },
    })
    clients.push(launch)
    expectErrCode(
      await launch.connect({ kind: 'serial', path: PATH, baud: 115_200, machineKey: 'k' }),
      'machine.connection',
    )
    await timers.advance(10_000)
    expect(launch.status().connection.reconnect).toBeUndefined()

    // a user disconnect
    const d = await connected({ timers })
    expectOk(await d.client.disconnect())
    await timers.advance(10_000)
    expect(d.client.status().connection.reconnect).toBeUndefined()
    expect(d.ports.opened).toHaveLength(1)

    // lost while idle (no run)
    const idle = await connected({ timers })
    idle.port.unplug()
    expect(await waitFor(() => idle.client.status().connection.state === 'closed')).toBe(true)
    idle.port.replug()
    await timers.advance(10_000)
    expect(idle.client.status().connection.reconnect).toBeUndefined()
    expect(idle.ports.opened).toHaveLength(1)

    // the setting off
    const off = await connected({ timers, enabled: false })
    await runThenUnplug(off)
    off.port.replug()
    await timers.advance(10_000)
    expect(off.client.status().connection.reconnect).toBeUndefined()
    expect(off.ports.opened).toHaveLength(1)
  })
})

describe('"Simulate a lost connection" on the virtual machine', { timeout: 60_000 }, () => {
  it('lost mid-run, reconnects by itself: Alarm, not homed, G54 kept, the record interrupted', async () => {
    const client = new MachineClient({
      factory: inProcessHostFactory({ timers: systemTimerHost }),
      logLevel: 'warn',
    })
    clients.push(client)
    const settings = Object.fromEntries(Object.entries(FAST).map(([k, v]) => [k, v]))
    expectOk(
      await client.connect({
        kind: 'virtual',
        settings,
        homing: true,
        timeScale: 1,
        machineKey: 'k',
        position: [-500, -500, -500],
        prepare: { workZero: [-400, -300, -50] },
      }),
    )
    expect(client.status().homed).toBe(true)
    // not without a run, not on another target
    expectErrCode(await client.simulateConnectionLoss(), 'run.state')
    const program = {
      lines: ['G21 G91', ...Array.from({ length: 100 }, () => 'G1 X-1 F600')],
      sections: [],
    }
    const started = expectOk(
      await client.startJob(
        'job-1',
        program,
        { progress: () => {}, phase: () => {} },
        { workZero: client.status().workZero, machineKey: 'k' },
      ),
    )
    expect(await waitFor(() => (client.status().job?.line ?? 0) > 3)).toBe(true)
    const before = client.status().mpos
    const lost = Date.now()
    expectOk(await client.simulateConnectionLoss())
    expectErrCode(await started.ended, 'machine.connection')
    expect(client.runRecord()).toMatchObject({ state: 'interrupted', reason: 'connectionLost' })
    expect(client.status().connection).toMatchObject({
      state: 'closed',
      lost: { target: 'virtual' },
      reconnect: { phase: expect.stringMatching(/waiting|connecting/) },
    })
    expect(
      await waitFor(() => client.status().connection.reconnect?.phase === 'reconnected', 30_000),
    ).toBe(true)
    // the simulated cable stayed out for its time: at least one attempt failed first
    expect(Date.now() - lost).toBeGreaterThanOrEqual(SIMULATED_UNPLUG_MS - 50)
    const s = client.status()
    expect(s.connection.reconnect?.attempt).toBeGreaterThan(1)
    expect(s.connection).toMatchObject({ state: 'open', target: 'virtual' })
    expect(s.homed).toBe(false)
    expect(s.state).toMatch(/^Alarm/)
    expect(s.workZero).toEqual([-400, -300, -50])
    // where it stopped (it ran on a little until the host saw the cable go): not moved since
    expect(s.mpos[0]).toBeLessThanOrEqual(before[0] + 1e-6)
  })
})

describe('the recovery record on the virtual machine (DF129 RC5)', { timeout: 60_000 }, () => {
  const connect = async () => {
    const client = new MachineClient({
      factory: inProcessHostFactory({ timers: systemTimerHost }),
      logLevel: 'warn',
    })
    clients.push(client)
    const settings = Object.fromEntries(Object.entries(FAST).map(([k, v]) => [k, v]))
    expectOk(
      await client.connect({
        kind: 'virtual',
        settings,
        homing: true,
        timeScale: 1,
        machineKey: 'k',
        position: [-500, -500, -500],
        prepare: { workZero: [-400, -300, -50] },
      }),
    )
    return client
  }
  // two passes: each a rapid over, a plunge, then cuts
  const program = {
    lines: [
      'G21 G90',
      'G0 Z5',
      'G0 X0 Y0',
      'G1 Z-1 F300',
      ...Array.from({ length: 60 }, (_, i) => `G1 X${-(i + 1)} F600`),
      'G0 Z5',
      'G0 X0 Y-5',
      'G1 Z-1 F300',
      ...Array.from({ length: 60 }, (_, i) => `G1 X${-(i + 1)} F600`),
    ],
    sections: [],
  }
  const about = { file: { name: 'a.nc', path: '/a.nc' }, origin: { programHash: 'h' } }

  it('an interrupted file run: lastRun.interruption with the suggestion; Reconnect now; Dismiss', async () => {
    const client = await connect()
    const started = expectOk(
      await client.startJob(
        'job-1',
        program,
        { progress: () => {}, phase: () => {} },
        { workZero: client.status().workZero, machineKey: 'k' },
        about,
      ),
    )
    expect(await waitFor(() => (client.status().job?.line ?? 0) > 70)).toBe(true)
    expectOk(await client.simulateConnectionLoss())
    expectErrCode(await started.ended, 'machine.connection')
    const last = client.status().lastRun
    expect(last).toMatchObject({
      jobId: 'job-1',
      file: { path: '/a.nc' },
      outcome: 'failed',
      interruption: { reason: 'connectionLost', programHash: 'h', lines: program.lines.length },
    })
    const i = last!.interruption!
    expect(i.executing).toBeGreaterThan(0)
    expect(i.executing).toBeLessThanOrEqual(i.acknowledged)
    expect(i.acknowledged).toBeLessThanOrEqual(i.sent)
    expect(i.lastReport?.wpos).toBeDefined()
    // the latest pass start at or before the executing line
    expect(i.suggestion?.line).toBe(i.executing >= 67 ? 67 : 4)
    expect(i.safest?.line).toBe(4)
    // "Reconnect now" while waiting: an attempt at once (the simulated cable is still out)
    expect(await waitFor(() => client.status().connection.reconnect?.phase === 'waiting')).toBe(
      true,
    )
    const attempts = client.status().connection.reconnect?.attempt ?? 0
    expectOk(client.reconnectNow())
    expect(
      await waitFor(() => (client.status().connection.reconnect?.attempt ?? 0) > attempts),
    ).toBe(true)
    expect(
      await waitFor(() => client.status().connection.reconnect?.phase === 'reconnected', 30_000),
    ).toBe(true)
    // the record outlives the reconnect, until dismissed
    expect(client.status().lastRun?.interruption).toBeDefined()
    client.dismissInterruption()
    expect(client.status().lastRun).toBeUndefined()
  })

  it('"The machine lost power" after a Stop: interrupted, the operation start, not homed', async () => {
    const client = await connect()
    // nothing ended yet
    expectErrCode(await client.markMachinePowerLost(), 'run.state')
    const started = expectOk(
      await client.startJob(
        'job-2',
        program,
        { progress: () => {}, phase: () => {} },
        { workZero: client.status().workZero, machineKey: 'k' },
        about,
      ),
    )
    expect(await waitFor(() => (client.status().job?.line ?? 0) > 70)).toBe(true)
    expectOk(await client.controlJob('job-2', 'stop'))
    expectErrCode(await started.ended, 'op.aborted')
    // a stopped file run keeps no record (DF93)…
    expect(client.status().lastRun).toBeUndefined()
    expect(await waitFor(() => client.status().state === 'Idle')).toBe(true)
    expect(client.status().homed).toBe(true)
    // …until the operator says the machine lost power
    expectOk(await client.markMachinePowerLost())
    expect(client.status().lastRun?.interruption).toMatchObject({
      reason: 'machinePowerLost',
      // no operation starts in this program: its first pass is the operation's start
      suggestion: { line: 4 },
    })
    expect(client.runRecord()).toMatchObject({ state: 'interrupted', reason: 'machinePowerLost' })
    expect(await waitFor(() => !client.status().homed)).toBe(true)
  })
})
