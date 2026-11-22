// Spec: docs/architecture/workers.md#toolpath-cache, docs/modes/plan-v0.1.md#toolpath-generation-job
import { describe, expect, it } from 'vitest'
import { fail, type AsyncAppResult } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { Services } from '../commands/context'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers, type WorkerPort } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeIds, uiSource } from '../commands/testing'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'
import { createToolpathCache } from './cache'
import type { Toolpath } from './model'
import type { GeneratorRequest } from './request'

const ui = uiSource()

/** A port that counts runs; `hook` may replace a run's result. */
function countingPort(hook?: (request: GeneratorRequest, signal: AbortSignal) => unknown) {
  const inner = createInProcessWorkers()
  const runs: string[] = []
  const port: WorkerPort = {
    async run(task, input, ctl) {
      const request = input as GeneratorRequest
      runs.push(request.inputs[0]!.planOperationId)
      const replaced = await hook?.(request, ctl.signal)
      if (replaced !== undefined) return replaced as never
      return inner.run(task, input, ctl)
    },
  }
  return { port, runs }
}

interface Setup {
  s: PlanSetup
  planId: string
  /** Plan operation ids in machining order. */
  order: string[]
  d: ReturnType<typeof createDispatcher>
  generate(args?: object): AsyncAppResult<unknown>
  start(args?: object): Promise<string>
  get(planOperationId: string): { toolpath: Toolpath | null; stale: boolean }
}

async function setup(
  opts: { port?: WorkerPort; services?: Partial<Services>; resolve?: boolean } = {},
): Promise<Setup> {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const ops = s.plan(planId).setups[0]!.operations
  if (opts.resolve !== false)
    for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: s.d.doc,
    revision: s.d.revision,
    ids: fakeIds(),
    services: {
      workers: opts.port ?? createInProcessWorkers(),
      library: s.library,
      toolpaths: createToolpathCache(),
      ...opts.services,
    },
  })
  const start = async (args: object = {}) =>
    (
      expectOk(await d.dispatch('plan.toolpath.generate', { planId, ...args }, ui)).value as {
        jobId: string
      }
    ).jobId
  return {
    s,
    planId,
    order: ops.map((o) => o.id),
    d,
    start,
    generate: async (args = {}) => d.job(await start(args)).unwrap().result,
    get: (planOperationId) =>
      expectOk(d.query('plan.toolpath.get', { planId, planOperationId }, ui)).value as {
        toolpath: Toolpath | null
        stale: boolean
      },
  }
}

type Outcome = {
  operations: { planOperationId: string; status: string; error?: { code: string } }[]
}

