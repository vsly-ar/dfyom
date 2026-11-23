// The machine host over in-memory endpoints with fake wall timers, and the protocol schemas.
// Spec: docs/modes/run-v0.1.md#machine-host-and-protocol, #testing (Host and protocol)
import { describe, expect, it } from 'vitest'
import { fromWire, type AppResult } from '../../../shared/result'
import { expectErrCode, expectOk } from '../../../shared/testing/result'
import { parseWith } from '../../../shared/parse'
import { FakeTimers } from '../clock.fixture'
import { FAST } from '../grbl/emulator.fixture'
import { runMachineHost } from './host'
import { HostMessage, MainMessage, PROTOCOL_VERSION, type ConnectedInfo } from './protocol'

const KEY = 'machine-key-1'
const SETTINGS = Object.fromEntries(Object.entries(FAST).map(([k, v]) => [k, v]))

function harness(throttleMs = 100) {
  const w = new FakeTimers()
  const out: HostMessage[] = []
  let toHost: (m: unknown) => void = () => {}
  let disconnected = 0
  runMachineHost(
    {
      post: (m) => out.push(expectOk(parseWith(HostMessage, structuredClone(m), 'test'))),
      onMessage: (l) => (toHost = l),
    },
    { timers: w, proc: 'worker', throttleMs, onDisconnected: () => disconnected++ },
  )
  let seq = 0
  const send = (m: Record<string, unknown>) => toHost(structuredClone(m))
  /** Runs fake wall time in 10 ms steps (letting promises settle) until `done()`. */
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
    // a job start checks what main checked: the G54 it exported with, the machine copy, the target
    const last = out.filter((x) => x.type === 'status').at(-1)
    const expected =
      m['type'] === 'jobStart' && m['expect'] === undefined
        ? {
            expect: {
              workZero: last?.type === 'status' ? last.status.workZero : [0, 0, 0],
              machineKey: KEY,
              target: 'virtual',
            },
          }
        : {}
    send({ ...m, ...expected, requestId })
    const found = () => out.find((x) => x.type === 'reply' && x.requestId === requestId)
    expect(await pump(() => found() !== undefined)).toBe(true)
    const r = found()
    if (r?.type !== 'reply') throw new Error('no reply')
    return fromWire(r.result)
  }
  const of = <T extends HostMessage['type']>(type: T) =>
    out.filter((m): m is Extract<HostMessage, { type: T }> => m.type === type)
  return { w, out, send, pump, request, of, disconnected: () => disconnected }
}

type Harness = ReturnType<typeof harness>

async function connectedHost(
  h: Harness,
  target: Record<string, unknown> = {},
): Promise<ConnectedInfo> {
  h.send({ type: 'init', protocol: PROTOCOL_VERSION, logLevel: 'info' })
  const r = await h.request({
    type: 'connect',
    target: {
      kind: 'virtual',
      settings: SETTINGS,
      homing: true,
      timeScale: 'max',
      machineKey: KEY,
      ...target,
    },
  })
  return expectOk(r) as ConnectedInfo
}

const lastStatus = (h: Harness) => h.of('status').at(-1)?.status

