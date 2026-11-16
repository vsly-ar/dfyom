import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { newProjectDoc } from '../project/document'
import type { ActionEvent } from './action-log'
import { getProject, renameProject } from './commands.fixture'
import type { JobProgress } from './context'
import { defineCommand } from './define'
import { createDispatcher, type DispatcherOptions } from './dispatcher'
import type { WorkerTask } from './jobs'
import { createRegistry } from './registry'
import { agentSource, fakeClock, fakeIds, uiSource } from './testing'

const ui = uiSource()

const settle = () => new Promise((r) => setTimeout(r, 0))

/** Steps are released one at a time by the test via `step()`. */
function stepper() {
  const waiting: (() => void)[] = []
  return {
    wait: () => new Promise<void>((r) => waiting.push(r)),
    /** How many handlers are parked in `wait()` (not in a checkpoint). */
    pending: () => waiting.length,
    step: async () => {
      while (waiting.length === 0) await settle()
      waiting.shift()?.()
      await settle()
    },
  }
}

const double: WorkerTask<number, number> = {
  name: 'test.double',
  run: async (n) => Ok(n * 2),
}

function setup(opts: Partial<DispatcherOptions> = {}) {
  const s = stepper()
  const clock = fakeClock(0)
  // Each step: wait for the test, report progress, then a checkpoint (where pause/abort act).
  const generate = defineCommand({
    kind: 'job',
    name: 'plan.toolpath.generate',
    summary: 'Generate toolpaths (test job).',
    title: () => 'Generate toolpaths',
    machine: false,
    args: z.object({ steps: z.number().int() }),
    result: z.object({ name: z.string(), doubled: z.number() }),
    async run(doc, args, ctx) {
      for (let i = 0; i < args.steps; i++) {
        await s.wait()
        clock.advance(40)
        ctx.progress({ done: i + 1, total: args.steps })
        await ctx.checkpoint()
      }
      const doubled = await ctx.services.workers.run(double, args.steps, ctx)
      if (doubled.isErr()) return doubled
      return Ok({ name: doc.name, doubled: doubled.unwrap() })
    },
  })
  // Several concurrent checkpoints in one job (e.g. parallel sub-tasks).
  const parallel = defineCommand({
    kind: 'job',
    name: 'plan.toolpath.check',
    summary: 'Check toolpaths in parallel (test job).',
    title: () => 'Check toolpaths',
    machine: false,
    args: z.object({}),
    result: z.null(),
    async run(_doc, _args, ctx) {
      await s.wait()
      await Promise.all([ctx.checkpoint(), ctx.checkpoint(), ctx.checkpoint()])
      return Ok(null)
    },
  })
  const registry = expectOk(
    createRegistry({ commands: [renameProject, generate, parallel], queries: [getProject] }),
  )
  const d = createDispatcher({
    registry,
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock,
    progressIntervalMs: 100,
    ...opts,
  })
  const events: ActionEvent[] = []
  d.log.subscribe({}, (e) => events.push(e))
  const startNamed = async (name: string, args: unknown) => {
    const out = expectOk(await d.dispatch(name, args, ui))
    const { jobId } = out.value as { jobId: string }
    return d.job(jobId).unwrap()
  }
  const start = (steps: number) => startNamed('plan.toolpath.generate', { steps })
  const control = async (verb: 'pause' | 'resume' | 'abort', jobId: string) =>
    expectOk(await d.dispatch(`job.${verb}`, { jobId }, ui))
  return { d, s, events, start, startNamed, control }
}

const shape = (e: ActionEvent) =>
  e.type === 'job' ? `job:${e.state}` : e.type === 'command' ? e.name : e.type

