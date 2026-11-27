// The run record and journal (hardening DF129, RC1): the throttle, the executing line by source,
// the modal state, the recorder's end states, and a real run on the loopback port (the GRBL
// emulator behind a USB-like stream) unplugged mid-job. Spec: docs/modes/run-recovery.md#implementation-rc1
import { afterEach, describe, expect, it } from 'vitest'
import { parseWith } from '../../shared/parse'
import { expectOk } from '../../shared/testing/result'
import { systemTimerHost } from './clock'
import { FAST } from './grbl/emulator.fixture'
import { loopbackSerialPorts } from './grbl/loopback.fixture'
import { MachineClient, type MachineHostHandle } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { HostStatus } from './host/protocol'
import {
  executingLine,
  JournalThrottle,
  lineNumberIndex,
  ModalTracker,
  RunJournalSchema,
  RunRecorder,
  toolChanges,
  type RunJournal,
} from './journal'

const clients: MachineClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

describe('JournalThrottle', () => {
  it('writes at most once per interval; events always, restarting it', () => {
    const t = new JournalThrottle(1000)
    expect(t.take(0)).toBe(true)
    expect(t.take(200)).toBe(false)
    expect(t.take(999)).toBe(false)
    expect(t.take(1000)).toBe(true)
    expect(t.take(1500, true)).toBe(true)
    expect(t.take(2000)).toBe(false)
    expect(t.take(2500)).toBe(true)
  })
})

describe('executing line', () => {
  it("uses GRBL's Ln: mapped through the program's N words, else the estimate, else a full planner back", () => {
    const index = lineNumberIndex(['G21', 'N10 G1 X1 F100', 'N20 G1 X2', 'N30 G1 X3'])
    expect([...(index ?? [])]).toEqual([
      [10, 2],
      [20, 3],
      [30, 4],
    ])
    expect(executingLine({ acknowledged: 4, reported: 20, index, estimate: 2 })).toEqual({
      line: 3,
      from: 'reported',
    })
    // an N number not in the program: the estimate
    expect(executingLine({ acknowledged: 4, reported: 99, index, estimate: 2 })).toEqual({
      line: 2,
      from: 'estimate',
    })
    // never after the acknowledged lines
    expect(executingLine({ acknowledged: 30, estimate: 40 }).line).toBe(30)
    expect(executingLine({ acknowledged: 30 })).toEqual({ line: 14, from: 'planner' })
    expect(executingLine({ acknowledged: 5 })).toEqual({ line: 0, from: 'planner' })
  })

  it('ignores N words that repeat or go backwards (Ln: is then not a line)', () => {
    expect(lineNumberIndex(['N10 G0 X1', 'N10 G0 X2'])).toBeUndefined()
    expect(lineNumberIndex(['N20 G0 X1', 'N10 G0 X2'])).toBeUndefined()
    expect(lineNumberIndex(['G0 X1', 'G0 X2'])).toBeUndefined()
  })
})

describe('ModalTracker and tool changes', () => {
  const lines = [
    'G21 G90',
    '(DFYOM TOOL CHANGE 1: 6 mm flat end mill)',
    'M0',
    'T1 M3 S18000',
    'G0 X10 Y10',
    'G1 Z-1 F300',
    'G20 G91',
    'G1 X1 F10',
  ]

  it('gives the state each line starts in, parsing forward once', () => {
    const m = new ModalTracker(lines)
    expect(m.at(1)).toMatchObject({ metric: true, absolute: true, spindle: 'off', feed: 0 })
    expect(m.at(6)).toMatchObject({ motion: 0, spindle: 'cw', spindleSpeed: 18000, tool: 1 })
    expect(m.at(7)).toMatchObject({ motion: 1, feed: 300 })
    expect(m.at(8)).toMatchObject({ metric: false, absolute: false })
    expect(toolChanges(lines)).toEqual([{ line: 2, n: 1, name: '6 mm flat end mill' }])
  })
})

