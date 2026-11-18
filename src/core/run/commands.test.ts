// Run commands with an in-process machine host (real timers, time scale max).
// Spec: docs/modes/run-v0.1.md#commands-and-queries, #run-job, #testing (Commands)
import { afterEach, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Ok, type AppResult } from '../../shared/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeIds, uiSource } from '../commands/testing'
import { len } from '../library/library.fixture'
import { machineValues } from '../library/library.fixture'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { systemTimerHost } from './clock'
import { checkNoRunJob } from './commands'
import { MachineClient } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { RunStatus } from './service'

const agent = agentSource()
const ui = uiSource()
const clients: MachineClient[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 5) {
    if (cond()) return true
    await sleep(5)
  }
  return cond()
}

async function setup(opts: { machine?: boolean } = {}) {
  const s: PlanSetup = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const ops = s.plan(planId).setups[0]!.operations
  for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
  const client = new MachineClient({
    factory: inProcessHostFactory({ timers: systemTimerHost }),
    logLevel: 'warn',
  })
  clients.push(client)
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: createInProcessWorkers(),
      library: s.library,
      toolpaths: createToolpathCache(),
      exportFiles: { write: async (target) => Ok({ filePath: target }) },
      ...(opts.machine === false ? {} : { machine: client }),
    },
  })
  const run = async (name: string, args: object, source = agent): Promise<AppResult<unknown>> =>
    (await d.dispatch(name, args, source)).map((o) => o.value)
  const status = () => expectOk(d.query('run.status.get', {}, agent)).value as RunStatus
  /** Starts a job command and returns its id and result promise. */
  const job = async (name: string, args: object) => {
    const { jobId } = expectOk(await run(name, args)) as { jobId: string }
    return { jobId, result: d.job(jobId).unwrap().result }
  }
  const open = (over: object = {}) =>
    run('run.connection.open', { target: 'virtual', planId, timeScale: 'max', ...over })
  return { s, planId, d, client, run, status, job, open }
}

