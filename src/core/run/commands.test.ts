// Run commands with an in-process machine host (real timers, time scale max).
// Spec: docs/modes/run-v0.1.md#commands-and-queries, #run-job, #testing (Commands)
import { afterEach, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { Ok, type AppResult } from '../../shared/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeIds, uiSource } from '../commands/testing'
import { libraryInput, machineValues } from '../library/library.fixture'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { systemTimerHost } from './clock'
import { checkNoRunJob, prepareWorkZero } from './commands'
import { machineKeyOf } from './machine-key'
import { MachineClient } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { MachineService, RunStatus } from './service'
import { loopbackSerialPorts, type LoopbackOptions } from './grbl/loopback.fixture'
import { machineSettings } from './grbl/emulator/settings'
import { Machine } from '../library/machine'

const agent = agentSource()
const ui = uiSource()
const clients: MachineClient[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `cond` until it holds or `ms` of wall time passed (not a count of polls: a loaded
 * machine stretches each 5 ms sleep, and the budget must stay below the test's timeout). */
async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(5)
  }
  return cond()
}

async function setup(
  opts: {
    machine?: boolean
    bottom?: boolean
    /** Wraps the client as the dispatcher's machine port (e.g. to delay a reply). */
    wrap?: (client: MachineClient) => MachineService
    /** Loopback serial ports; the emulator gets the library machine's settings plus these. */
    serial?: (settings: Record<number, number>) => LoopbackOptions
  } = {},
) {
  const s: PlanSetup = await planSetup()
  // a bottom facing too: setups Bottom, Top (task E2)
  if (opts.bottom === true)
    await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const ops = s.plan(planId).setups.at(-1)!.operations
  for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
  const found = s.library.lookup('machine', s.machineId)
  const libMachine =
    found.state === 'found' && found.item.values instanceof Machine ? found.item.values : undefined
  const serial =
    opts.serial === undefined || libMachine === undefined
      ? undefined
      : loopbackSerialPorts(systemTimerHost, opts.serial({ ...machineSettings(libMachine) }))
  const client = new MachineClient({
    factory: inProcessHostFactory({
      timers: systemTimerHost,
      ...(serial === undefined ? {} : { serial }),
    }),
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
      ...(opts.machine === false ? {} : { machine: opts.wrap?.(client) ?? client }),
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
  return { s, planId, d, client, run, status, job, open, serial }
}

describe('run commands', { timeout: 60_000 }, () => {
  it('fail with run.notConnected without a connection or a machine port', async () => {
    const t = await setup()
    expect(t.status().connection.state).toBe('closed')
    expectErrCode(await t.run('run.machine.unlock', {}, ui), 'run.notConnected')
    // with no connection, agents may only open a virtual one (deny by default)
    expectErrCode(await t.run('run.machine.unlock', {}), 'permission.denied')
    expectErrCode(await t.run('run.job.start', { planId: t.planId }), 'permission.denied')
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    expectErrCode(await t.d.job(jobId).unwrap().result, 'run.notConnected')
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
      if (job.phase === 'toolChange' && waits.length === 1) {
        // job.pause while waiting: continue is refused until job.resume
        expectOk(await t.run('job.pause', { jobId }))
        const n = job.toolChange!.n
        expectErrCode(await t.run('run.job.continue', { jobId, toolChange: n }), 'run.state')
        expectOk(await t.run('job.resume', { jobId }))
        // a continue for another tool change is refused (a retried continue skips nothing)
        expectErrCode(await t.run('run.job.continue', { jobId, toolChange: n + 1 }), 'run.state')
      }
      if (job.phase === 'toolChange') {
        // touch off 1 mm lower; the new tool has the same length: Z keeps its offset
        const before = t.status().workZero
        const zBefore = t.status().mpos[2]
        expectOk(await t.run('run.machine.jog', { by: [0, 0, -1], feed: 300 }))
        // the jog's ok comes before its motion: wait for a report of it done, not the Idle before it
        expect(
          await waitFor(
            () =>
              t.status().state === 'Idle' && Math.abs(t.status().mpos[2] - (zBefore - 1)) < 5e-4,
          ),
        ).toBe(true)
        const z = t.status().wpos[2]
        expect(z).toBeCloseTo(t.status().mpos[2] - before[2], 6)
        const set = expectOk(await t.run('run.workZero.set', { axes: ['z'], values: [0, 0, z] }))
        expect((set as { workZero: number[] }).workZero[2]).toBeCloseTo(before[2], 3)
      }
      const which =
        job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
      expectOk(await t.run('run.job.continue', { jobId, ...which }))
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

  it('runs one setup per job; the result names the next setup (E2)', async () => {
    const t = await setup({ bottom: true })
    const [bottom, top] = t.s.plan(t.planId).setups
    expect([bottom?.name, top?.name]).toEqual(['Bottom', 'Top'])
    expectOk(await t.open({ prepare: true }))
    // several setups: name one
    let r = await t.job('run.job.start', { planId: t.planId })
    const missing = expectErrCode(await r.result, 'plan.setup')
    expect(missing.issues[0]?.rule).toBe('setupRequired')
    r = await t.job('run.job.start', { planId: t.planId, setupId: 'nope' })
    expectErrCode(await r.result, 'input.malformed')
    /** Runs a setup to its end, continuing every wait. */
    const runSetup = async (setupId: string) => {
      const { jobId, result } = await t.job('run.job.start', { planId: t.planId, setupId })
      let finished = false
      void result.then(() => (finished = true))
      for (;;) {
        await waitFor(() => {
          const p = t.status().job?.phase
          return finished || p === 'toolChange' || p === 'programPause'
        })
        if (finished) break
        const job = t.status().job!
        const which =
          job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
        // defaults: the run and the wait it is at (llm-api.md#a2-jobwait-at-operator-waits)
        expect(expectOk(await t.run('run.job.continue', {}))).toEqual({ jobId, ...which })
        await waitFor(() => finished || t.status().job?.phase === 'streaming')
      }
      return expectOk(await result) as { setupId: string; next?: object; lines: number }
    }
    const first = await runSetup(bottom!.id)
    expect(first.setupId).toBe(bottom!.id)
    expect(first.next).toEqual({
      setupId: top!.id,
      name: 'Top',
      direction: '+z',
      rotation: 0,
      corner: 'front left',
    })
    // the bottom program alone: fewer lines than the top's
    const second = await runSetup(top!.id)
    expect(second.setupId).toBe(top!.id)
    expect(second.next).toBeUndefined()
    expect(second.lines).toBeGreaterThan(first.lines)
  })

  it('connects without a plan (library machine): home, jog, travel refusal in words, zero (DF31, DF33)', async () => {
    const t = await setup()
    expectErrCode(
      await t.run('run.connection.open', { target: 'virtual', timeScale: 'max' }),
      'input.malformed',
    )
    expectErrCode(
      await t.run('run.connection.open', {
        target: 'virtual',
        machineId: 'machine-missing',
        timeScale: 'max',
      }),
      'input.malformed',
    )
    expectOk(
      await t.run('run.connection.open', {
        target: 'virtual',
        machineId: t.s.machineId,
        timeScale: 'max',
      }),
    )
    // the same identity as the plan's unchanged copy of that machine: its runs are allowed
    expect(t.client.machineKey).toBe(expectOk(machineKeyOf(t.s.d.doc, t.planId, 'test')))
    // powers up at the centre of the travel, reports the envelope from $$
    const travel = t.status().envelope?.travel
    expect(t.status().envelope).toMatchObject({ homingMask: 0, pullOff: 1, softLimits: true })
    expect(t.status().mpos).toEqual([-travel![0] / 2, -travel![1] / 2, -travel![2] / 2])
    expectOk(await (await t.job('run.machine.home', {})).result)
    expect(t.status().mpos).toEqual([-1, -1, -1])
    expectOk(await t.run('run.machine.jog', { by: [1, 0, 0], feed: 2000 }))
    const refused = expectErrCode(
      await t.run('run.machine.jog', { by: [1, 0, 0], feed: 2000 }),
      'run.travel',
    )
    expect(refused.message).toContain('X would leave the travel: max 0 mm')
    expect(refused.toJSON().frames[0]?.data).toMatchObject({ axis: 'x', target: 1, max: 0 })
    expect(await waitFor(() => t.status().state === 'Idle' && t.status().mpos[0] === 0)).toBe(true)
    expectOk(await t.run('run.machine.jog', { by: [-50, -20, -10], feed: 5000 }))
    expect(await waitFor(() => t.status().state === 'Idle' && t.status().mpos[0] === -50)).toBe(
      true,
    )
    const zero = expectOk(await t.run('run.workZero.set', { axes: ['x', 'y', 'z'] })) as {
      workZero: number[]
    }
    expect(zero.workZero).toEqual([-50, -21, -11])
    expect(t.status().wpos).toEqual([0, 0, 0])
  })

  it('an agent probes Z on the virtual machine and sets overrides (M4, M6)', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const before = t.status().workZero
    // the virtual plate lies on the stock top: the work zero comes back where prepare put it
    const r = expectOk(
      await (
        await t.job('run.machine.probeZ', { plateThickness: 10, feed: 500 })
      ).result,
    ) as { workZero: number[]; contact: number[] }
    expect(r.workZero[2]).toBeCloseTo(before[2], 3)
    expect(r.contact[2]).toBeCloseTo(before[2] + 10, 3)
    expect(t.status().mpos[2]).toBeCloseTo(before[2] + 12, 3)
    expectErrCode(await t.run('run.machine.probeZ', { plateThickness: 0 }), 'input.malformed')
    const ov = expectOk(await t.run('run.override.set', { rapid: 50, feed: '+10' })) as {
      overrides?: { rapid: number }
    }
    expect(ov.overrides?.rapid).toBe(50)
    expect(await waitFor(() => t.status().overrides?.rapid === 50)).toBe(true)
    expect(t.status().overrides?.feed).toBe(110)
    expectErrCode(await t.run('run.override.set', { rapid: 75 }), 'input.malformed')
    expectErrCode(await t.run('run.override.set', {}), 'input.malformed')
  })

  it('refuses a start that is not homed, a soft-limit violation and another machine copy', async () => {
    const t = await setup()
    expectOk(await t.open())
    let r = await t.job('run.job.start', { planId: t.planId })
    expect(expectErrCode(await r.result, 'run.state').toJSON().frames[0]?.data).toMatchObject({
      homed: false,
    })
    expectErrCode(await t.run('run.job.check', { planId: t.planId }), 'run.state')
    const home = await t.job('run.machine.home', {})
    expect(expectOk(await home.result)).toEqual({ workZero: [0, 0, 0] })
    // G54 at the home position: the part lies above the travel
    // (DF46) run.job.check says so first, without moving the machine
    const checked = expectOk(await t.run('run.job.check', { planId: t.planId })) as {
      findings: { rule: string }[]
    }
    expect(checked.findings.length).toBeGreaterThan(0)
    expect(checked.findings.every((f) => f.rule === 'softLimit')).toBe(true)
    r = await t.job('run.job.start', { planId: t.planId })
    const e = expectErrCode(await r.result, 'run.softLimit')
    expect((e.toJSON().frames[0]?.data as { findings: unknown[] }).findings.length).toBeGreaterThan(
      0,
    )
    // a plan with another machine copy
    const other = libraryInput(machineValues()) as { travel: object }
    const otherId = (
      (await t.s.run('library.machine.add', {
        values: { ...other, name: 'Other', travel: { ...other.travel, z: '90' } },
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

  it('run.job.check finds nothing at a work zero inside the travel (DF46)', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const r = expectOk(await t.run('run.job.check', { planId: t.planId })) as {
      setupId: string
      findings: unknown[]
    }
    expect(r.findings).toEqual([])
    expect(r.setupId).toBe(t.s.plan(t.planId).setups[0]!.id)
    expect(t.status().state).toBe('Idle')
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

  // DF78: docs/modes/alignment.md#run-the-alignment-step, #ticks-and-the-confirm-gate
  it('an agent runs the alignment step on the virtual machine; the start waits for it', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const setupId = t.s.plan(t.planId).setups[0]!.id
    expectErrCode(
      await t.run('run.align.goto', { planId: t.planId, setupId, to: 'zero' }),
      'run.state',
    )
    expectOk(
      await t.run(
        'plan.alignment.set',
        {
          planId: t.planId,
          setupId,
          points: [{ name: 'Back right', source: { corner: 'top back right' } }],
        },
        ui,
      ),
    )
    // the gate: a setup with points does not start before its step is confirmed
    let r = await t.job('run.job.start', { planId: t.planId })
    expect(expectErrCode(await r.result, 'run.state').issues[0]?.rule).toBe('alignmentPending')
    const none = expectErrCode(await t.run('run.align.tick', { confirm: true }), 'run.state')
    expect(none.issues[0]?.rule).toBe('noAlignment')
    const idleAt = (x: number, y: number) =>
      waitFor(() => {
        const s = t.status()
        return (
          s.state === 'Idle' && Math.abs(s.wpos[0] - x) < 0.01 && Math.abs(s.wpos[1] - y) < 0.01
        )
      })
    // the work zero first, then the point (next wraps)
    expect(
      expectOk(await t.run('run.align.goto', { planId: t.planId, setupId, to: 'zero' })),
    ).toEqual({ current: 'zero', target: [0, 0] })
    expect(await idleAt(0, 0)).toBe(true)
    expect(t.status().alignment).toMatchObject({ setupId, current: 'zero', confirmed: false })
    const point = t.status().alignment!.entries[1]!
    expect(point.name).toBe('Back right')
    const far = expectErrCode(await t.run('run.align.tick', { entry: point.id }), 'run.state')
    expect(far.issues[0]?.rule).toBe('notAtPoint')
    expectOk(await t.run('run.align.tick', { entry: 'zero' }))
    const next = expectOk(
      await t.run('run.align.goto', { planId: t.planId, setupId, to: 'next' }),
    ) as { current: string; target: [number, number] }
    expect(next.current).toBe(point.id)
    expect(await idleAt(...next.target)).toBe(true)
    // the pointer stays at the clearance height above the top
    expect(t.status().wpos[2]).toBeGreaterThan(0)
    expectOk(await t.run('run.align.tick', { entry: point.id }))
    expect(
      expectOk(await t.run('run.align.tick', { confirm: true })) as { confirmed: boolean },
    ).toMatchObject({ confirmed: true, skipped: [] })
    // a G54 X/Y change clears the ticks and the confirmation
    expectOk(
      await t.run('run.workZero.set', {
        axes: ['x', 'y'],
        values: [next.target[0] + 1, next.target[1], 0],
      }),
    )
    expect(await waitFor(() => t.status().alignment?.confirmed === false)).toBe(true)
    expect(t.status().alignment!.entries.every((e) => !e.ticked)).toBe(true)
    const unticked = expectErrCode(await t.run('run.align.tick', { confirm: true }), 'run.state')
    expect(unticked.issues[0]?.rule).toBe('unticked')
    expect(
      expectOk(await t.run('run.align.tick', { confirm: true, skipUnticked: true })),
    ).toMatchObject({ confirmed: true, skipped: ['zero', point.id] })
    // confirmed at this G54: the run starts
    r = await t.job('run.job.start', { planId: t.planId })
    let ended = false
    void r.result.then(() => (ended = true))
    expect(await waitFor(() => ended || t.status().job !== undefined)).toBe(true)
    if (!ended) expectOk(await t.run('job.abort', { jobId: r.jobId }))
    const outcome = await r.result
    if (outcome.isErr()) expect(outcome.unwrapErr().code).not.toBe('run.state')
  })

  it('job.pause holds, job.resume resumes, job.abort stops; close is refused while running', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    expectOk(await t.run('run.timeScale.set', { scale: 1 }))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    expectErrCode(await t.run('run.connection.close', {}), 'run.busy')
    expectErrCode(await t.run('run.job.continue', { jobId, toolChange: 1 }), 'run.state')
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

  it('a stopped run is resumed at its operation: waits at the tool, probe Z, runs to the end (M5, M7)', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const ops = t.s.plan(t.planId).setups[0]!.operations
    const full = expectOk(await t.run('plan.export', { planId: t.planId, target: '/x.nc' })) as {
      lines: number
    }
    // stop at the first tool change that waits: the run stopped in that tool's operation
    const first = await t.job('run.job.start', { planId: t.planId })
    for (;;) {
      // the manual spindle's speed prompts (M0) come first
      expect(await waitFor(() => /toolChange|programPause/.test(t.status().job?.phase ?? ''))).toBe(
        true,
      )
      if (t.status().job?.phase === 'toolChange') break
      expectOk(await t.run('run.job.continue', {}))
      await waitFor(() => t.status().job?.phase === 'streaming')
    }
    const waiting = t.status().job!
    expect(waiting.plan).toEqual({
      planId: t.planId,
      planName: t.s.plan(t.planId).name,
      setupId: t.s.plan(t.planId).setups[0]!.id,
      setupName: t.s.plan(t.planId).setups[0]!.name,
      setup: 1,
      setups: 1,
    })
    const stoppedIn = waiting.planOperationId!
    expect(ops.findIndex((o) => o.id === stoppedIn)).toBeGreaterThan(0)
    expectOk(await t.run('job.abort', { jobId: first.jobId }))
    expectErrCode(await first.result, 'op.aborted')
    expect(await waitFor(() => t.status().job === undefined)).toBe(true)
    expect(t.status().lastRun).toEqual({
      jobId: first.jobId,
      planId: t.planId,
      setupId: t.s.plan(t.planId).setups[0]!.id,
      outcome: 'stopped',
      planOperationId: stoppedIn,
    })
    // not an operation of the setup
    const bad = await t.job('run.job.start', { planId: t.planId, from: 'nope' })
    expect(expectErrCode(await bad.result, 'input.malformed').issues[0]?.rule).toBe(
      'unknownOperation',
    )
    // resume: the run waits at the operation's tool first, even if it is in the spindle
    const resumed = await t.job('run.job.start', { planId: t.planId, from: stoppedIn })
    let finished = false
    void resumed.result.then(() => (finished = true))
    expect(await waitFor(() => t.status().job?.phase === 'toolChange')).toBe(true)
    expect(t.status().lastRun).toBeUndefined()
    expect(t.status().job?.planOperationId).toBe(stoppedIn)
    const before = t.status().workZero
    // the virtual plate on the stock top, under the tool at the clearance height
    const probe = await t.job('run.machine.probeZ', { plateThickness: 5, feed: 500 })
    const probed = expectOk(await probe.result) as { workZero: number[] }
    expect(probed.workZero[2]).toBeCloseTo(before[2], 3)
    for (;;) {
      const job = t.status().job
      if (finished) break
      if (job?.phase === 'toolChange' || job?.phase === 'programPause') {
        expectOk(await t.run('run.job.continue', {}))
        await waitFor(() => finished || t.status().job?.phase === 'streaming')
      } else await waitFor(() => finished || t.status().job?.phase !== 'streaming', 5_000)
    }
    const summary = expectOk(await resumed.result) as { lines: number }
    expect(summary.lines).toBeLessThan(full.lines)
    expect(t.status().lastRun).toMatchObject({ jobId: resumed.jobId, outcome: 'done' })
    expect(t.status().lastRun?.planOperationId).toBeUndefined()
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

  it('a work zero moved during the export never streams: refused, or the job refuses', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const before = t.status().workZero
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    const moved = await t.run('run.workZero.set', { axes: ['z'], values: [0, 0, -150] })
    if (moved.isOk()) {
      // the change got in before the reservation: the host's re-check refuses the start
      expectErrCode(await result, 'run.state')
      return
    }
    expectErrCode(moved, 'run.busy')
    // the job streams with the G54 it was checked with
    expect(await waitFor(() => t.status().job !== undefined)).toBe(true)
    expect(t.status().workZero).toEqual(before)
    expectOk(await t.run('job.abort', { jobId }))
    expectErrCode(await result, 'op.aborted')
  })

  it('a job.abort while the start reply is on its way still stops the job (op.aborted)', async () => {
    // The host already streams; the abort lands before the client's startJob has resolved, so
    // before the job binds its controls. It was lost: the job ran on into its M0 pause and hung.
    let abortNow = async (_jobId: string): Promise<void> => {}
    const t = await setup({
      wrap: (c) =>
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'startJob')
              return async (...a: Parameters<MachineClient['startJob']>) => {
                const r = await target.startJob(...a)
                await abortNow(a[0])
                return r
              }
            const v = Reflect.get(target, key) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        }),
    })
    abortNow = async (jobId) => void expectOk(await t.run('job.abort', { jobId }))
    expectOk(await t.open({ prepare: true }))
    const { result } = await t.job('run.job.start', { planId: t.planId })
    expectErrCode(await result, 'op.aborted')
    expect(await waitFor(() => t.status().job === undefined)).toBe(true)
  })

  it('app quit (shutdown) stops a running job with the reset, then ends the host', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true, timeScale: 1 }))
    const { result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    await t.client.shutdown(3000)
    expectErrCode(await result, 'op.aborted')
    expect(t.status().connection.state).toBe('closed')
  })
})

describe('machine client', () => {
  it('a lost connection closes it; the next open starts a fresh host', async () => {
    let spawned = 0
    const client = new MachineClient({
      logLevel: 'warn',
      factory: (events) => {
        spawned++
        return {
          post: (raw) => {
            const m = raw as { type: string; requestId?: string }
            const send = (x: unknown) => queueMicrotask(() => events.message(x))
            if (m.type === 'init') send({ type: 'ready', protocol: 1 })
            if (m.type === 'connect') {
              send({
                type: 'reply',
                requestId: m.requestId,
                result: {
                  ok: true,
                  value: {
                    target: 'virtual',
                    version: '1.1h',
                    settings: {},
                    workZero: [0, 0, 0],
                    modes: [],
                    homed: true,
                  },
                },
              })
              send({ type: 'event', kind: 'connectionLost', data: { reason: 'cable' } })
            }
          },
          terminate: () => queueMicrotask(() => events.exit(null)),
        }
      },
    })
    clients.push(client)
    const target = { kind: 'virtual' as const, settings: {}, homing: true, timeScale: 1 as const }
    expectOk(await client.connect({ ...target, machineKey: 'k' }))
    await waitFor(() => client.status().connection.state === 'closed', 1000)
    expect(client.status().connection.state).toBe('closed')
    expect(client.target).toBeUndefined()
    // the windows learn that the machine was let go of without a reset (run-machine.md M2)
    expect(client.status().connection.lost).toEqual({ target: 'virtual' })
    const again = client.connect({ ...target, machineKey: 'k' })
    // the next connect clears it (this fake host then loses it again)
    expect(client.status().connection.lost).toBeUndefined()
    expectOk(await again)
    expect(spawned).toBe(2)
  })
})

describe('run commands on a serial target (loopback)', { timeout: 60_000 }, () => {
  const PATH = '/dev/cu.usbmodem1101'
  const serialOpen = (t: Awaited<ReturnType<typeof setup>>, over: object = {}, source = ui) =>
    t.run(
      'run.connection.open',
      { target: 'serial', path: PATH, planId: t.planId, ...over },
      source,
    )
  const finalize = async (t: Awaited<ReturnType<typeof setup>>) => {
    for (const status of ['settledDesign', 'finalized'])
      expectOk(await t.run('plan.status.set', { planId: t.planId, status }, ui))
  }

  it('lists ports for anyone; only the UI opens one', async () => {
    const t = await setup({ serial: (settings) => ({ emulator: { settings } }) })
    const { ports } = expectOk(await t.run('run.ports.scan', {})) as { ports: { path: string }[] }
    expect(ports[0]?.path).toBe(PATH)
    const denied = await serialOpen(t, {}, agent)
    expectErrCode(denied, 'permission.denied')
    expect(denied.unwrapErr().message).toContain('real machine')
    expect(t.status().connection.state).toBe('closed')
  })

  it('validates the serial arguments', async () => {
    const t = await setup({ serial: (settings) => ({ emulator: { settings } }) })
    const noPath = await t.run('run.connection.open', { target: 'serial', planId: t.planId }, ui)
    expectErrCode(noPath, 'input.malformed')
    expect(noPath.unwrapErr().issues[0]?.rule).toBe('required')
    const prepared = await serialOpen(t, { prepare: true })
    expectErrCode(prepared, 'input.malformed')
    expect(prepared.unwrapErr().issues[0]?.rule).toBe('virtualOnly')
  })

  it('a matching controller: settingsCheck matches; agents may only stop', async () => {
    const t = await setup({ serial: (settings) => ({ emulator: { settings } }) })
    const info = expectOk(await serialOpen(t)) as {
      target: string
      homed: boolean
      settingsCheck: { matches: boolean; against: string }
    }
    expect(info).toMatchObject({ target: 'serial', homed: false })
    expect(info.settingsCheck).toMatchObject({ matches: true, against: 'plan' })
    expect(t.status().connection).toMatchObject({
      target: 'serial',
      port: { path: PATH, baud: 115_200 },
    })
    // Q50: agents read status and stop; they do not move a real machine
    expectErrCode(await t.run('run.machine.home', {}), 'permission.denied')
    expectErrCode(await t.run('run.machine.unlock', {}), 'permission.denied')
    expectErrCode(await t.run('run.job.start', { planId: t.planId }), 'permission.denied')
    expectErrCode(await t.run('run.connection.close', {}), 'permission.denied')
    expectOk(await t.run('run.machine.jogCancel', {}))
    // probing and overrides move or speed up a real machine: the UI only (M4, M6)
    expectErrCode(await t.run('run.machine.probeZ', { plateThickness: 5 }), 'permission.denied')
    expectErrCode(await t.run('run.override.set', { feed: 'reset' }), 'permission.denied')
    expectErrCode(await t.run('run.override.set', { rapid: 100 }), 'permission.denied')
    // the alignment step's moves and ticks are the operator's on a real machine (Q64)
    const setupId = t.s.plan(t.planId).setups[0]!.id
    expectErrCode(
      await t.run('run.align.goto', { planId: t.planId, setupId, to: 'zero' }),
      'permission.denied',
    )
    expectErrCode(await t.run('run.align.tick', { confirm: true }), 'permission.denied')
    expect(
      expectOk(await t.run('run.override.set', { feed: '-10' }, ui)) as {
        overrides?: { feed: number }
      },
    ).toMatchObject({ overrides: { feed: 90 } })
    // a real machine runs finalized plans only
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    const draft = await t.d.job(jobId).unwrap().result
    expectErrCode(draft, 'plan.status')
    expectOk(await t.run('run.connection.close', {}, ui))
  })

  it('a differing controller: the connection opens, real runs are refused', async () => {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings: { ...settings, 130: 123 } } }),
    })
    const info = expectOk(await serialOpen(t)) as {
      settingsCheck: { matches: boolean; differences: { setting: string }[] }
    }
    expect(info.settingsCheck.matches).toBe(false)
    expect(info.settingsCheck.differences.map((d) => d.setting)).toEqual(['$130'])
    await finalize(t)
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    const r = await t.d.job(jobId).unwrap().result
    expectErrCode(r, 'run.state')
    expect(r.unwrapErr().issues[0]?.rule).toBe('settingsMismatch')
    expect(r.unwrapErr().message).toContain('$130')
    expectOk(await t.run('run.connection.close', {}, ui))
  })

  it('a real run needs homing in this connection and passes the soft-limit check (M2)', async () => {
    const t = await setup({ serial: (settings) => ({ emulator: { settings } }) })
    expectOk(await serialOpen(t))
    await finalize(t)
    const start = async () => {
      const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
        jobId: string
      }
      return t.d.job(jobId).unwrap().result
    }
    // never assumed homed on connect
    let r = await start()
    expect(expectErrCode(r, 'run.state').toJSON().frames[0]?.data).toMatchObject({ homed: false })
    // unlocking is not homing
    expectOk(await t.run('run.machine.unlock', {}, ui))
    r = await start()
    expect(expectErrCode(r, 'run.state').toJSON().frames[0]?.data).toMatchObject({ homed: false })
    const { jobId } = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(jobId).unwrap().result)
    // G54 at the home position: the program leaves the travel, refused before a line is sent
    r = await start()
    expectErrCode(r, 'run.softLimit')
    expect(t.status().job).toBeUndefined()
    expectOk(await t.run('run.connection.close', {}, ui))
  })

  it('homing off on the controller ($22=0) refuses real runs', async () => {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings, homing: false } }),
    })
    const info = expectOk(await serialOpen(t)) as {
      settingsCheck: { matches: boolean; homingEnabled: boolean }
    }
    expect(info.settingsCheck).toMatchObject({ matches: false, homingEnabled: false })
    await finalize(t)
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    const r = await t.d.job(jobId).unwrap().result
    expect(r.unwrapErr().message).toContain('$22=0')
    expectOk(await t.run('run.connection.close', {}, ui))
  })
})