describe('RunRecorder', () => {
  const program = {
    lines: ['G21 G90', '(DFYOM TOOL CHANGE 2: V-bit)', 'M0', 'M3 S9000', 'G1 X5 F600', 'G1 X10'],
    sections: [
      { fromLine: 1, label: 'Pocket 1' },
      { fromLine: 5, label: 'Profile 1' },
    ],
  }
  const status = (
    over: Partial<HostStatus> = {},
    job: Partial<NonNullable<HostStatus['job']>> = {},
  ): HostStatus => ({
    state: 'Run',
    homed: true,
    mpos: [-100, -50, -10],
    wpos: [2, 0, 0],
    workZero: [-102, -50, -10],
    feed: 600,
    spindle: 9000,
    timeScale: 1,
    job: {
      jobId: 'j1',
      phase: 'streaming',
      line: 6,
      sent: 6,
      ackedAtReport: 5,
      elapsedSeconds: 1,
      ...job,
    },
    ...over,
  })
  const recorder = () =>
    new RunRecorder(
      {
        jobId: 'j1',
        program,
        about: undefined,
        machine: { target: 'serial', port: { path: '/dev/x', baud: 115200 }, machineKey: 'k' },
        workZero: [-102, -50, -10],
        programHash: 'abc',
        now: 0,
      },
      new JournalThrottle(1000),
    )

  it('records the range, the last report, the tool, the section and the modal state; throttled', () => {
    const r = recorder()
    expect(r.snapshot()).toMatchObject({ state: 'running', job: { kind: 'program', lines: 6 } })
    // section change (Pocket 1 → Profile 1): an event, written at once
    expect(r.status(status(), 5, 100)).toBe(true)
    const j = r.snapshot()
    expectOk(parseWith(RunJournalSchema, j, 'test'))
    expect(j.progress).toMatchObject({
      sent: 6,
      acknowledged: 5,
      executing: 5,
      executingFrom: 'estimate',
    })
    expect(j.lastReport).toMatchObject({
      state: 'Run',
      mpos: [-100, -50, -10],
      wco: [-102, -50, -10],
    })
    expect(j.position).toMatchObject({
      tool: { n: 2, name: 'V-bit' },
      section: 'Profile 1',
      modal: { units: 'mm', distance: 'absolute', spindle: 'cw', spindleSpeed: 9000, motion: 0 },
    })
    // the same section within a second: not written; after a second: written
    expect(r.status(status({}, { ackedAtReport: 6 }), 6, 600)).toBe(false)
    expect(r.status(status({}, { ackedAtReport: 6 }), 6, 1100)).toBe(true)
    // the executing line never goes back
    r.status(status({}, { ackedAtReport: 6 }), 3, 1200)
    expect(r.snapshot().progress.executing).toBe(6)
  })

  it('a tool change, a pause or a hold writes at once', () => {
    const r = recorder()
    expect(r.phase('streaming', 10)).toBe(false)
    expect(r.phase('toolChange', 20)).toBe(true)
    expect(r.phase('held', 30)).toBe(true)
  })

  it('ends done, stopped, failed or interrupted with its reason', () => {
    const end = (
      result: Parameters<RunRecorder['end']>[0],
      flag?: 'controllerReset' | 'hostExit',
    ) => {
      const r = recorder()
      if (flag !== undefined) r.flag(flag)
      expect(r.end(result, 5000)).toBe(true)
      const { state, reason } = r.snapshot()
      return { state, reason }
    }
    expect(end({ ok: true })).toEqual({ state: 'done', reason: undefined })
    expect(end({ ok: false, code: 'op.aborted' })).toEqual({ state: 'stopped', reason: undefined })
    expect(end({ ok: false, code: 'machine.alarm' })).toEqual({
      state: 'failed',
      reason: undefined,
    })
    expect(end({ ok: false, code: 'machine.connection' })).toEqual({
      state: 'interrupted',
      reason: 'connectionLost',
    })
    expect(end({ ok: false, code: 'machine.reset' })).toEqual({
      state: 'interrupted',
      reason: 'controllerReset',
    })
    expect(end({ ok: false, code: 'machine.connection' }, 'hostExit')).toEqual({
      state: 'interrupted',
      reason: 'hostExit',
    })
    // a Stop is a Stop even after an event
    expect(end({ ok: false, code: 'op.aborted' }, 'controllerReset').state).toBe('stopped')
  })
})