describe('plan.toolpath.generate', () => {
  it('generates every operation in machining order; a second run is all cached', async () => {
    const { port, runs } = countingPort()
    const t = await setup({ port })
    expect(t.get(t.order[0]!)).toEqual({ toolpath: null, stale: true, pendingApply: false })
    const first = expectOk(await t.generate()) as Outcome
    expect(first.operations).toEqual(
      t.order.map((id) => ({ planOperationId: id, status: 'generated' })),
    )
    expect(runs).toEqual(t.order)
    const second = expectOk(await t.generate()) as Outcome
    expect(second.operations.map((o) => o.status)).toEqual(t.order.map(() => 'cached'))
    expect(runs).toHaveLength(t.order.length)
    const got = t.get(t.order[0]!)
    expect(got.stale).toBe(false)
    expect(got.toolpath).toMatchObject({ planOperationId: t.order[0] })
  })

  it('generates only the listed plan operations', async () => {
    const { port, runs } = countingPort()
    const t = await setup({ port })
    const r = expectOk(await t.generate({ planOperationIds: [t.order[2]!] })) as Outcome
    expect(r.operations).toEqual([{ planOperationId: t.order[2], status: 'generated' }])
    expect(runs).toEqual([t.order[2]])
  })

  it('a plan edit makes the toolpath stale; get returns the last one until regenerated', async () => {
    const t = await setup()
    expectOk(await t.generate())
    const facing = t.order[0]!
    const before = t.get(facing).toolpath
    expectOk(
      await t.d.dispatch(
        'plan.operation.update',
        { planId: t.planId, planOperationId: facing, strategy: { overshoot: '2' } },
        ui,
      ),
    )
    // the plan's toolpaths were generated: its edited inputs are pending for Apply
    expect(t.get(facing)).toEqual({ toolpath: before, stale: true, pendingApply: true })
    const r = expectOk(await t.generate()) as Outcome
    // the facing and everything after it (chained hash) regenerate
    expect(r.operations.every((o) => o.status === 'generated')).toBe(true)
    expect(t.get(facing).stale).toBe(false)
    expect(t.get(facing).toolpath).not.toEqual(before)
  })

  it('a failed operation is reported while the others are generated; the job is Ok', async () => {
    let failId = ''
    const { port } = countingPort((req) =>
      req.inputs[0]!.planOperationId === failId
        ? fail('plan.check', 'tool does not fit', { where: 'test' })
        : undefined,
    )
    const t = await setup({ port })
    failId = t.order[1]!
    const r = expectOk(await t.generate()) as Outcome
    expect(r.operations.map((o) => o.status)).toEqual(
      t.order.map((id) => (id === failId ? 'failed' : 'generated')),
    )
    expect(r.operations[1]!.error).toMatchObject({
      code: 'plan.check',
      message: 'tool does not fit',
    })
    expect(t.get(failId)).toEqual({ toolpath: null, stale: true, pendingApply: false })
  })

  it('abort mid-job ends in op.aborted with the completed operations; they stay cached', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const { port } = countingPort(async (_req, signal) => {
      if (++calls < 2) return undefined
      await new Promise<void>((r) => {
        signal.addEventListener('abort', () => r(), { once: true })
        void gate.then(r)
      })
      return signal.aborted ? fail('op.aborted', 'aborted', { where: 'test' }) : undefined
    })
    const t = await setup({ port })
    const jobId = await t.start()
    const job = t.d.job(jobId).unwrap()
    while (calls < 2) await new Promise((r) => setTimeout(r, 0))
    expectOk(await t.d.dispatch('job.abort', { jobId }, ui))
    release()
    const e = expectErrCode(await job.result, 'op.aborted')
    expect(e.frames[0]?.data).toMatchObject({ completed: [t.order[0]] })
    expect(t.get(t.order[0]!).stale).toBe(false)
  })

  it('pause takes effect between plan operations; the toolpath worker is never parked', async () => {
    const paused: boolean[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const inner = createInProcessWorkers()
    const runs: string[] = []
    const port: WorkerPort = {
      async run(task, input, ctl) {
        runs.push((input as GeneratorRequest).inputs[0]!.planOperationId)
        paused.push(ctl.pause !== undefined)
        if (runs.length === 1) await gate
        return inner.run(task, input, ctl)
      },
    }
    const t = await setup({ port })
    const jobId = await t.start()
    await new Promise((r) => setTimeout(r, 0))
    expectOk(await t.d.dispatch('job.pause', { jobId }, ui))
    release()
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(runs).toHaveLength(1) // finished its operation, parked between operations
    expect(paused).toEqual([false]) // no PauseState reaches the worker
    expectOk(await t.d.dispatch('job.resume', { jobId }, ui))
    expectOk(await t.d.job(jobId).unwrap().result)
    expect(runs).toHaveLength(t.order.length)
  })

  it('plan.check findings fail the job before any worker runs', async () => {
    const { port, runs } = countingPort()
    const t = await setup({ port, resolve: false })
    expectErrCode(await t.generate(), 'plan.check')
    expect(runs).toEqual([])
  })

  it('fails with internal.unexpected without a toolpath cache', async () => {
    const t = await setup({ services: { toolpaths: undefined } as never })
    // services spread keeps the key with value undefined
    expectErrCode(await t.generate(), 'internal.unexpected')
    expectErrCode(
      t.d.query('plan.toolpath.get', { planId: t.planId, planOperationId: t.order[0] }, ui),
      'internal.unexpected',
    )
  })

  it('get rejects unknown plans and plan operations', async () => {
    const t = await setup()
    expectErrCode(
      t.d.query('plan.toolpath.get', { planId: 'plan-x', planOperationId: t.order[0] }, ui),
      'input.malformed',
    )
    expectErrCode(
      t.d.query('plan.toolpath.get', { planId: t.planId, planOperationId: 'planOp-x' }, ui),
      'input.malformed',
    )
  })
})