// M8: the failure paths of a real run, end to end (commands → host → loopback controller), with
// the controller's clock at max. Spec: docs/modes/run-machine.md#fault-injection-m8
describe('fault injection on a real run (loopback, M8)', { timeout: 60_000 }, () => {
  const PATH = '/dev/cu.usbmodem1101'

  /** Opens the loopback port (UI), finalizes the plan, homes, places G54 and starts the run. */
  async function realRun(emulator: LoopbackOptions['emulator'] = {}) {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings, ...emulator }, timeScale: 'max' }),
    })
    expectOk(
      await t.run('run.connection.open', { target: 'serial', path: PATH, planId: t.planId }, ui),
    )
    for (const status of ['settledDesign', 'finalized'])
      expectOk(await t.run('plan.status.set', { planId: t.planId, status }, ui))
    const home = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(home.jobId).unwrap().result)
    const wz = expectOk(prepareWorkZero(t.s.d.doc, t.planId, 'test'))
    const m = t.status().mpos
    const values = [m[0] - wz[0], m[1] - wz[1], m[2] - wz[2]]
    expectOk(await t.run('run.workZero.set', { axes: ['x', 'y', 'z'], values }, ui))
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    const result = t.d.job(jobId).unwrap().result
    let settled: AppResult<unknown> | undefined
    void result.then((r) => (settled = r))
    const port = () => t.serial!.opened[0]!
    /** Continues every operator wait (manual spindle prompts, tool changes) until `until`. */
    const advance = async (until: () => boolean) => {
      for (;;) {
        const reached = await waitFor(() => {
          const p = t.status().job?.phase
          return until() || settled !== undefined || p === 'toolChange' || p === 'programPause'
        })
        expect(reached).toBe(true)
        if (until() || settled !== undefined) return
        const job = t.status().job!
        const which =
          job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
        expectOk(await t.run('run.job.continue', which, ui))
        await waitFor(() => settled !== undefined || t.status().job?.phase === 'streaming')
      }
    }
    /** Mid-run: right after the first operator wait is continued, the program streams again. */
    const streaming = async () => {
      const waits = () => {
        const p = t.status().job?.phase
        return p === 'toolChange' || p === 'programPause'
      }
      expect(await waitFor(() => settled !== undefined || waits())).toBe(true)
      expect(settled).toBeUndefined()
      const job = t.status().job!
      const which =
        job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
      expectOk(await t.run('run.job.continue', which, ui))
      expect(settled).toBeUndefined()
    }
    return { t, jobId, result, port, done: () => settled !== undefined, streaming, advance }
  }

  it('a pulled cable mid-run fails the job (machine.connection) and closes the connection', async () => {
    const r = await realRun()
    await r.streaming()
    r.port().unplug()
    expectErrCode(await r.result, 'machine.connection')
    expect(await waitFor(() => r.t.status().connection.state === 'closed')).toBe(true)
  })

  it('a controller that stops answering mid-run trips the watchdog', async () => {
    const r = await realRun()
    await r.streaming()
    r.port().emulator.setSilent(true)
    expectErrCode(await r.result, 'machine.connection')
    expect(await waitFor(() => r.t.status().connection.state === 'closed')).toBe(true)
  })

  it('a hard limit mid-run: ALARM:1 fails the job, the position counts as lost', async () => {
    const r = await realRun()
    await r.streaming()
    r.port().emulator.triggerHardLimit()
    const e = expectErrCode(await r.result, 'machine.alarm')
    expect(e.message).toContain('ALARM:1')
    expect(r.t.status()).toMatchObject({ homed: false, alarm: { code: 1 } })
    expect(r.t.status().job).toBeUndefined()
    // a real run is refused until the controller is reset and homed again
    const { jobId } = expectOk(await r.t.run('run.job.start', { planId: r.t.planId }, ui)) as {
      jobId: string
    }
    expectErrCode(await r.t.d.job(jobId).unwrap().result, 'run.state')
  })

  it('a probe miss at a tool change keeps the run waiting: unlock, probe again, continue', async () => {
    const r = await realRun()
    const { t } = r
    await r.advance(() => t.status().job?.phase === 'toolChange')
    expect(r.done()).toBe(false)
    const n = t.status().job!.toolChange!.n
    // no plate under the tool: ALARM:5
    const probe = (args: object) =>
      t.run('run.machine.probeZ', args, ui).then(async (started) => {
        if (started.isErr()) return started
        const { jobId } = started.unwrap() as { jobId: string }
        return t.d.job(jobId).unwrap().result
      })
    const miss = await probe({ plateThickness: 5, maxTravel: 2 })
    expect(expectErrCode(miss, 'machine.alarm').message).toContain('ALARM:5')
    expect(t.status()).toMatchObject({ homed: true, alarm: { code: 5 } })
    expect(t.status().job).toMatchObject({ phase: 'toolChange' })
    expectErrCode(await t.run('run.job.continue', { toolChange: n }, ui), 'run.state')
    expectOk(await t.run('run.machine.unlock', {}, ui))
    // the plate laid 3 mm below the tool
    const z = t.status().mpos[2]
    const before = t.status().workZero
    r.port().emulator.setProbePlate(z - 3)
    const probed = expectOk(await probe({ plateThickness: 5, feed: 500 })) as {
      workZero: number[]
    }
    expect(probed.workZero[2]).toBeCloseTo(z - 8, 3)
    expect(probed.workZero[0]).toBe(before[0])
    // continue every remaining wait: the run completes
    expectOk(await t.run('run.job.continue', { toolChange: n }, ui))
    await r.advance(() => false)
    expectOk(await r.result)
  })
})
