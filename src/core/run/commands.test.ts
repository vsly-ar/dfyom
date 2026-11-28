// Run commands with an in-process machine host (real timers, time scale max).
// Spec: docs/modes/run-v0.1.md#commands-and-queries, #run-job, #testing (Commands)
import { afterEach, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { fail, Ok, type AppResult } from '../../shared/result'
import type { ErrorCode } from '../../shared/errors/codes'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { agentSource, fakeIds, uiSource } from '../commands/testing'
import { deg, len, libraryInput, machineValues, num, rpm } from '../library/library.fixture'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { systemTimerHost } from './clock'
import { checkNoRunJob, prepareWorkZero } from './commands'
import { machineKeyOf } from './machine-key'
import { prepareGcodeFile } from './gcode-file'
import { runPlanHash } from './plan-hash'
import { runCutMarks } from './cut-marks'
import { topLevelUnits, unitOfOperation } from '../design/disabled'
import { MachineClient } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { MachineService, RunStatus } from './service'
import { loopbackSerialPorts, type LoopbackOptions } from './grbl/loopback.fixture'
import { machineSettings } from './grbl/emulator/settings'
import { Machine } from '../library/machine'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'

// core stays environment-neutral (no node: imports, eslint): the built-in fs as gcode-file.test.ts
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
  }
).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
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
    /** gCode files by path for file runs (DF93). */
    files?: ReadonlyMap<string, string>
    /** The 2D geometry port (chamfers, DF137). */
    region2d?: boolean
    /** DF135 C2's test seam: virtual runs count as real for the already-cut marks. */
    virtualCutMarks?: boolean
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
  /** The texts `plan.export` wrote, in order. */
  const written: string[] = []
  const client = new MachineClient({
    factory: inProcessHostFactory({
      timers: systemTimerHost,
      ...(serial === undefined ? {} : { serial }),
    }),
    logLevel: 'warn',
    ...(opts.virtualCutMarks === true ? { virtualCutMarks: true } : {}),
  })
  clients.push(client)
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: createInProcessWorkers(
        opts.region2d === true ? { region2d: () => Ok(region2d) } : {},
      ),
      ...(opts.region2d === true ? { region2d } : {}),
      library: s.library,
      toolpaths: createToolpathCache(),
      exportFiles: {
        write: async (target, text) => {
          written.push(text)
          return Ok({ filePath: target })
        },
      },
      gcodeFiles: {
        read: async (path: string) => {
          const text = opts.files?.get(path)
          return text === undefined
            ? fail('persist.io', 'no such file', { where: 'test' })
            : Ok(text)
        },
      },
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
  return { s, planId, d, client, run, status, job, open, serial, written }
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

  it('keeps the streamed program and estimates the executing line in the status (DF84)', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    const seen: NonNullable<RunStatus['job']>[] = []
    const off = t.client.onStatus((s) => void (s.job === undefined || seen.push(s.job)))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
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
      const which =
        job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
      expectOk(await t.run('run.job.continue', { jobId, ...which }))
      await waitFor(() => finished || t.status().job?.phase === 'streaming')
    }
    off()
    const summary = expectOk(await result) as { lines: number }
    // the program as streamed, kept after the run ended; only for its own job
    const program = t.client.program(jobId)!
    expect(program.lines).toHaveLength(summary.lines)
    expect(program.sections.length).toBeGreaterThan(0)
    expect(program.operations.length).toBeGreaterThan(0)
    expect(t.client.program('another')).toBeUndefined()
    // sent ≥ acknowledged, the estimate at or before the line being acknowledged, never back
    const estimated = seen.filter((j) => j.executing !== undefined)
    expect(estimated.length).toBeGreaterThan(3)
    let last = 0
    for (const j of seen) {
      expect(j).not.toHaveProperty('ackedAtReport')
      if (j.sent !== undefined) expect(j.sent).toBeGreaterThanOrEqual(j.line - 1)
      if (j.executing === undefined || j.line === 0) continue
      expect(j.executing).toBeLessThanOrEqual(j.line)
      expect(j.executing).toBeGreaterThanOrEqual(last)
      last = j.executing
    }
    expect(last).toBeGreaterThan(summary.lines / 2)
  })

  it('an already-cut pocket: Run streams exactly the export, no pocket moves (DF137, TG #454)', async () => {
    const t = await setup({ region2d: true })
    const { s } = t
    // the user's case: the pocket marked already cut in Design, a chamfer on its rim added
    expectOk(
      await t.run(
        'library.tool.add',
        {
          values: libraryInput({
            name: 'Chamfer 6',
            type: 'chamferMill',
            diameter: len('6'),
            angle: deg('90'),
            fluteLength: len('8'),
            overallLength: len('50'),
            fluteCount: num('2'),
            toolMaterial: 'carbide',
            presets: [],
          }),
        },
        ui,
      ),
    )
    expectOk(await t.run('design.part.update', { partId: s.partId, alreadyCut: ['pocket1'] }, ui))
    expectOk(
      await t.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: '1' }, ui),
    )
    expectOk(await t.run('project.apply', {}, ui))
    const plan = t.d.doc.plans[t.planId]!
    expect(plan.status).toBe('draft')
    const ops = plan.setups.flatMap((o) => o.operations)
    const pocket = ops.find((o) => o.designOperationIds.includes('pocket1'))!
    const chamfer = ops.find((o) => o.designOperationIds.includes('chamfer1'))!
    expect(chamfer).toBeDefined()
    expectOk(await t.open({ prepare: true }))
    expectOk(await t.run('plan.export', { planId: t.planId, target: '/x.nc' }))
    const exported = t.written.at(-1)!.split('\n')
    if (exported.at(-1) === '') exported.pop()
    expect(exported.some((l) => l.includes('Pocket 1'))).toBe(false)
    expect(exported.some((l) => l.includes('Chamfer 1'))).toBe(true)
    // the pre-flight (Start at, gCode before the start) reads the same lines
    const checked = expectOk(await t.run('run.job.check', { planId: t.planId, program: true })) as {
      program: { lines: string[]; points: { line: number; kind: string; label?: string }[] }
    }
    expect(checked.program.lines).toEqual(exported)
    expect(checked.program.points.some((p) => p.label?.includes('Pocket 1') === true)).toBe(false)
    // the run streams exactly the export
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
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
      const which =
        job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
      expectOk(await t.run('run.job.continue', { jobId, ...which }))
      await waitFor(() => finished || t.status().job?.phase === 'streaming')
    }
    expectOk(await result)
    const streamed = t.client.program(jobId)!
    expect(streamed.lines).toEqual(exported)
    const streamedOps = streamed.operations.map((o) => o.planOperationId)
    expect(streamedOps).not.toContain(pocket.id)
    expect(streamedOps).toContain(chamfer.id)
    // TG #456: the program's tools are the uncut operations' only (the pocket's end mill is
    // called only when an uncut operation uses it too)
    const tools = streamed.lines.filter((l) => /^\(Tool \d+:/.test(l))
    const uncut = new Set(ops.filter((o) => o.id !== pocket.id).map((o) => o.tool))
    expect(tools).toHaveLength(uncut.size)
    expect(streamed.lines.filter((l) => /^M0 ;.*install T/.test(l)).length).toBeLessThanOrEqual(
      uncut.size,
    )
    // Start at's points are the program's lines (no pocket section)
    for (const p of checked.program.points) expect(p.line).toBeLessThanOrEqual(exported.length)
    // a resume at the cut pocket is refused: it is not in the program
    expectErrCode(
      await (
        await t.job('run.job.start', { planId: t.planId, from: pocket.id })
      ).result,
      'input.malformed',
    )
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
    // DF85: a target percent, reached in coarse and fine steps and read back from `Ov`
    for (const [feed, spindle] of [
      [137, 63],
      [200, 10],
      [10, 199],
      [100, 100],
    ] as const) {
      const to = expectOk(await t.run('run.override.set', { feed, spindle })) as {
        overrides?: { feed: number; spindle: number }
      }
      expect(to.overrides).toMatchObject({ feed, spindle })
    }
    const out = await t.run('run.override.set', { feed: 201 })
    expect(expectErrCode(out, 'input.malformed').issues[0]?.rule).toBe('overrideRange')
    expectErrCode(await t.run('run.override.set', { spindle: 9 }), 'input.malformed')
  })

  it("refuses a spindle override below the spindle's minimum speed for the programmed S (DF86)", async () => {
    // the program streaming S 18000 (a status with a run job; the floor is 6200 / 18000 → 35 %)
    let programmed: number | undefined = 18000
    const t = await setup({
      wrap: (c) =>
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'status')
              return () => {
                const s = target.status()
                return programmed === undefined
                  ? s
                  : {
                      ...s,
                      job: {
                        jobId: 'run-x',
                        phase: 'streaming',
                        line: 10,
                        startedAt: '2026-11-24T10:00:00.000Z',
                        elapsedSeconds: 1,
                        programmed: { feed: 1000, spindle: programmed },
                      },
                    }
              }
            const v = Reflect.get(target, key) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        }),
    })
    const { kind: _, ...m } = machineValues()
    const { id } = (await t.s.run('library.machine.add', {
      values: libraryInput({
        ...m,
        spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('6200') },
      }),
    })) as { id: string }
    expectOk(
      await t.run('run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' }),
    )
    // the connection keeps the machine's minimum speed
    expect(t.client.spindleMinSpeed).toBe(6200)
    const low = expectErrCode(await t.run('run.override.set', { spindle: 34 }), 'input.malformed')
    expect(low.issues[0]).toMatchObject({ path: ['spindle'], rule: 'overrideRange' })
    expect(low.issues[0]?.message).toMatch(/minSpeed 6200 rpm/)
    // the UI is held to it too
    expectErrCode(await t.run('run.override.set', { spindle: 20 }, ui), 'input.malformed')
    const at = expectOk(await t.run('run.override.set', { spindle: 35 })) as {
      overrides?: { spindle: number }
    }
    expect(at.overrides?.spindle).toBe(35)
    expect(await waitFor(() => t.status().overrides?.spindle === 35)).toBe(true)
    // a step below the floor from the reported value is refused; up is fine
    expectErrCode(await t.run('run.override.set', { spindle: '-1' }), 'input.malformed')
    expectErrCode(await t.run('run.override.set', { spindle: '-10' }), 'input.malformed')
    expectOk(await t.run('run.override.set', { spindle: '+1' }))
    // spindle off (S 0) or no run: GRBL's range only
    programmed = 0
    expectOk(await t.run('run.override.set', { spindle: 10 }))
    programmed = undefined
    expectOk(await t.run('run.override.set', { spindle: 20, feed: 10 }))
  })

  it('RV7: run.workArea.set writes the library machine and the open connection follows', async () => {
    const t = await setup()
    const { kind: _, ...m } = machineValues()
    const { id, revision } = (await t.s.run('library.machine.add', {
      values: libraryInput({ ...m, name: 'Marked' }),
    })) as { id: string; revision: number }
    expectOk(
      await t.run('run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' }),
    )
    expect(t.client.libraryMachineId).toBe(id)
    expectOk(await t.run('run.machine.home', {}))
    expect(t.status().envelope?.workArea).toBeUndefined()
    const set = expectOk(
      await t.run(
        'run.workArea.set',
        { machineId: id, revision, marks: { x: { min: -700, max: -10 } }, margin: 3 },
        ui,
      ),
    ) as { revision: number }
    expect(set.revision).toBe(revision + 1)
    const found = t.s.library.lookup('machine', id)
    const saved = found.state === 'found' ? (found.item.values as Machine) : undefined
    expect(saved?.usableTravel('x')).toBeCloseTo(684, 6)
    expect(await waitFor(() => t.status().envelope?.workArea !== undefined)).toBe(true)
    expect(t.status().envelope?.workArea?.min[0]).toBeCloseTo(-697, 6)
    expect(t.status().envelope?.workArea?.max[0]).toBeCloseTo(-13, 6)
    // a stale revision is a conflict; crossed marks are the model's invariant
    expectErrCode(
      await t.run('run.workArea.set', { machineId: id, revision, marks: null }, ui),
      'command.conflict',
    )
    expectErrCode(
      await t.run(
        'run.workArea.set',
        { machineId: id, revision: set.revision, marks: { y: { min: -5, max: -50 } } },
        ui,
      ),
      'model.invariant',
    )
    // reconnecting reads it from the library again
    expectOk(await t.run('run.connection.close', {}))
    expectOk(
      await t.run('run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' }),
    )
    expectOk(await t.run('run.machine.home', {}))
    expect(await waitFor(() => t.status().envelope?.workArea?.max[0] === -13)).toBe(true)
    // cleared: gone from the library and the connection
    expectOk(
      await t.run('run.workArea.set', { machineId: id, revision: set.revision, marks: null }, ui),
    )
    expect(await waitFor(() => t.status().envelope?.workArea === undefined)).toBe(true)
  })

  it('RV1: the spindle from Run: on in Idle only, the speed in a jog by override, off cancels a jog first', async () => {
    const t = await setup()
    const { kind: _, ...m } = machineValues()
    const { id } = (await t.s.run('library.machine.add', {
      values: libraryInput({
        ...m,
        name: 'Router',
        spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('6200') },
      }),
    })) as { id: string }
    // no homing: Idle at once; real time, so a slow continuous jog is still jogging
    expectOk(
      await t.run('run.connection.open', {
        target: 'virtual',
        machineId: id,
        homing: false,
        timeScale: 1,
      }),
    )
    // v0.5 RV2: the virtual machine's $$ for the controller settings table
    const all = expectOk(t.d.query('run.settings.check', {}, ui)).value as {
      settings?: Record<string, number>
    }
    expect(all.settings?.['22']).toBeDefined()
    const rule = (r: AppResult<unknown>, code: ErrorCode) => expectErrCode(r, code).issues[0]?.rule
    expect(
      rule(await t.run('run.machine.spindle', { on: true, rpm: 5000 }), 'input.malformed'),
    ).toBe('spindleRange')
    expectErrCode(await t.run('run.machine.spindle', { on: true }), 'input.malformed')
    const on = expectOk(await t.run('run.machine.spindle', { on: true, rpm: 12000 })) as {
      spindle: number
    }
    expect(on.spindle).toBe(12000)
    expect(await waitFor(() => t.status().spindleDirection === 'cw')).toBe(true)
    expect(t.status().manualSpindle).toEqual({ rpm: 12000 })
    // Home is refused while it turns
    expect(rule(await (await t.job('run.machine.home', {})).result, 'run.state')).toBe('spindleOn')
    // a jog with the spindle on: the speed changes through the override (150 % of S 12000)
    expectOk(await t.run('run.machine.jog', { by: [-1, 0, 0], feed: 300, continuous: true }))
    expect(await waitFor(() => t.status().state === 'Jog')).toBe(true)
    expectOk(await t.run('run.machine.spindle', { on: true, rpm: 18000 }))
    expect(await waitFor(() => t.status().spindle === 18000)).toBe(true)
    expect(t.status().overrides?.spindle).toBe(150)
    expect(t.status().state).toBe('Jog')
    expect(
      rule(await t.run('run.machine.spindle', { on: true, rpm: 30000 }), 'input.malformed'),
    ).toBe('spindleRange')
    // off during the jog: the jog is cancelled, then M5
    const off = expectOk(await t.run('run.machine.spindle', { on: false })) as { spindle: number }
    expect(off.spindle).toBe(0)
    expect(t.status().state).toBe('Idle')
    expect(t.status().manualSpindle).toBeUndefined()
    expect(await waitFor(() => t.status().spindleDirection === undefined)).toBe(true)
    // on while jogging (spindle off): refused with the reason; the jog goes on
    expectOk(await t.run('run.machine.jog', { by: [-1, 0, 0], feed: 300, continuous: true }))
    expect(await waitFor(() => t.status().state === 'Jog')).toBe(true)
    const refused = expectErrCode(
      await t.run('run.machine.spindle', { on: true, rpm: 12000 }),
      'run.state',
    )
    expect(refused.issues[0]?.rule).toBe('spindleNotIdle')
    expect(refused.message).toContain('stop the jog first')
    expect(t.status().state).toBe('Jog')
    expectOk(await t.run('run.machine.jogCancel', {}))
    expect(await waitFor(() => t.status().state === 'Idle')).toBe(true)
    // on again in Idle: the override left at 150 % goes back to 100 %, so 9000 rpm turns
    expectOk(await t.run('run.machine.spindle', { on: true, rpm: 9000 }))
    expect(await waitFor(() => t.status().spindle === 9000)).toBe(true)
    expect(t.status().overrides?.spindle).toBe(100)
    expectOk(await t.run('run.machine.spindle', { on: false }))
    expect(t.status().spindle).toBe(0)
    // off when off: harmless
    expectOk(await t.run('run.machine.spindle', { on: false }))
  })

  it('RV1: a manual spindle has no spindle control; run.machine.spindle is no agent tool', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    expect(
      expectErrCode(await t.run('run.machine.spindle', { on: true, rpm: 12000 }), 'run.state')
        .issues[0]?.rule,
    ).toBe('manualSpindle')
    // off has no machine check
    expectOk(await t.run('run.machine.spindle', { on: false }))
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

  it('run.job.check { program: true } returns the checked program and its resume points (DF129 RC3)', async () => {
    const file = '/files/fusion-grbl.nc'
    const text = fs.readFileSync(new URL('./__fixtures__/fusion-grbl.nc', import.meta.url), 'utf8')
    const t = await setup({ files: new Map([[file, text]]) })
    expectOk(await t.open({ prepare: true }))
    type Checked = {
      program?: {
        lines: string[]
        sections: { fromLine: number; label: string }[]
        points: { line: number; kind: string; label?: string }[]
      }
    }
    const plain = expectOk(await t.run('run.job.check', { planId: t.planId })) as Checked
    expect(plain.program).toBeUndefined()
    const full = expectOk(await t.run('plan.export', { planId: t.planId, target: '/x.nc' })) as {
      lines: number
    }
    const r = expectOk(await t.run('run.job.check', { planId: t.planId, program: true })) as Checked
    expect(r.program!.lines).toHaveLength(full.lines)
    expect(r.program!.sections.length).toBeGreaterThan(0)
    const points = r.program!.points
    expect(points[0]).toMatchObject({ kind: 'operation', label: expect.any(String) })
    expect(points.some((p) => p.kind === 'pass')).toBe(true)
    // each point is a line a check accepts as it is
    const pass = points.find((p) => p.kind === 'pass')!
    const at = expectOk(
      await t.run('run.job.check', { planId: t.planId, fromLine: pass.line, program: true }),
    ) as Checked & { resume: { fromLine: number } }
    expect(at.resume.fromLine).toBe(pass.line)
    expect(at.program!.points).toEqual(points)
    // a file: its prepared lines and points
    const f = expectOk(await t.run('run.job.check', { file, program: true })) as Checked
    expect(f.program!.lines).toEqual(prepareGcodeFile(text).lines)
    expect(f.program!.points.filter((p) => p.kind === 'operation')).toHaveLength(2)
  })

  it('starts a plan and a file at a line after a lead-in; refused when the program changed (DF129 RC2)', async () => {
    const file = '/files/fusion-grbl.nc'
    const text = fs.readFileSync(new URL('./__fixtures__/fusion-grbl.nc', import.meta.url), 'utf8')
    const t = await setup({ files: new Map([[file, text]]) })
    expectOk(await t.open({ prepare: true }))
    const full = expectOk(await t.run('plan.export', { planId: t.planId, target: '/x.nc' })) as {
      lines: number
    }
    type Check = {
      findings: unknown[]
      resume: { fromLine: number; programHash: string; leadIn: string[]; before?: number }
    }
    // the last line snaps back to the last resume point; then a check right there
    const last = expectOk(
      await t.run('run.job.check', { planId: t.planId, fromLine: full.lines }),
    ) as Check
    const at = last.resume.before!
    const check = expectOk(
      await t.run('run.job.check', { planId: t.planId, fromLine: at }),
    ) as Check
    expect(check.findings).toEqual([])
    expect(check.resume).toMatchObject({ fromLine: at, before: at })
    expect(check.resume.leadIn).toContain('M5')
    expect(check.resume.leadIn.some((l) => l.startsWith('(DFYOM TOOL CHANGE'))).toBe(true)
    // from and fromLine together; a plan changed since: refused before anything moves
    const ops = t.s.plan(t.planId).setups[0]!.operations
    expect(
      expectErrCode(
        await t.run('run.job.check', { planId: t.planId, fromLine: 0 }),
        'input.malformed',
      ).issues[0]?.rule,
    ).toBe('range')
    const both = await t.job('run.job.start', { planId: t.planId, from: ops[0]!.id, fromLine: at })
    expect(expectErrCode(await both.result, 'input.malformed').issues[0]?.rule).toBe('oneOf')
    const changed = await t.job('run.job.start', {
      planId: t.planId,
      fromLine: at,
      programHash: '0'.repeat(64),
    })
    expect(expectErrCode(await changed.result, 'input.malformed').issues[0]?.rule).toBe(
      'programChanged',
    )
    expect(t.status().job).toBeUndefined()
    // the run: lead-in (waits at the tool), then the program from the line on, to the end
    const runToEnd = async (args: object) => {
      const { result } = await t.job('run.job.start', args)
      let finished = false
      void result.then(() => (finished = true))
      let toolChanges = 0
      for (;;) {
        expect(
          await waitFor(
            () => finished || /toolChange|programPause/.test(t.status().job?.phase ?? ''),
          ),
        ).toBe(true)
        if (finished) break
        if (t.status().job?.phase === 'toolChange') toolChanges++
        expectOk(await t.run('run.job.continue', {}))
        await waitFor(() => finished || t.status().job?.phase === 'streaming')
      }
      return { summary: expectOk(await result) as { lines: number }, toolChanges }
    }
    const plan = await runToEnd({
      planId: t.planId,
      fromLine: at,
      programHash: check.resume.programHash,
    })
    expect(plan.toolChanges).toBeGreaterThan(0)
    expect(plan.summary.lines).toBe(check.resume.leadIn.length + full.lines - at + 1)
    expect(t.status().state).toBe('Idle')
    // a file (Q170): the second tool's operation start
    const fileLines = prepareGcodeFile(text).lines.length
    const fileCheck = expectOk(await t.run('run.job.check', { file, fromLine: fileLines })) as Check
    expect(fileCheck.findings).toEqual([])
    const fileAt = fileCheck.resume.before!
    const changedFile = await t.job('run.job.start', { file, fromLine: fileAt, programHash: 'x' })
    expect(expectErrCode(await changedFile.result, 'input.malformed').issues[0]?.message).toMatch(
      /file changed/,
    )
    const fileRun = await runToEnd({ file, fromLine: fileAt })
    expect(fileRun.toolChanges).toBe(1)
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

  it('job.pause of a run is paused only once the controller reports Hold:0, never while decelerating (DF82)', async () => {
    const t = await setup()
    expectOk(await t.open({ prepare: true }))
    expectOk(await t.run('run.timeScale.set', { scale: 1 }))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    const handle = t.d.job(jobId).unwrap()
    expect(handle.pausable).toBe(true)
    // the spindle runs up before the first move: hold once the machine moves
    expect(await waitFor(() => t.status().state === 'Run' && t.status().feed > 0)).toBe(true)
    // every status the machine reports while job.pause is pending: the job is never paused then
    const seen: { state: string; job: string }[] = []
    const off = t.client.onStatus((s) => seen.push({ state: s.state, job: handle.state }))
    const paused = expectOk(await t.run('job.pause', { jobId }))
    off()
    expect(paused).toEqual({ state: 'paused' })
    expect(handle.state).toBe('paused')
    expect(t.status().state).toBe('Hold:0')
    expect(t.status().job?.phase).toBe('held')
    for (const s of seen) if (s.state !== 'Hold:0') expect(s.job).toBe('running')
    // job.pause again is a no-op; job.resume is a cycle start
    expectOk(await t.run('job.pause', { jobId }))
    expectOk(await t.run('job.resume', { jobId }))
    expect(handle.state).toBe('running')
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    expect(await waitFor(() => t.status().state === 'Run')).toBe(true)
    expectOk(await t.run('run.timeScale.set', { scale: 'max' }))
    expectOk(await t.run('job.abort', { jobId }))
    expectErrCode(await result, 'op.aborted')
  })

  it('job.pause before the stream starts parks the run before anything moves; resume starts it (DF82)', async () => {
    let pausing: Promise<AppResult<unknown>> | undefined
    let pauseNow: (jobId: string) => void = () => {}
    const t = await setup({
      wrap: (c) =>
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'reserve')
              return (jobId: string) => {
                const r = target.reserve(jobId)
                // while the program is exported (the job prepares, nothing streams yet)
                pauseNow(jobId)
                return r
              }
            const v = Reflect.get(target, key) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        }),
    })
    pauseNow = (jobId) => {
      pausing = t.run('job.pause', { jobId })
    }
    expectOk(await t.open({ prepare: true }))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => pausing !== undefined)).toBe(true)
    expect(expectOk(await pausing!)).toEqual({ state: 'paused' })
    // parked: the export finishes, but the stream waits for job.resume
    await sleep(300)
    expect(t.d.job(jobId).unwrap().state).toBe('paused')
    expect(t.status().job).toBeUndefined()
    expect(t.status().state).toBe('Idle')
    expectOk(await t.run('job.resume', { jobId }))
    expect(await waitFor(() => t.status().job?.jobId === jobId)).toBe(true)
    expectOk(await t.run('job.abort', { jobId }))
    expectErrCode(await result, 'op.aborted')
  })

  it('job.abort of a run parked before its stream ends it without moving (DF82)', async () => {
    let pausing: Promise<AppResult<unknown>> | undefined
    let pauseNow: (jobId: string) => void = () => {}
    const t = await setup({
      wrap: (c) =>
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'reserve')
              return (jobId: string) => {
                const r = target.reserve(jobId)
                pauseNow(jobId)
                return r
              }
            const v = Reflect.get(target, key) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        }),
    })
    pauseNow = (jobId) => {
      pausing = t.run('job.pause', { jobId })
    }
    expectOk(await t.open({ prepare: true }))
    const { jobId, result } = await t.job('run.job.start', { planId: t.planId })
    expect(await waitFor(() => pausing !== undefined)).toBe(true)
    expectOk(await pausing!)
    expectOk(await t.run('job.abort', { jobId }))
    expectErrCode(await result, 'op.aborted')
    expect(t.status().job).toBeUndefined()
    expect(t.status().state).toBe('Idle')
    // the reservation is released: the machine takes commands again
    expectOk(await t.run('run.machine.jog', { by: [0, 0, -1], feed: 300 }, ui))
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
      planHash: runPlanHash(t.s.plan(t.planId), t.s.plan(t.planId).setups[0]!.id),
      operations: ops.map((o) => o.id),
      // DF135 C2: the operations before the one it stopped in (cut-state.md#marking)
      finished: ops
        .slice(
          0,
          ops.findIndex((o) => o.id === stoppedIn),
        )
        .map((o) => o.id),
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
    // DF135 C2: the resumed run keeps what the stopped one finished; the virtual machine is no
    // real run, so nothing is marked
    expect(t.status().lastRun?.finished).toEqual(ops.map((o) => o.id))
    expect(t.status().lastRun?.real).toBeUndefined()
    const part = t.s.d.doc.parts[t.s.partId]!
    expect(runCutMarks(t.status().lastRun, t.s.plan(t.planId), part)).toEqual({
      kind: 'none',
      reason: 'notReal',
    })
  })

  it('DF135 C2 test seam: with virtualCutMarks a virtual run to the end counts as real', async () => {
    const t = await setup({ virtualCutMarks: true })
    expectOk(await t.open({ prepare: true }))
    const run = await t.job('run.job.start', { planId: t.planId })
    let finished = false
    void run.result.then(() => (finished = true))
    for (;;) {
      const waiting = () => /toolChange|programPause/.test(t.status().job?.phase ?? '')
      expect(await waitFor(() => finished || waiting())).toBe(true)
      if (finished) break
      const job = t.status().job!
      const which =
        job.phase === 'toolChange' ? { toolChange: job.toolChange!.n } : { pause: job.pause! }
      expectOk(await t.run('run.job.continue', { jobId: run.jobId, ...which }))
      await waitFor(() => finished || t.status().job?.phase === 'streaming')
    }
    expectOk(await run.result)
    const plan = t.s.plan(t.planId)
    const last = t.status().lastRun!
    expect(last).toMatchObject({ outcome: 'done', real: true })
    expect(last.finished).toEqual(plan.setups[0]!.operations.map((o) => o.id))
    expect(runCutMarks(last, plan, t.s.d.doc.parts[t.s.partId]!).kind).toBe('mark')
  })

  it('a run stopped, the plan edited and finalized again, resumes from the current plan (DF85)', async () => {
    const programs: string[][] = []
    const t = await setup({
      wrap: (c) =>
        new Proxy(c, {
          get: (target, key) => {
            if (key === 'startJob')
              return async (...a: Parameters<MachineClient['startJob']>) => {
                programs.push([...a[1].lines])
                return target.startJob(...a)
              }
            const v = Reflect.get(target, key) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        }),
    })
    const plan = () => t.d.doc.plans[t.planId]!
    const setupId = plan().setups[0]!.id
    for (const status of ['settledDesign', 'finalized'])
      expectOk(await t.run('plan.status.set', { planId: t.planId, status }, ui))
    expectOk(await t.open({ prepare: true }))
    const first = await t.job('run.job.start', { planId: t.planId })
    // stop at the first tool change that waits
    for (;;) {
      expect(await waitFor(() => /toolChange|programPause/.test(t.status().job?.phase ?? ''))).toBe(
        true,
      )
      if (t.status().job?.phase === 'toolChange') break
      expectOk(await t.run('run.job.continue', {}))
      await waitFor(() => t.status().job?.phase === 'streaming')
    }
    const stoppedIn = t.status().job!.planOperationId!
    expectOk(await t.run('job.abort', { jobId: first.jobId }))
    expectErrCode(await first.result, 'op.aborted')
    expect(await waitFor(() => t.status().job === undefined)).toBe(true)
    const last = t.status().lastRun!
    expect(last.planHash).toBe(runPlanHash(plan(), setupId))
    // finalized is read-only: back to Settled design, fix the stopped operation's feeds,
    // finalize again
    expectErrCode(
      await t.run(
        'plan.operation.update',
        {
          planId: t.planId,
          planOperationId: stoppedIn,
          overrides: { feedRate: '137', plungeRate: '137' },
        },
        ui,
      ),
      'plan.status',
    )
    expectOk(await t.run('plan.status.set', { planId: t.planId, status: 'settledDesign' }, ui))
    expectOk(
      await t.run(
        'plan.operation.update',
        {
          planId: t.planId,
          planOperationId: stoppedIn,
          overrides: { feedRate: '137', plungeRate: '137' },
        },
        ui,
      ),
    )
    expectOk(await t.run('plan.status.set', { planId: t.planId, status: 'finalized' }, ui))
    // the stopped operation keeps its id; the plan's hash says it changed
    expect(plan().setups[0]!.operations.some((o) => o.id === stoppedIn)).toBe(true)
    expect(runPlanHash(plan(), setupId)).not.toBe(last.planHash)
    // status changes alone do not count as a change
    const hashNow = runPlanHash(plan(), setupId)
    expectOk(await t.run('plan.status.set', { planId: t.planId, status: 'settledDesign' }, ui))
    expect(runPlanHash(plan(), setupId)).toBe(hashNow)
    expectOk(await t.run('plan.status.set', { planId: t.planId, status: 'finalized' }, ui))
    // the resume is exported from the plan as it is now: the stopped operation at F137
    const resumed = await t.job('run.job.start', { planId: t.planId, from: stoppedIn })
    expect(await waitFor(() => t.status().job?.phase === 'toolChange')).toBe(true)
    const program = programs.at(-1)!
    expect(programs.length).toBe(2)
    expect(program.some((l) => /F137\b/.test(l))).toBe(true)
    expect(programs[0]!.some((l) => /F137\b/.test(l))).toBe(false)
    expectOk(await t.run('job.abort', { jobId: resumed.jobId }))
    expectErrCode(await resumed.result, 'op.aborted')
    expect(await waitFor(() => t.status().lastRun?.jobId === resumed.jobId)).toBe(true)
    expect(t.status().lastRun?.planHash).toBe(runPlanHash(plan(), setupId))
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

  it('an open right after a close starts a fresh host, not the one still exiting', async () => {
    // A worker or utility process ends some time after `terminate` (late under load). The next
    // connect went to that host, which answered nothing and then exited: "the machine host
    // exited" (seen in the split exit criteria, open/close per piece).
    let spawned = 0
    const client = new MachineClient({
      logLevel: 'warn',
      factory: (events) => {
        spawned++
        let dead = false
        return {
          post: (raw) => {
            if (dead) return
            const m = raw as { type: string; requestId?: string }
            const send = (x: unknown) => queueMicrotask(() => events.message(x))
            const reply = (value: unknown) =>
              send({ type: 'reply', requestId: m.requestId, result: { ok: true, value } })
            if (m.type === 'init') send({ type: 'ready', protocol: 1 })
            if (m.type === 'disconnect') reply(null)
            if (m.type === 'connect')
              reply({
                target: 'virtual',
                version: '1.1h',
                settings: {},
                workZero: [0, 0, 0],
                modes: [],
                homed: true,
              })
          },
          terminate: () => {
            dead = true
            setTimeout(() => events.exit(0), 20)
          },
        }
      },
    })
    clients.push(client)
    const target = { kind: 'virtual' as const, settings: {}, homing: true, timeScale: 1 as const }
    expectOk(await client.connect({ ...target, machineKey: 'k' }))
    expectOk(await client.disconnect())
    expectOk(await client.connect({ ...target, machineKey: 'k' }))
    expect(spawned).toBe(2)
    expect(client.status().connection.state).toBe('open')
    // the first host's exit, arriving now, leaves the new connection alone
    await sleep(40)
    expect(client.status().connection.state).toBe('open')
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
    // DF85: a target through the loopback serial line, an agent's refused
    expectErrCode(await t.run('run.override.set', { feed: 120 }), 'permission.denied')
    expect(
      expectOk(await t.run('run.override.set', { feed: 153 }, ui)) as {
        overrides?: { feed: number }
      },
    ).toMatchObject({ overrides: { feed: 153 } })
    // a real machine runs finalized plans only
    const { jobId } = expectOk(await t.run('run.job.start', { planId: t.planId }, ui)) as {
      jobId: string
    }
    const draft = await t.d.job(jobId).unwrap().result
    expectErrCode(draft, 'plan.status')
    expectOk(await t.run('run.connection.close', {}, ui))
  })

  it('RV1: spindle off during a jog over the serial line: 0x85 first, M5 only once Idle; UI only', async () => {
    const t = await setup({
      serial: (settings) => ({
        emulator: { settings: { ...settings, 30: 24000, 31: 6200 }, trace: true },
        timeScale: 4,
      }),
    })
    const { kind: _, ...m } = machineValues()
    const { id } = (await t.s.run('library.machine.add', {
      values: libraryInput({
        ...m,
        name: 'Router',
        spindle: { control: 'gcode', maxSpeed: rpm('24000'), minSpeed: rpm('6200') },
      }),
    })) as { id: string }
    expectOk(
      await t.run('run.connection.open', { target: 'serial', path: PATH, machineId: id }, ui),
    )
    const { jobId } = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(jobId).unwrap().result)
    expect(await waitFor(() => t.status().homed && t.status().state === 'Idle')).toBe(true)
    // Q50: an agent may not start the spindle of a real machine
    expectErrCode(await t.run('run.machine.spindle', { on: true, rpm: 12000 }), 'permission.denied')
    expectOk(await t.run('run.machine.spindle', { on: true, rpm: 12000 }, ui))
    expect(t.status().spindle).toBe(12000)
    expectOk(await t.run('run.machine.jog', { by: [0, 0, -1], feed: 100, continuous: true }, ui))
    expect(await waitFor(() => t.status().state === 'Jog')).toBe(true)
    expectOk(await t.run('run.machine.spindle', { on: false }, ui))
    expect(t.status()).toMatchObject({ state: 'Idle', spindle: 0 })
    const port = t.serial!.opened[0]!
    const m5 = port.emulator.trace.lines.filter((l) => l.text === 'M5')
    // GRBL took it (error:9 in Jog would have failed the command)
    expect(m5.map((l) => l.response)).toEqual(['ok'])
    const text = String.fromCharCode(...port.written)
    expect(text.lastIndexOf('\x85')).toBeLessThan(text.lastIndexOf('M5'))
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

  it('the settings check is asked again after the library machine changed (DF87)', async () => {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings: { ...settings, 110: 1234 } } }),
    })
    const byMachine = { machineId: t.s.machineId }
    // none without a serial connection
    expect(expectOk(t.d.query('run.settings.check', byMachine, ui)).value).toEqual({})
    const info = expectOk(await serialOpen(t, { planId: undefined, ...byMachine })) as {
      settingsCheck: { matches: boolean; against: string }
    }
    expect(info.settingsCheck).toMatchObject({ matches: false, against: 'machine' })
    const before = expectOk(t.d.query('run.settings.check', byMachine, ui)).value as {
      settingsCheck: { matches: boolean; differences: { setting: string }[] }
    }
    expect(before.settingsCheck.differences.map((d) => d.setting)).toEqual(['$110'])
    // v0.5 RV2: the whole $$ comes with it, also without a machine to compare with
    const all = expectOk(t.d.query('run.settings.check', {}, ui)).value as {
      settings: Record<string, number>
      settingsCheck?: unknown
    }
    expect(all.settings['110']).toBe(1234)
    expect(all.settingsCheck).toBeUndefined()
    // the user fixes the library machine (here by importing the controller's $110)
    const found = t.s.library.lookup('machine', t.s.machineId)
    const revision = found.state === 'found' ? found.item.revision : 0
    expectOk(
      await t.run(
        'library.machine.settings.import',
        { id: t.s.machineId, revision, text: '$110=1234', accept: ['$110'] },
        ui,
      ),
    )
    expect(expectOk(t.d.query('run.settings.check', byMachine, ui)).value).toMatchObject({
      settingsCheck: { matches: true, against: 'machine', differences: [] },
    })
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
      serial: (settings) => ({
        emulator: { ...emulator, settings: { ...settings, ...emulator.settings } },
        timeScale: 'max',
      }),
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

  // DF135 C2 (docs/modes/cut-state.md#marking): what a real run finished, and Run's marks
  const unitsOf = (t: Awaited<ReturnType<typeof setup>>, planOps: readonly string[]) => {
    const plan = t.s.plan(t.planId)
    const part = plan.design.part
    const ids = new Set(
      plan.setups
        .flatMap((s) => s.operations)
        .filter((o) => planOps.includes(o.id))
        .flatMap((o) => o.designOperationIds.map((d) => unitOfOperation(part, d))),
    )
    return topLevelUnits(part).filter((u) => ids.has(u))
  }
  /** Runs on until the wait at a tool change of an operation after the first. */
  const toSecondTool = (r: Awaited<ReturnType<typeof realRun>>, first: string) =>
    r.advance(() => {
      const j = r.t.status().job
      return j?.phase === 'toolChange' && j.planOperationId !== first
    })

  it('DF135 C2: a real run to the end finished every operation; Run marks them, by run', async () => {
    const r = await realRun()
    const { t } = r
    await r.advance(() => false)
    expectOk(await r.result)
    const plan = t.s.plan(t.planId)
    const ops = plan.setups[0]!.operations.map((o) => o.id)
    const last = t.status().lastRun!
    expect(last).toMatchObject({ outcome: 'done', real: true, finished: ops })
    const part = () => t.d.doc.parts[t.s.partId]!
    const marks = runCutMarks(last, plan, part())
    expect(marks).toEqual({ kind: 'mark', planId: t.planId, units: unitsOf(t, ops) })
    if (marks.kind !== 'mark') return
    expectOk(
      await t.run(
        'design.part.update',
        { partId: t.s.partId, alreadyCut: marks.units, cutByRun: t.planId },
        ui,
      ),
    )
    expect(part().alreadyCut).toEqual(marks.units)
    for (const u of marks.units)
      expect(part().alreadyCutMarks?.[u]).toMatchObject({
        by: 'run',
        fingerprint: expect.any(String),
      })
    // marked already: nothing more to mark
    expect(runCutMarks(last, plan, part())).toEqual({ kind: 'none', reason: 'nothing' })
  })

  it('DF135 C2: a stopped real run offers only the finished operations, not the one in progress', async () => {
    const r = await realRun()
    const { t } = r
    const ops = t.s.plan(t.planId).setups[0]!.operations.map((o) => o.id)
    await toSecondTool(r, ops[0]!)
    expectOk(await t.run('job.abort', { jobId: r.jobId }, ui))
    expectErrCode(await r.result, 'op.aborted')
    expect(await waitFor(() => t.status().lastRun?.jobId === r.jobId)).toBe(true)
    const last = t.status().lastRun!
    const stoppedIn = ops.indexOf(last.planOperationId!)
    expect(stoppedIn).toBeGreaterThan(0)
    expect(last).toMatchObject({
      outcome: 'stopped',
      real: true,
      finished: ops.slice(0, stoppedIn),
    })
    const marks = runCutMarks(last, t.s.plan(t.planId), t.s.d.doc.parts[t.s.partId]!)
    expect(marks.kind).toBe('offer')
    if (marks.kind !== 'offer') return
    expect(marks.units.length).toBeGreaterThan(0)
    // a unit the stopped operation machines is not offered (Q197: it stays not cut)
    for (const u of unitsOf(t, [ops[stoppedIn]!])) expect(marks.units).not.toContain(u)
  })

  it('DF135 C2: an interrupted real run offers nothing while a resume is pending, then its finished operations', async () => {
    const r = await realRun()
    const { t } = r
    const ops = t.s.plan(t.planId).setups[0]!.operations.map((o) => o.id)
    // streaming in the third operation: the first is certainly finished
    await r.advance(() => {
      const j = t.status().job
      return j?.phase === 'streaming' && ops.indexOf(j.planOperationId ?? '') >= 2
    })
    r.port().unplug()
    expectErrCode(await r.result, 'machine.connection')
    expect(await waitFor(() => t.status().lastRun?.interruption !== undefined)).toBe(true)
    const plan = t.s.plan(t.planId)
    const part = t.s.d.doc.parts[t.s.partId]!
    expect(runCutMarks(t.status().lastRun, plan, part)).toEqual({
      kind: 'none',
      reason: 'resumePending',
    })
    t.client.dismissInterruption()
    const last = t.status().lastRun!
    const stoppedIn = ops.indexOf(last.planOperationId!)
    expect(stoppedIn).toBeGreaterThan(0)
    expect(last.finished).toEqual(ops.slice(0, stoppedIn))
    expect(runCutMarks(last, plan, part).kind).toBe('offer')
  })

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

  // DF134 (dogfood): a limit switch hit while cleaning after a completed run; Reset (immediate)
  // did nothing visible and Unlock stayed disabled until a reconnect
  it('a hard limit after a completed run: reset clears the critical alarm, unlock or home, G54 kept, the record stays done', async () => {
    const r = await realRun({ settings: { 21: 1 } })
    const { t } = r
    await r.advance(() => false)
    expectOk(await r.result)
    expect(t.client.runRecord()?.state).toBe('done')
    const workZero = t.status().workZero
    // the switch pressed and let go while idle: ALARM:1, critical (GRBL answers nothing)
    r.port().limitPin('x', true)
    expect(await waitFor(() => t.status().alarm?.code === 1)).toBe(true)
    expect(t.status()).toMatchObject({ homed: false, alarm: { code: 1 } })
    expect(t.status().alarm?.reset).toBeUndefined()
    expectErrCode(await t.run('run.machine.unlock', {}, ui), 'run.state')
    r.port().limitPin('x', false)
    // Reset (immediate): GRBL restarts locked ('$H'|'$X' to unlock); the alarm is no longer critical
    expectOk(await t.run('run.machine.reset', {}, ui))
    expect(await waitFor(() => t.status().alarm?.reset === true)).toBe(true)
    expect(await waitFor(() => t.status().state === 'Alarm')).toBe(true)
    expect(t.status()).toMatchObject({ homed: false, alarm: { code: 1, reset: true } })
    expect(t.status().pins).toBeUndefined()
    // overrides are no longer refused, unlock works and keeps the work zero
    expectOk(await t.run('run.override.set', { feed: 'reset' }, ui))
    expectOk(await t.run('run.machine.unlock', {}, ui))
    expect(await waitFor(() => t.status().state === 'Idle')).toBe(true)
    expect(t.status().alarm).toBeUndefined()
    expect(t.status().workZero).toEqual(workZero)
    // homing (recommended) keeps it too
    const home = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(home.jobId).unwrap().result)
    expect(t.status()).toMatchObject({ homed: true, workZero })
    // the completed run's record is not an interruption
    expect(t.client.runRecord()?.state).toBe('done')
    expect(t.status().lastRun?.interruption).toBeUndefined()
  })

  it('a hard limit with the switch still pressed after the reset: Pn shows it, homing waits for its release', async () => {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings: { ...settings, 21: 1 } }, timeScale: 'max' }),
    })
    expectOk(
      await t.run('run.connection.open', { target: 'serial', path: PATH, planId: t.planId }, ui),
    )
    const home = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(home.jobId).unwrap().result)
    const port = t.serial!.opened[0]!
    port.limitPin('y', true)
    expect(await waitFor(() => t.status().alarm?.code === 1)).toBe(true)
    expectOk(await t.run('run.machine.reset', {}, ui))
    // GRBL checks the limits at init: locked, `[MSG:Check Limits]`, the pin in every report
    expect(await waitFor(() => t.status().pins === 'Y')).toBe(true)
    expect(t.status()).toMatchObject({ state: 'Alarm', alarm: { code: 1, reset: true } })
    // homing on a pressed switch could take the wrong switch for home: refused with the switch named
    const blocked = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    const refused = expectErrCode(await t.d.job(blocked.jobId).unwrap().result, 'run.state')
    expect(refused.message).toContain('the Y limit switch is still pressed')
    expect(refused.issues[0]?.rule).toBe('limitPressed')
    port.limitPin('y', false)
    expect(await waitFor(() => t.status().pins === undefined)).toBe(true)
    const again = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(again.jobId).unwrap().result)
    expect(t.status()).toMatchObject({ homed: true, state: 'Idle' })
    expect(t.status().alarm).toBeUndefined()
  })

  it('the virtual machine simulates a limit switch and the door (DF134); a real one refuses', async () => {
    const t = await setup({ serial: (settings) => ({ emulator: { settings }, timeScale: 'max' }) })
    expectOk(await t.open())
    const home = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(home.jobId).unwrap().result)
    // the virtual machine has hard limits on ($21=1)
    expectOk(await t.client.simulateInput('z', true))
    expect(await waitFor(() => t.status().alarm?.code === 1)).toBe(true)
    expectOk(await t.client.simulateInput('z', false))
    expectOk(await t.run('run.machine.reset', {}, ui))
    expect(await waitFor(() => t.status().alarm?.reset === true)).toBe(true)
    expectOk(await t.run('run.machine.unlock', {}, ui))
    expect(await waitFor(() => t.status().state === 'Idle')).toBe(true)
    expectOk(await t.client.simulateInput('door', true))
    expect(await waitFor(() => t.status().state === 'Door:1' && t.status().pins === 'D')).toBe(true)
    expectOk(await t.client.simulateInput('door', false))
    expect(await waitFor(() => t.status().state === 'Door:0')).toBe(true)
    expectOk(await t.run('run.connection.close', {}, ui))
    expectOk(
      await t.run('run.connection.open', { target: 'serial', path: PATH, planId: t.planId }, ui),
    )
    expectErrCode(await t.client.simulateInput('x', true), 'run.state')
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

  // DF82: holds DFYOM did not send, from the controller side (its hold and cycle-start buttons,
  // its safety door). Spec: docs/modes/run.md#external-holds-df82
  /** Mid-run with the controller at real time, the machine moving (`Run`). */
  async function moving(r: Awaited<ReturnType<typeof realRun>>) {
    await r.streaming()
    r.port().setTimeScale(1)
    await r.advance(() => r.port().emulator.status().state === 'Run')
    expect(r.done()).toBe(false)
    return r.t.d.job(r.jobId).unwrap()
  }

  it("the machine's hold button pauses the run job at Hold:0; job.resume (UI) resumes it", async () => {
    const r = await realRun()
    const { t, jobId } = r
    const handle = await moving(r)
    r.port().press('feedHold')
    expect(await waitFor(() => handle.state === 'paused')).toBe(true)
    expect(r.port().emulator.status().state).toBe('Hold:0')
    expect(await waitFor(() => t.status().holdBy === 'machine')).toBe(true)
    expect(t.status()).toMatchObject({ state: 'Hold:0', job: { phase: 'held' } })
    // agents may not resume a real run (Q50); the UI may
    expectErrCode(await t.run('job.resume', { jobId }), 'permission.denied')
    expect(expectOk(await t.run('job.resume', { jobId }, ui))).toEqual({ state: 'running' })
    expect(handle.state).toBe('running')
    expect(await waitFor(() => r.port().emulator.status().state === 'Run')).toBe(true)
    // our own pause, ended by the machine's cycle-start button: the job runs again
    expect(expectOk(await t.run('job.pause', { jobId }, ui))).toEqual({ state: 'paused' })
    expect(await waitFor(() => t.status().holdBy === 'app')).toBe(true)
    r.port().press('cycleStart')
    expect(await waitFor(() => handle.state === 'running')).toBe(true)
    expect(await waitFor(() => t.status().job?.phase === 'streaming')).toBe(true)
    // and the machine's hold, ended by its cycle-start button
    await r.advance(() => r.port().emulator.status().state === 'Run')
    r.port().press('feedHold')
    expect(await waitFor(() => handle.state === 'paused')).toBe(true)
    r.port().press('cycleStart')
    expect(await waitFor(() => handle.state === 'running')).toBe(true)
    r.port().setTimeScale('max')
    await r.advance(() => false)
    expectOk(await r.result)
  })

  it('the safety door pauses the run job; job.resume is refused until the door is closed', async () => {
    const r = await realRun()
    const { t, jobId } = r
    const handle = await moving(r)
    r.port().door(true)
    expect(await waitFor(() => handle.state === 'paused')).toBe(true)
    expect(r.port().emulator.status().state).toBe('Door:1')
    const e = expectErrCode(await t.run('job.resume', { jobId }, ui), 'run.state')
    expect(e.message).toContain('the safety door is open: close it, then resume')
    expect(handle.state).toBe('paused')
    // closing the door does not resume by itself (GRBL waits for the cycle start)
    r.port().door(false)
    expect(await waitFor(() => t.status().state === 'Door:0')).toBe(true)
    expect(handle.state).toBe('paused')
    expect(expectOk(await t.run('job.resume', { jobId }, ui))).toEqual({ state: 'running' })
    r.port().setTimeScale('max')
    await r.advance(() => false)
    expectOk(await r.result)
  })

  it("the machine's hold button pauses a Probe Z job at Hold:0; job.resume finishes the probe", async () => {
    const t = await setup({
      serial: (settings) => ({ emulator: { settings }, timeScale: 'max' }),
    })
    expectOk(
      await t.run('run.connection.open', { target: 'serial', path: PATH, planId: t.planId }, ui),
    )
    const home = expectOk(await t.run('run.machine.home', {}, ui)) as { jobId: string }
    expectOk(await t.d.job(home.jobId).unwrap().result)
    const port = t.serial!.opened[0]!
    port.emulator.setProbePlate(t.status().mpos[2] - 20)
    port.setTimeScale(1)
    const { jobId } = expectOk(
      await t.run('run.machine.probeZ', { plateThickness: 5, feed: 300 }, ui),
    ) as { jobId: string }
    const handle = t.d.job(jobId).unwrap()
    expect(await waitFor(() => port.emulator.status().state === 'Run')).toBe(true)
    port.press('feedHold')
    expect(await waitFor(() => handle.state === 'paused')).toBe(true)
    expect(port.emulator.status().state).toBe('Hold:0')
    expect(await waitFor(() => t.status().holdBy === 'machine')).toBe(true)
    expect(expectOk(await t.run('job.resume', { jobId }, ui))).toEqual({ state: 'running' })
    // the machine's own cycle start after its hold resumes the job too (once DFYOM saw it move)
    expect(await waitFor(() => t.status().state === 'Run')).toBe(true)
    port.press('feedHold')
    expect(await waitFor(() => handle.state === 'paused')).toBe(true)
    port.press('cycleStart')
    expect(await waitFor(() => handle.state === 'running')).toBe(true)
    port.setTimeScale('max')
    const probed = expectOk(await handle.result) as { contact: number[] }
    expect(probed.contact[2]).toBeLessThan(0)
  })
})