describe('jobs', () => {
  it('dispatch returns { jobId } at once and releases the queue', async () => {
    const { d, s, events, start } = setup()
    const job = await start(1)
    expect(job.state).toBe('running')
    expect(job.startRevision).toBe(0)
    expectOk(await d.dispatch('project.name.update', { name: 'Plate' }, ui)) // not blocked
    await s.step()
    const r = expectOk(await job.result)
    expect(r).toEqual({ name: 'Bracket', doubled: 2 }) // snapshot at start, worker port used
    expect(job.state).toBe('finished')
    expect(events.map(shape)).toEqual([
      'plan.toolpath.generate',
      'job:started',
      'project.name.update',
      'job:finished',
    ])
    expect(events.at(-1)).toMatchObject({ outcome: { ok: true, value: r } })
  })

  it('progress is a throttled stream; the latest value is always available', async () => {
    const { s, start } = setup()
    const job = await start(5)
    const ticks: JobProgress[] = []
    job.onProgress((p) => ticks.push(p))
    for (let i = 0; i < 5; i++) await s.step()
    await job.result
    // 40 ms per step, 100 ms interval: t=40 emitted, 80/120 throttled, 160 emitted, 200 complete
    expect(ticks.map((p) => p.done)).toEqual([1, 4, 5])
    expect(job.progress).toEqual({ done: 5, total: 5 })
  })

  it('pause parks the handler in its next checkpoint; resume continues', async () => {
    const { s, events, start, control } = setup()
    const job = await start(2)
    expect((await control('pause', job.id)).value).toEqual({ state: 'paused' })
    await s.step() // step 1 runs, then the handler reaches the checkpoint and parks there
    await settle()
    expect(job.state).toBe('paused')
    expect(job.progress?.done).toBe(1)
    expect(s.pending()).toBe(0) // not waiting for step 2: held in checkpoint()
    await control('resume', job.id)
    await settle()
    expect(s.pending()).toBe(1) // passed the checkpoint, now waits for step 2
    await s.step()
    expectOk(await job.result)
    expect(events.map(shape)).toEqual([
      'plan.toolpath.generate',
      'job:started',
      'job.pause',
      'job:paused',
      'job.resume',
      'job:resumed',
      'job:finished',
    ])
  })

  it('abort wakes a handler parked in checkpoint and ends with op.aborted', async () => {
    const { s, start, control } = setup()
    const job = await start(3)
    await control('pause', job.id)
    await s.step()
    await settle()
    expect(s.pending()).toBe(0) // parked in checkpoint()
    await control('abort', job.id)
    expectErrCode(await job.result, 'op.aborted')
    expect(job.state).toBe('finished')
    // Control of a finished job is a no-op reporting its state.
    expect((await control('resume', job.id)).value).toEqual({ state: 'finished' })
  })

  it('resume wakes all concurrent checkpoints', { timeout: 1000 }, async () => {
    const { s, startNamed, control } = setup()
    const job = await startNamed('plan.toolpath.check', {})
    await control('pause', job.id)
    await s.step()
    await control('resume', job.id)
    expectOk(await job.result)
  })

  it('abort wakes all concurrent checkpoints', { timeout: 1000 }, async () => {
    const { s, startNamed, control } = setup()
    const job = await startNamed('plan.toolpath.check', {})
    await control('pause', job.id)
    await s.step()
    await control('abort', job.id)
    expectErrCode(await job.result, 'op.aborted')
  })

  it('unknown job ids are rejected', async () => {
    const { d } = setup()
    const e = expectErrCode(
      await d.dispatch('job.abort', { jobId: 'job-x' }, ui),
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['jobId'], rule: 'unknownJob' })
  })

  it('finished jobs are evicted beyond the retention limit', async () => {
    const { d, s, start } = setup({ maxFinishedJobs: 1 })
    const first = await start(1)
    await s.step()
    await first.result
    const second = await start(1)
    await s.step()
    await second.result
    expect(d.job(first.id).isNone()).toBe(true)
    expect(d.job(second.id).isSome()).toBe(true)
    const e = expectErrCode(
      await d.dispatch('job.abort', { jobId: first.id }, ui),
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'unknownJob' })
  })

  it('the follow-up document command uses startRevision: conflict if the inputs changed', async () => {
    const { d, s, start } = setup()
    const agent = agentSource()
    const job = await start(1)
    expectOk(await d.dispatch('project.name.update', { name: 'Changed' }, ui))
    await s.step()
    const r = expectOk(await job.result) as { name: string }
    expectErrCode(
      await d.dispatch('project.name.update', { name: r.name }, agent, {
        expectedRevision: job.startRevision,
      }),
      'command.conflict',
    )
  })
})