// A real run on the loopback port: the record follows the emulator, the journal is written at the
// start, throttled, and once more when the run ends.
describe('the run journal of a real run (loopback)', { timeout: 60_000 }, () => {
  const PATH = '/dev/cu.usbmodem1101'
  const MOVES = 60
  /** Line 1 units and distance, line 2 the spindle, lines 3.. one 1 mm move in −X each. */
  const program = {
    lines: ['G21 G91', 'M3 S1000', ...Array.from({ length: MOVES }, () => 'G1 X-1 F600')],
    sections: [],
  }

  async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cond()) return true
      await new Promise((r) => setTimeout(r, 5))
    }
    return cond()
  }

  async function realRun() {
    const ports = loopbackSerialPorts(systemTimerHost, {
      emulator: { settings: { ...FAST } },
      timeScale: 'max',
    })
    const saved: RunJournal[] = []
    const awake: boolean[] = []
    let handle: MachineHostHandle | undefined
    const factory = inProcessHostFactory({ timers: systemTimerHost, serial: ports })
    const client = new MachineClient({
      factory: (events) => (handle = factory(events)),
      logLevel: 'warn',
      journal: { save: (j) => saved.push(j) },
      hashProgram: (text) => `len${text.length}`,
      keepAwake: (on) => awake.push(on),
    })
    clients.push(client)
    expectOk(await client.connect({ kind: 'serial', path: PATH, baud: 115_200, machineKey: 'k' }))
    expectOk(await client.machine({ kind: 'home' }))
    const port = ports.opened[0]!
    // the controller at real time: 0.1 s per line
    port.setTimeScale(1)
    const x0 = port.emulator.status().mpos[0]
    const started = expectOk(
      await client.startJob(
        'job-1',
        program,
        { progress: () => {}, phase: () => {} },
        { workZero: client.status().workZero, machineKey: 'k' },
      ),
    )
    /** The 1-based line moving at the emulator's position (moves are 1 mm in −X from x0). */
    const lineAt = (x: number) => 2 + Math.ceil(x0 - x - 1e-6)
    return { client, port, saved, awake, ended: started.ended, lineAt, handle: () => handle }
  }

  it('unplugged mid-job: interrupted (connectionLost), the range holds the line the controller was in and where it stopped', async () => {
    const r = await realRun()
    // a running journal at once, and the computer kept awake
    expect(r.saved[0]).toMatchObject({
      state: 'running',
      job: {
        jobId: 'job-1',
        kind: 'program',
        lines: MOVES + 2,
        programHash: expect.stringMatching(/^len/),
      },
      machine: { target: 'serial', port: { path: PATH }, machineKey: 'k' },
    })
    expect(r.awake).toEqual([true])
    expect(await waitFor(() => r.lineAt(r.port.emulator.status().mpos[0]) >= 20)).toBe(true)
    r.port.unplug()
    const lineAtUnplug = r.lineAt(r.port.emulator.status().mpos[0])
    const result = await r.ended
    expect(result.isErr()).toBe(true)
    expect(await waitFor(() => r.saved.at(-1)?.state !== 'running')).toBe(true)
    const j = r.saved.at(-1)!
    expectOk(parseWith(RunJournalSchema, j, 'test'))
    expect(j).toMatchObject({ state: 'interrupted', reason: 'connectionLost' })
    // the controller runs out what it received (a board powered by the machine)
    r.port.emulator.advance(60_000)
    const stopLine = r.lineAt(r.port.emulator.status().mpos[0])
    const { executing, acknowledged, sent } = j.progress
    expect(executing).toBeGreaterThan(2)
    expect(executing).toBeLessThanOrEqual(lineAtUnplug)
    expect(lineAtUnplug).toBeLessThanOrEqual(stopLine)
    expect(stopLine).toBeLessThanOrEqual(sent)
    expect(acknowledged).toBeLessThanOrEqual(sent)
    // the last report: moving, in −X; the modal state at the executing line
    expect(j.lastReport).toMatchObject({ state: 'Run', spindle: 1000 })
    expect(j.lastReport!.mpos[0]).toBeLessThan(r.port.emulator.status().mpos[0] + MOVES)
    expect(j.position.modal).toMatchObject({
      units: 'mm',
      distance: 'incremental',
      motion: 1,
      feed: 600,
      spindle: 'cw',
      spindleSpeed: 1000,
    })
    // throttled: after the start, running writes at least a second apart
    const running = r.saved.filter((s) => s.state === 'running').map((s) => Date.parse(s.updatedAt))
    for (let i = 2; i < running.length; i++)
      expect(running[i]! - running[i - 1]!).toBeGreaterThanOrEqual(1000)
    expect(r.awake).toEqual([true, false])
    // the in-memory record is the journal's last state
    expect(r.client.runRecord()).toEqual(j)
  })

  it('a machine host that exits mid-job: interrupted (hostExit)', async () => {
    const r = await realRun()
    expect(await waitFor(() => r.lineAt(r.port.emulator.status().mpos[0]) >= 5)).toBe(true)
    r.handle()!.terminate()
    await r.ended
    expect(await waitFor(() => r.saved.at(-1)?.state !== 'running')).toBe(true)
    expect(r.saved.at(-1)).toMatchObject({ state: 'interrupted', reason: 'hostExit' })
    expect(r.awake).toEqual([true, false])
  })

  it('a run that ends normally closes the journal as done', async () => {
    const r = await realRun()
    r.port.setTimeScale('max')
    expectOk(await r.ended)
    expect(await waitFor(() => r.saved.at(-1)?.state === 'done')).toBe(true)
    expect(r.saved.at(-1)!.progress).toMatchObject({ sent: MOVES + 2, acknowledged: MOVES + 2 })
    expect(r.awake).toEqual([true, false])
  })
})