// Spec: docs/architecture/apply.md#apply-jobs (decision 4)
describe('toolpaths on Apply (plan.toolpaths apply job)', () => {
  type Pending = {
    changes: {
      kind: string
      planId?: string
      operationId?: string
      setupId?: string
      field?: string
    }[]
  }
  type Applied = { jobIds: string[] }

  it('keeps a plan current once its toolpaths were generated: plan edits are pending, Apply regenerates', async () => {
    const t = await setup()
    const facing = t.order[0]!
    const pending = () => expectOk(t.d.query('project.pending.get', {}, ui)).value as Pending
    const apply = async () => expectOk(await t.d.dispatch('project.apply', {}, ui)).value as Applied
    const overshoot = async (v: string) =>
      expectOk(
        await t.d.dispatch(
          'plan.operation.update',
          { planId: t.planId, planOperationId: facing, strategy: { overshoot: v } },
          ui,
        ),
      )
    // never generated: the plan stays explicit ("Generate toolpaths")
    await overshoot('2')
    expect(pending().changes).toEqual([])
    expect((await apply()).jobIds).toEqual([])
    expectOk(await t.generate())
    await overshoot('3')
    expect(pending().changes).toEqual([
      expect.objectContaining({
        kind: 'plan',
        planId: t.planId,
        operationId: facing,
        field: 'strategy.overshoot',
      }),
    ])
    expect(t.get(facing)).toMatchObject({ stale: true, pendingApply: true })
    const { jobIds } = await apply()
    expect(jobIds).toHaveLength(1)
    const r = expectOk(await t.d.job(jobIds[0]!).unwrap().result) as Outcome
    expect(r.operations.map((o) => o.planOperationId)).toEqual(t.order)
    expect(t.get(facing)).toMatchObject({ stale: false, pendingApply: false })
    // nothing stale or pending: no job
    expect((await apply()).jobIds).toEqual([])
  })

  it('plan edits made since the last Apply are not pending once Generate made the toolpaths current', async () => {
    const t = await setup()
    const facing = t.order[0]!
    const pending = () => expectOk(t.d.query('project.pending.get', {}, ui)).value as Pending
    const update = async (args: object) =>
      expectOk(
        await t.d.dispatch(
          'plan.operation.update',
          { planId: t.planId, planOperationId: facing, ...args },
          ui,
        ),
      )
    // an Apply with the plan in it (the baseline), then a plan edit, then an explicit Generate
    expectOk(await t.d.dispatch('project.apply', {}, ui))
    await update({ overrides: { feedRate: '900' } })
    expectOk(await t.generate())
    expect(pending().changes).toEqual([])
    expect(t.get(facing)).toMatchObject({ stale: false, pendingApply: false })
    // a later edit makes the plan's toolpaths stale: pending again
    await update({ strategy: { overshoot: '3' } })
    expect(pending().changes).toContainEqual(
      expect.objectContaining({ kind: 'plan', operationId: facing, field: 'strategy.overshoot' }),
    )
  })

  it('after Generate, a later edit lists only the inputs whose toolpaths are not current', async () => {
    const t = await setup()
    const [first, second] = t.order as [string, string]
    const planKeys = () =>
      (expectOk(t.d.query('project.pending.get', {}, ui)).value as Pending).changes
        .filter((c) => c.kind === 'plan')
        .map((c) => [c.operationId ?? c.setupId ?? '', c.field])
    const update = async (planOperationId: string, args: object) =>
      expectOk(
        await t.d.dispatch(
          'plan.operation.update',
          { planId: t.planId, planOperationId, ...args },
          ui,
        ),
      )
    expectOk(await t.d.dispatch('project.apply', {}, ui))
    // edits on both operations, generated explicitly
    await update(first, { overrides: { feedRate: '900' } })
    await update(second, { overrides: { feedRate: '160' } })
    expectOk(await t.generate())
    expect(planKeys()).toEqual([])
    // a later edit on the second operation: only it is pending, not the generated feed rate
    await update(second, { overrides: { feedRate: '170' } })
    expect(planKeys()).toEqual([[second, 'overrides.feedRate']])
    // an edit on the first operation is pending too (the second stays stale through the chain)
    await update(first, { overrides: { feedRate: '950' } })
    expect(planKeys()).toEqual([
      [first, 'overrides.feedRate'],
      [second, 'overrides.feedRate'],
    ])
  })

  it('an archived plan is not kept current', async () => {
    const t = await setup()
    expectOk(await t.generate())
    expectOk(await t.d.dispatch('plan.status.set', { planId: t.planId, status: 'archived' }, ui))
    expect((expectOk(t.d.query('project.pending.get', {}, ui)).value as Pending).changes).toEqual(
      [],
    )
  })
})
