// The machine host in a real `worker_threads` worker (bundled entry, global-setup.ts): the test
// part at `max` speed end to end, and a host crash. Spec: docs/modes/run-v0.1.md#testing
import { afterEach, describe, expect, inject, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { LogRecord } from '../../shared/logging'
import { machineSettings } from '../../core/run/grbl/emulator/settings'
import type { MachineHostFactory, MachineHostHandle } from '../../core/run/host/client'
import { MachineClient } from '../../core/run/host/client'
import type { RunSummary } from '../../core/run/grbl/sender'
import { exportGrbl } from '../../core/post/export'
import { OPTS, testMachine, testPartExport } from '../../core/post/post.fixture'
import type { Vec3 } from '../../core/toolpath/model'
import { workerHostFactory } from './spawn'

const entry = inject('machineEntry')
const clients: MachineClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

const WORK_ZERO: Vec3 = [-750, -750, -50]

function client(): { c: MachineClient; handles: MachineHostHandle[]; logs: LogRecord[] } {
  const handles: MachineHostHandle[] = []
  const inner = workerHostFactory(entry)
  const factory: MachineHostFactory = (events) => {
    const h = inner(events)
    handles.push(h)
    return h
  }
  const logs: LogRecord[] = []
  const c = new MachineClient({
    factory,
    logLevel: 'info',
    onLog: (batch) => logs.push(...(batch as LogRecord[])),
  })
  clients.push(c)
  return { c, handles, logs }
}

const settings = () =>
  Object.fromEntries(Object.entries(machineSettings(testMachine())).map(([k, v]) => [k, v]))

describe('machine host in worker_threads', { timeout: 60_000 }, () => {
  it('runs the test part at max speed end to end, continuing each tool change', async () => {
    const { c, logs } = client()
    const e = expectOk(exportGrbl({ ...testPartExport(), workZero: WORK_ZERO }, OPTS))
    const info = expectOk(
      await c.connect(
        {
          kind: 'virtual',
          settings: settings(),
          homing: true,
          timeScale: 'max',
          prepare: { workZero: WORK_ZERO },
        },
        'key',
      ),
    )
    expect(info).toMatchObject({ homed: true, workZero: WORK_ZERO })
    const phases: string[] = []
    const started = expectOk(
      await c.startJob(
        'job-1',
        { lines: e.lines, sections: [] },
        {
          progress: () => {},
          phase: (p) => {
            phases.push(p.phase)
            if (p.phase === 'toolChange') void c.controlJob('job-1', 'continue')
          },
        },
      ),
    )
    const wallStart = performance.now()
    const summary: RunSummary = expectOk(await started.ended)
    const wallMs = performance.now() - wallStart
    expect(summary).toMatchObject({ lines: e.lines.length, toolChanges: 5 })
    // the same program time as on the VirtualClock (grbl.md#determinism-and-tests)
    expect(summary.seconds).toBeGreaterThan(e.stats.estimatedSeconds)
    expect(phases.filter((p) => p === 'toolChange')).toHaveLength(5)
    expect(c.status()).toMatchObject({ state: 'Idle', connection: { state: 'open' } })
    console.info(
      `test part at max: ${summary.seconds.toFixed(1)} s machine time in ${wallMs.toFixed(0)} ms wall`,
    )
    // forwarded in batches
    for (let i = 0; i < 200 && !logs.some((l) => l.msg === 'job ended'); i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(logs.find((l) => l.msg === 'job ended')).toMatchObject({
      proc: 'worker',
      scope: 'run.host',
    })
    expectOk(await c.disconnect())
    expect(c.status().connection.state).toBe('closed')
  })

  it('a host crash fails the job with machine.connection; the next connect starts a fresh host', async () => {
    const { c, handles } = client()
    expectOk(
      await c.connect(
        { kind: 'virtual', settings: settings(), homing: false, timeScale: 1 },
        'key',
      ),
    )
    const started = expectOk(
      await c.startJob(
        'job-1',
        { lines: ['G21 G91', 'G1 X-300 F600'], sections: [] },
        {
          progress: () => {},
          phase: () => {},
        },
      ),
    )
    handles[0]!.terminate() // as if the host crashed
    expectErrCode(await started.ended, 'machine.connection')
    expect(c.status().connection.state).toBe('closed')
    expectOk(
      await c.connect(
        { kind: 'virtual', settings: settings(), homing: false, timeScale: 1 },
        'key',
      ),
    )
    expect(handles).toHaveLength(2)
  })
})