describe('run commands', { timeout: 60_000 }, () => {
  it('fail with run.notConnected without a connection or a machine port', async () => {
    const t = await setup()
    expect(t.status().connection.state).toBe('closed')
    expectErrCode(await t.run('run.machine.unlock', {}), 'run.notConnected')
    const { result } = await t.job('run.job.start', { planId: t.planId })
    expectErrCode(await result, 'run.notConnected')
    const bare = await setup({ machine: false })
    // without a machine port agents are denied (strict policy); the UI gets run.notConnected
    expectErrCode(await bare.open(), 'permission.denied')
    expectErrCode(
      await bare.run('run.connection.open', { target: 'virtual', planId: bare.planId }, ui),
      'run.notConnected',
    )
    expect(bare.status().state).toBe('Disconnected')
  })

  it('an agent connects (prepare), runs the plan, continues tool changes and pauses', async () => {
    const t = await setup()
    const info = expectOk(await t.open({ prepare: true })) as { homed: boolean; workZero: number[] }
    expect(info.homed).toBe(true)
    expectErrCode(await t.open(), 'run.busy')
    const st = t.status()
    expect(st).toMatchObject({ connection: { state: 'open', target: 'virtual' }, homed: true })
    expect(st.workZero[0]).toBeLessThan(-300)
    // plan.export now checks the soft limits at the connected G54
    const exported = expectOk(await t.run('plan.export', { planId: t.planId, target: '/x.nc' }))
    expect(exported).toMatchObject({ softLimitChecked: true })
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    const waits: string[] = []
    let finished = false
    void result.then(() => (finished = true))
    for (;;) {
      expect(
        await waitFor(() => {
          const p = t.status().job?.phase
          return finished || p === 'toolChange' || p === 'programPause'
        }),
      ).toBe(true)
      if (finished) break
      const job = t.status().job!
      waits.push(job.phase)
      expect(job).toMatchObject({ jobId, startedAt: expect.any(String) })
      if (job.phase === 'toolChange') {
        // touch off 1 mm lower; the new tool has the same length: Z keeps its offset
        const before = t.status().workZero
        expectOk(await t.run('run.machine.jog', { by: [0, 0, -1], feed: 300 }))
        await waitFor(() => t.status().state === 'Idle')
        await sleep(20)
        const z = t.status().wpos[2]
        expect(z).toBeCloseTo(t.status().mpos[2] - before[2], 6)
        const set = expectOk(await t.run('run.workZero.set', { axes: ['z'], values: [0, 0, z] }))
        expect((set as { workZero: number[] }).workZero[2]).toBeCloseTo(before[2], 3)
      }
      expectOk(await t.run('run.job.continue', { jobId }))
      await waitFor(() => finished || t.status().job?.phase === 'streaming')
    }
    const summary = expectOk(await result) as { lines: number; toolChanges: number; pauses: number }
    expect(summary.toolChanges).toBe(waits.filter((w) => w === 'toolChange').length)
    expect(summary.pauses).toBe(waits.filter((w) => w === 'programPause').length)
    expect(summary.toolChanges).toBeGreaterThan(0)
    expect(summary.pauses).toBeGreaterThan(0) // manual spindle prompts
    expect(t.status().job).toBeUndefined()
    const handle = t.d.job(jobId).unwrap()
    expect(handle.progress).toMatchObject({ done: summary.lines, total: summary.lines })
    expectOk(await t.run('run.connection.close', {}))
    expect(t.status().connection.state).toBe('closed')
  })

  it('refuses a start that is not homed, a soft-limit violation and another machine copy', async () => {
    const t = await setup()
    expectOk(await t.open())
    let r = await t.job('run.job.start', { planId: t.planId })
    expect(expectErrCode(await r.result, 'run.state').toJSON().frames[0]?.data).toMatchObject({
      homed: false,
    })
    const home = await t.job('run.machine.home', {})
    expect(expectOk(await home.result)).toEqual({ workZero: [0, 0, 0] })
    // G54 at the home position: the part lies above the travel
    r = await t.job('run.job.start', { planId: t.planId })
    const e = expectErrCode(await r.result, 'run.softLimit')
    expect((e.toJSON().frames[0]?.data as { findings: unknown[] }).findings.length).toBeGreaterThan(
      0,
    )
    // a plan with another machine copy
    const { kind: _, ...other } = machineValues()
    const otherId = (
      (await t.s.run('library.machine.add', {
        values: { ...other, name: 'Other', travel: { ...other.travel, z: len('90') } },
      })) as { id: string }
    ).id
    const plan2 = await t.s.create({ machineLibraryItemId: otherId })
    const d2 = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc: t.s.d.doc,
      ids: fakeIds(),
      services: {
        workers: createInProcessWorkers(),
        toolpaths: createToolpathCache(),
        machine: t.client,
      },
    })
    const { jobId } = expectOk(await d2.dispatch('run.job.start', { planId: plan2 }, agent))
      .value as { jobId: string }
    const mismatch = expectErrCode(await d2.job(jobId).unwrap().result, 'run.state')
    expect(mismatch.issues[0]?.rule).toBe('machineMismatch')
  })

  it('an archived plan does not run', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    await t.s.toStatus(t.planId, 'archived')
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc: t.s.d.doc,
      ids: fakeIds(),
      services: {
        workers: createInProcessWorkers(),
        toolpaths: createToolpathCache(),
        machine: t.client,
      },
    })
    const { jobId } = expectOk(await d.dispatch('run.job.start', { planId: t.planId }, agent))
      .value as { jobId: string }
    expectErrCode(await d.job(jobId).unwrap().result, 'plan.status')
  })

  it('job.pause holds, job.resume resumes, job.abort stops; close is refused while running', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    expectOk(await t.run('run.timeScale.set', { scale: 1 }))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    expectErrCode(await t.run('run.connection.close', {}), 'run.busy')
    expectErrCode(await t.run('run.job.continue', { jobId }), 'run.state')
    expect(
      checkNoRunJob({ get: () => t.d.job(jobId), list: () => [t.d.job(jobId).unwrap()] }).isErr(),
    ).toBe(true)
    expectOk(await t.run('job.pause', { jobId }))
    expect(await waitFor(() => t.status().job?.phase === 'held')).toBe(true)
    expectOk(await t.run('job.resume', { jobId }))
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    expectOk(await t.run('run.timeScale.set', { scale: 'max' }))
    expectOk(await t.run('job.abort', { jobId }))
    expectErrCode(await result, 'op.aborted')
    expect(await waitFor(() => t.status().job === undefined)).toBe(true)
    expect(t.status().alarm).toBeUndefined()
    expect(
      checkNoRunJob({ get: () => t.d.job(jobId), list: () => [t.d.job(jobId).unwrap()] }).isOk(),
    ).toBe(true)
  })

  it('the host exiting fails the job with machine.connection and closes the connection', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true, timeScale: 1 }))
    const { result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    t.client.close() // as a crash: the host is gone
    expectErrCode(await result, 'machine.connection')
    expect(t.status().connection.state).toBe('closed')
    // a fresh host on the next open
    expectOk(await t.open())
  })
})