describe('protocol schemas', () => {
  it('accepts each message and rejects malformed ones', () => {
    const ok = [
      { type: 'init', protocol: 1, logLevel: 'info' },
      {
        type: 'connect',
        requestId: 'a',
        target: {
          kind: 'virtual',
          settings: { '110': 5000 },
          homing: true,
          timeScale: 1,
          machineKey: 'k',
        },
      },
      { type: 'disconnect', requestId: 'a' },
      { type: 'machine', requestId: 'a', action: { kind: 'jog', by: [1, 0, 0], feed: 500 } },
      { type: 'machine', requestId: 'a', action: { kind: 'setWorkZero', axes: ['z'] } },
      {
        type: 'jobStart',
        requestId: 'a',
        jobId: 'j',
        program: { lines: ['G0 X1'], sections: [] },
        expect: { workZero: [0, 0, 0], machineKey: 'k', target: 'virtual' },
      },
      {
        type: 'jobControl',
        requestId: 'a',
        jobId: 'j',
        action: 'continue',
        expect: { toolChange: 2 },
      },
      { type: 'timeScale', requestId: 'a', scale: 'max' },
    ]
    for (const m of ok) expectOk(parseWith(MainMessage, m, 'test'))
    const bad = [
      { type: 'timeScale', requestId: 'a', scale: 101 },
      { type: 'timeScale', requestId: 'a', scale: 0.5 },
      { type: 'machine', requestId: 'a', action: { kind: 'jog', by: [1, 0], feed: 500 } },
      { type: 'machine', requestId: 'a', action: { kind: 'jog', by: [1, 0, 0], feed: 0 } },
      { type: 'machine', requestId: 'a', action: { kind: 'setWorkZero', axes: [] } },
      { type: 'machine', requestId: 'a', action: { kind: 'raw', line: '$H' } },
      { type: 'jobControl', requestId: 'a', jobId: 'j', action: 'pause' },
      {
        type: 'connect',
        requestId: 'a',
        target: { kind: 'serial', settings: {}, homing: true, timeScale: 1 },
      },
      { type: 'connect', target: { kind: 'virtual', settings: {}, homing: true, timeScale: 1 } },
    ]
    for (const m of bad) expectErrCode(parseWith(MainMessage, m, 'test'), 'input.malformed')
    expectOk(parseWith(HostMessage, { type: 'event', kind: 'alarm', data: { code: 2 } }, 't'))
    expectErrCode(
      parseWith(HostMessage, { type: 'status', status: { state: 'Idle' } }, 't'),
      'input.malformed',
    )
  })
})

