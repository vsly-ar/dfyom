import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { newProjectDoc } from '../project/document'
import type { ActionEvent } from './action-log'
import { getProject, renameProject } from './commands.fixture'
import type { JobProgress } from './context'
import { defineCommand } from './define'
import { createDispatcher } from './dispatcher'
import type { WorkerTask } from './jobs'
import { createRegistry } from './registry'
import { agentSource, fakeClock, fakeIds, uiSource } from './testing'

const ui = uiSource()

/** Steps are released one at a time by the test via `step()`. */
function stepper() {
  const waiting: (() => void)[] = []
  return {
    wait: () => new Promise<void>((r) => waiting.push(r)),
    step: async () => {
      while (waiting.length === 0) await new Promise((r) => setTimeout(r, 0))
      waiting.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

const double: WorkerTask<number, number> = {
  name: 'test.double',
  run: async (n) => Ok(n * 2),
}

function setup() {
  const s = stepper()
  const clock = fakeClock(0)
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
        await ctx.checkpoint()
        await s.wait()
        clock.advance(40)
        ctx.progress({ done: i + 1, total: args.steps })
      }
      const doubled = await ctx.services.workers.run(double, args.steps, ctx)
      if (doubled.isErr()) return doubled
      return Ok({ name: doc.name, doubled: doubled.unwrap() })
    },
  })
  const registry = expectOk(
    createRegistry({ commands: [renameProject, generate], queries: [getProject] }),
  )
  const d = createDispatcher({
    registry,
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock,
    progressIntervalMs: 100,
  })
  const events: ActionEvent[] = []
  d.log.subscribe({}, (e) => events.push(e))
  const start = async (steps: number) => {
    const out = expectOk(await d.dispatch('plan.toolpath.generate', { steps }, ui))
    const { jobId } = out.value as { jobId: string }
    return d.job(jobId).unwrap()
  }
  return { d, s, events, start }
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

  it('pause holds the job at its next checkpoint; resume continues', async () => {
    const { d, s, events, start } = setup()
    const job = await start(2)
    await s.step()
    expect(expectOk(await d.dispatch('job.pause', { jobId: job.id }, ui)).value).toEqual({
      state: 'paused',
    })
    expect(job.state).toBe('paused')
    expect(job.progress?.done).toBe(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(job.progress?.done).toBe(1)
    expectOk(await d.dispatch('job.resume', { jobId: job.id }, ui))
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

  it('abort ends the job with op.aborted, also while paused', async () => {
    const { d, s, start } = setup()
    const job = await start(3)
    await s.step()
    expectOk(await d.dispatch('job.pause', { jobId: job.id }, ui))
    expectOk(await d.dispatch('job.abort', { jobId: job.id }, ui))
    await s.step() // the handler finishes its current step, then its checkpoint throws
    expectErrCode(await job.result, 'op.aborted')
    expect(job.state).toBe('finished')
    // Control of a finished job is a no-op reporting its state.
    expect(expectOk(await d.dispatch('job.resume', { jobId: job.id }, ui)).value).toEqual({
      state: 'finished',
    })
  })

  it('unknown job ids are rejected', async () => {
    const { d } = setup()
    const e = expectErrCode(
      await d.dispatch('job.abort', { jobId: 'job-x' }, ui),
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['jobId'], rule: 'unknownJob' })
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