describe('machine host', () => {
  it('answers init with ready and forwards its log', async () => {
    const h = harness()
    h.send({ type: 'init', protocol: PROTOCOL_VERSION, logLevel: 'info' })
    expect(h.out[0]).toEqual({ type: 'ready', protocol: PROTOCOL_VERSION })
    await h.pump(() => h.of('log').length > 0, 1000)
    const records = h.of('log').flatMap((m) => m.batch) as { msg: string; proc: string }[]
    expect(records[0]).toMatchObject({ msg: 'machine host started', proc: 'worker' })
  })

  it('survives malformed messages and answers them when the request id is readable', async () => {
    const h = harness()
    h.send({ type: 'init', protocol: PROTOCOL_VERSION, logLevel: 'info' })
    h.send({ type: 'machine', requestId: 'x1', action: { kind: 'raw', line: 'G0 X1' } })
    h.send({ nonsense: true })
    const bad = h.of('reply').find((m) => m.requestId === 'x1')
    expectErrCode(fromWire(bad!.result), 'input.malformed')
    expectErrCode(
      await h.request({ type: 'machine', action: { kind: 'home' } }),
      'run.notConnected',
    )
  })

  it('connects in Alarm, refuses a second connect, homes, jogs and sets the work zero', async () => {
    const h = harness()
    const info = await connectedHost(h)
    expect(info).toMatchObject({ version: '1.1h.20190830', homed: false, workZero: [0, 0, 0] })
    expectErrCode(
      await h.request({
        type: 'connect',
        target: { kind: 'virtual', settings: {}, homing: true, timeScale: 1, machineKey: KEY },
      }),
      'run.busy',
    )
    // not homed: no jog and no job
    const jog = await h.request({
      type: 'machine',
      action: { kind: 'jog', by: [-10, 0, 0], feed: 3000 },
    })
    expect(expectErrCode(jog, 'run.state').toJSON().frames[0]?.data).toMatchObject({
      state: 'Alarm',
    })
    expectErrCode(
      await h.request({
        type: 'jobStart',
        jobId: 'j1',
        program: { lines: ['G0 X-1'], sections: [] },
      }),
      'run.state',
    )
    expectOk(await h.request({ type: 'machine', action: { kind: 'home' } }))
    expect(lastStatus(h)).toMatchObject({ homed: true, state: 'Idle', mpos: [-1, -1, -1] })
    expectOk(
      await h.request({
        type: 'machine',
        action: { kind: 'jog', to: [-100, -200, -10], feed: 3000 },
      }),
    )
    await h.pump(() => lastStatus(h)?.state === 'Idle' && lastStatus(h)?.mpos[1] === -200)
    expectOk(
      await h.request({ type: 'machine', action: { kind: 'jog', by: [0, 0, -5], feed: 600 } }),
    )
    await h.pump(() => lastStatus(h)?.state === 'Idle' && lastStatus(h)?.mpos[2] === -15)
    const g54 = expectOk(
      await h.request({
        type: 'machine',
        action: { kind: 'setWorkZero', axes: ['x', 'y', 'z'], values: [0, 0, 5] },
      }),
    )
    expect(g54).toEqual([-100, -200, -20])
    expect(lastStatus(h)?.workZero).toEqual([-100, -200, -20])
    await h.pump(() => lastStatus(h)?.wpos[2] === 5)
  })

  it('prepare: homes at max speed and places G54', async () => {
    const h = harness()
    const info = await connectedHost(h, { timeScale: 1, prepare: { workZero: [-400, -400, -20] } })
    expect(info).toMatchObject({ homed: true, workZero: [-400, -400, -20] })
    // homing takes 9.6 s at 1×; at max it took (almost) no wall time
    expect(h.w.now()).toBeLessThan(2000)
    expect(lastStatus(h)?.timeScale).toBe(1)
  })

  it('runs a job: progress, phases, a tool change and throttled status', async () => {
    const h = harness()
    await connectedHost(h, { timeScale: 1, prepare: { workZero: [-500, -500, -50] } })
    const lines = ['G21 G90 G54', 'G0 Z5', 'G1 X50 F3000', 'G0 Z10']
    for (let i = 0; i < 40; i++) lines.push(`G1 X${50 + (i % 2) * 10} Y${i} F3000`)
    lines.push('(DFYOM TOOL CHANGE 2: 3 mm flat)', 'M0', 'G90 G94 G17 G21', 'G0 X0 Y0', 'M30')
    const sections = [
      { fromLine: 1, label: 'pocket1' },
      { fromLine: 45, label: 'tool 2' },
    ]
    const before = h.out.length
    const wallStart = h.w.now()
    expectOk(await h.request({ type: 'jobStart', jobId: 'j1', program: { lines, sections } }))
    expectErrCode(
      await h.request({ type: 'jobStart', jobId: 'j2', program: { lines, sections } }),
      'run.busy',
    )
    expect(await h.pump(() => h.of('phase').some((p) => p.phase === 'toolChange'))).toBe(true)
    expect(h.of('phase').at(-1)).toEqual({
      type: 'phase',
      jobId: 'j1',
      phase: 'toolChange',
      toolChange: { n: 2, name: '3 mm flat' },
    })
    expect(lastStatus(h)?.job).toMatchObject({ jobId: 'j1', phase: 'toolChange' })
    // jog and zero while the tool change waits; not while streaming
    const z0 = lastStatus(h)!.mpos[2]
    expectOk(
      await h.request({ type: 'machine', action: { kind: 'jog', by: [0, 0, -3], feed: 600 } }),
    )
    await h.pump(() => lastStatus(h)?.state === 'Idle' && lastStatus(h)?.mpos[2] === z0 - 3)
    expectOk(await h.request({ type: 'machine', action: { kind: 'setWorkZero', axes: ['z'] } }))
    expectErrCode(
      await h.request({ type: 'jobControl', jobId: 'j1', action: 'resume' }),
      'run.state',
    )
    expectErrCode(
      await h.request({
        type: 'jobControl',
        jobId: 'j1',
        action: 'continue',
        expect: { toolChange: 3 },
      }),
      'run.state',
    )
    expectOk(
      await h.request({
        type: 'jobControl',
        jobId: 'j1',
        action: 'continue',
        expect: { toolChange: 2 },
      }),
    )
    expect(await h.pump(() => h.of('jobEnd').length > 0)).toBe(true)
    const end = h.of('jobEnd')[0]!
    expect(expectOk(fromWire(end.result))).toMatchObject({ lines: lines.length, toolChanges: 1 })
    const progress = h.of('progress')
    expect(progress.at(-1)).toMatchObject({ done: lines.length, total: lines.length })
    expect(new Set(progress.map((p) => p.label))).toContain('pocket1')
    expect(h.of('phase').map((p) => p.phase)).toEqual([
      'streaming',
      'toolChange',
      'streaming',
      'done',
    ])
    // throttling: per 100 ms of wall time at most one status and one progress, plus state changes
    const wallSeconds = (h.w.now() - wallStart) / 1000
    const statuses = h.out.slice(before).filter((m) => m.type === 'status')
    const changes = new Set(statuses.map((m) => m.status.state)).size + 8
    expect(statuses.length).toBeLessThanOrEqual(wallSeconds * 10 + changes * 2)
    expect(progress.length).toBeLessThanOrEqual(wallSeconds * 10 + 2)
    expect(lastStatus(h)?.job).toBeUndefined()
  })

  it('pre-flight, hold/resume, stop and the time scale', async () => {
    const h = harness()
    await connectedHost(h, { prepare: { workZero: [-500, -500, -50] } })
    expectErrCode(
      await h.request({
        type: 'jobStart',
        jobId: 'j0',
        program: { lines: ['G0 X1 (ok?)'], sections: [] },
      }),
      'run.program',
    )
    expectOk(await h.request({ type: 'timeScale', scale: 1 }))
    expectOk(
      await h.request({
        type: 'jobStart',
        jobId: 'j1',
        program: { lines: ['G21 G91', 'G1 X-200 F3000', 'G1 X200'], sections: [] },
      }),
    )
    await h.pump(() => lastStatus(h)?.state === 'Run')
    expectOk(await h.request({ type: 'jobControl', jobId: 'j1', action: 'hold' }))
    await h.pump(() => lastStatus(h)?.state === 'Hold:0')
    expectOk(await h.request({ type: 'jobControl', jobId: 'j1', action: 'resume' }))
    expectOk(await h.request({ type: 'timeScale', scale: 50 }))
    expect(lastStatus(h)?.timeScale).toBe(50)
    expectOk(await h.request({ type: 'jobControl', jobId: 'j1', action: 'stop' }))
    expect(await h.pump(() => h.of('jobEnd').length > 0)).toBe(true)
    expectErrCode(fromWire(h.of('jobEnd')[0]!.result), 'op.aborted')
    expect(h.of('event').filter((e) => e.kind === 'alarm')).toEqual([])
    expect(lastStatus(h)).toMatchObject({ homed: true })
    expectErrCode(await h.request({ type: 'jobControl', jobId: 'j1', action: 'stop' }), 'run.state')
  })

  it('a reset during motion raises ALARM:3 and clears homed', async () => {
    const h = harness()
    await connectedHost(h, { prepare: { workZero: [-500, -500, -50] } })
    expectOk(
      await h.request({
        type: 'jobStart',
        jobId: 'j1',
        program: { lines: ['G21 G91', 'G1 X-300 F3000'], sections: [] },
      }),
    )
    expectOk(await h.request({ type: 'timeScale', scale: 1 }))
    await h.pump(() => lastStatus(h)?.state === 'Run')
    expectOk(await h.request({ type: 'machine', action: { kind: 'reset' } }))
    expect(await h.pump(() => h.of('jobEnd').length > 0)).toBe(true)
    expectErrCode(fromWire(h.of('jobEnd')[0]!.result), 'machine.alarm')
    await h.pump(() => lastStatus(h)?.alarm?.code === 3 && lastStatus(h)?.state === 'Alarm')
    expect(lastStatus(h)).toMatchObject({ homed: false, state: 'Alarm' })
  })

  it('disconnects and lets the process exit', async () => {
    const h = harness()
    await connectedHost(h)
    expectOk(await h.request({ type: 'disconnect' }))
    expect(h.disconnected()).toBe(1)
    expectErrCode(
      await h.request({ type: 'machine', action: { kind: 'home' } }),
      'run.notConnected',
    )
    const pending = h.w.pending
    h.w.advance(10_000)
    expect(h.w.pending).toBeLessThanOrEqual(pending)
  })

  it('a job start re-checks the G54, the machine copy and the target', async () => {
    const h = harness()
    await connectedHost(h, { prepare: { workZero: [-500, -500, -50] } })
    const program = { lines: ['G21 G90', 'G0 X1'], sections: [] }
    const start = (expect: Record<string, unknown>) =>
      h.request({
        type: 'jobStart',
        jobId: 'j1',
        program,
        expect: { workZero: [-500, -500, -50], machineKey: KEY, target: 'virtual', ...expect },
      })
    const moved = expectErrCode(await start({ workZero: [-500, -500, 100] }), 'run.state')
    expect(moved.issues[0]?.rule).toBe('workZeroChanged')
    const other = expectErrCode(await start({ machineKey: 'another' }), 'run.state')
    expect(other.issues[0]?.rule).toBe('machineMismatch')
    expectOk(await start({}))
  })

  it('a stop or disconnect while the start checks makes the start refuse (op.aborted), never stream', async () => {
    const h = harness()
    await connectedHost(h, { prepare: { workZero: [-500, -500, -50] } })
    const workZero = lastStatus(h)!.workZero
    const program = { lines: ['G21 G91', 'G1 X-10 F3000'], sections: [] }
    const expect_ = { workZero, machineKey: KEY, target: 'virtual' }
    const reply = (id: string) => {
      const r = h.out.find((x) => x.type === 'reply' && x.requestId === id)
      return r?.type === 'reply' ? fromWire(r.result) : undefined
    }
    // job.abort in the same tick as the start: the host is still checking (fresh report, $#)
    h.send({ type: 'jobStart', requestId: 's1', jobId: 'j1', program, expect: expect_ })
    h.send({ type: 'jobControl', requestId: 'x1', jobId: 'j1', action: 'stop' })
    expect(await h.pump(() => reply('s1') !== undefined && reply('x1') !== undefined)).toBe(true)
    expectOk(reply('x1')!)
    expectErrCode(reply('s1')!, 'op.aborted')
    expect(h.of('phase')).toEqual([])
    expect(lastStatus(h)?.job).toBeUndefined()
    // disconnect (app quit) in the same tick: the start refuses before the sender closes
    h.send({ type: 'jobStart', requestId: 's2', jobId: 'j2', program, expect: expect_ })
    h.send({ type: 'disconnect', requestId: 'd1' })
    expect(await h.pump(() => reply('s2') !== undefined && reply('d1') !== undefined)).toBe(true)
    expectOk(reply('d1')!)
    expectErrCode(reply('s2')!, 'op.aborted')
    expect(h.of('jobEnd')).toEqual([])
  })

  it('a job start right after a jog sees the jog (no stale Idle)', async () => {
    const h = harness()
    await connectedHost(h, { timeScale: 1, prepare: { workZero: [-500, -500, -50] } })
    expectOk(
      await h.request({ type: 'machine', action: { kind: 'jog', by: [-10, 0, 0], feed: 600 } }),
    )
    const r = await h.request({
      type: 'jobStart',
      jobId: 'j1',
      program: { lines: ['G0 X-1'], sections: [] },
    })
    expectErrCode(r, 'run.state')
  })

  it('after a critical alarm commands fail at once and the reset gets through', async () => {
    const h = harness()
    await connectedHost(h, { prepare: { workZero: [-500, -500, -50] } })
    expectOk(
      await h.request({
        type: 'jobStart',
        jobId: 'j1',
        program: { lines: ['G53 G0 X10'], sections: [] },
      }),
    )
    expect(await h.pump(() => h.of('jobEnd').length > 0)).toBe(true)
    expectErrCode(fromWire(h.of('jobEnd')[0]!.result), 'machine.alarm')
    const set = await h.request({ type: 'machine', action: { kind: 'setWorkZero', axes: ['z'] } })
    expectErrCode(set, 'run.state')
    expectOk(await h.request({ type: 'machine', action: { kind: 'reset' } }))
    await h.pump(() => lastStatus(h)?.state === 'Alarm' && lastStatus(h)?.alarm?.code === 2)
    expectOk(await h.request({ type: 'machine', action: { kind: 'unlock' } }))
  })

  it('reports its true target', async () => {
    const h = harness()
    const info = (await connectedHost(h)) as ConnectedInfo & { target?: string }
    expect(info.target).toBe('virtual')
  })
})
