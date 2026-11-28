// job.wait at a run's operator waits: tool change, program pause, setup change.
// Spec: docs/architecture/llm-api.md#a2-jobwait-at-operator-waits
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectOk } from '../../shared/testing/result'
import { fail, None, Ok, Some, type AppResult } from '../../shared/result'
import type { Timers } from '../commands/context'
import { defineCommand, defineQuery } from '../commands/define'
import { createDispatcher, type Dispatcher } from '../commands/dispatcher'
import { createRegistry } from '../commands/registry'
import { agentSource, fakeClock, fakeIds } from '../commands/testing'
import { LIFECYCLE_COMMANDS, LIFECYCLE_QUERIES, type HostPort } from '../project/lifecycle'
import { newProjectDoc } from '../project/document'
import { AgentSession, WAIT_POLL_MS, type SessionHost } from './session'

interface RunJobStatus {
  jobId: string
  phase: string
  toolChange?: { n: number; name: string }
  pause?: number
  line?: number
}

/** Timers fired by elapsed time, so a poll can run without the wait's timeout. */
function clockTimers(): Timers & { advance(ms: number): void } {
  let now = 0
  let n = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn, ms) => (pending.set(++n, { at: now + ms, fn }), n),
    clear: (h) => void pending.delete(h as number),
    advance(ms) {
      now += ms
      for (const [h, t] of [...pending])
        if (t.at <= now) {
          pending.delete(h)
          t.fn()
        }
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const status: { job?: RunJobStatus } = {}
  const gates: (() => void)[] = []
  const runStart = defineCommand({
    kind: 'job',
    name: 'run.job.start',
    summary: 'Test run.',
    title: () => 'Run',
    machine: false,
    args: z.object({ planId: z.string() }),
    result: z.object({}).passthrough(),
    async run(_doc, args, ctx) {
      ctx.progress({ done: 0, total: 10, label: 'run' })
      await new Promise<void>((resolve) => gates.push(resolve))
      return Ok({
        planId: args.planId,
        setupId: 's1',
        next: { setupId: 's2', name: 'Top', direction: '+z', rotation: 0 },
      })
    },
  })
  const runContinue = defineCommand({
    kind: 'effect',
    name: 'run.job.continue',
    summary: 'Test continue.',
    title: () => 'Continue',
    machine: false,
    args: z.object({
      jobId: z.string(),
      toolChange: z.number().optional(),
      pause: z.number().optional(),
      line: z.number().optional(),
    }),
    result: z.object({}).passthrough(),
    // as the real command: the wait's line (a tool number can come back later in the program)
    run: async (_doc, args) => Ok({ ...args, line: args.line ?? status.job?.line }),
  })
  const runStatus = defineQuery({
    name: 'run.status.get',
    summary: 'Test status.',
    args: z.object({}),
    result: z.unknown(),
    readsDocument: false,
    run: () => Ok(structuredClone(status)),
  })
  const registry = expectOk(
    createRegistry({ commands: [runStart, runContinue], queries: [runStatus] }),
  )
  const projects = new Map<string, Dispatcher>()
  const hostPort: HostPort = {
    create: async () => {
      projects.set(
        'p1',
        createDispatcher({
          registry,
          doc: newProjectDoc({ name: 'A', unitSystem: 'mm' }),
          ids: fakeIds(),
          clock: fakeClock(),
          progressIntervalMs: 0,
        }),
      )
      return Ok({ key: 'p1', revision: 0 })
    },
    open: async () => fail('input.malformed', 'none'),
    close: async () => Ok(undefined),
    list: () => [],
    listRecovery: async () => Ok([]),
    resolveRecovery: async () => fail('input.malformed', 'none'),
  }
  const appRegistry = expectOk(
    createRegistry({ commands: LIFECYCLE_COMMANDS, queries: LIFECYCLE_QUERIES, builtins: false }),
  )
  const host: SessionHost = {
    app: createDispatcher({
      registry: appRegistry,
      doc: newProjectDoc({ name: '', unitSystem: 'mm' }),
      services: {
        workers: { run: async () => fail('internal.unexpected', 'none') },
        host: hostPort,
      },
    }),
    registries: { app: appRegistry, project: registry },
    project: (key) => (projects.has(key) ? Some(projects.get(key)!) : None),
    sessionChanged: () => {},
  }
  const timers = clockTimers()
  const session = new AgentSession(host, { source: agentSource('stdio-1'), timers })
  const value = (r: AppResult<{ value: unknown }>) => expectOk(r).value as Record<string, unknown>
  return { status, session, timers, value, finish: () => gates.splice(0).forEach((g) => g()) }
}

describe('job.wait on a run', () => {
  it('returns at a tool change and a pause with the next call, not again after a continue', async () => {
    const t = setup()
    const s = t.session
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('run.job.start', { planId: 'pl' })).result) as {
      jobId: string
    }
    // waiting already when job.wait starts: it returns at once
    t.status.job = { jobId, phase: 'toolChange', toolChange: { n: 1, name: 'T1 Flat 6' } }
    const first = t.value((await s.call('job.wait', { jobId, timeoutSeconds: 60 })).result)
    expect(first).toMatchObject({
      state: 'running',
      timedOut: false,
      waiting: {
        kind: 'toolChange',
        toolChange: { n: 1, name: 'T1 Flat 6' },
        next: { name: 'run.job.continue', args: { jobId, toolChange: 1 } },
      },
    })
    expectOk((await s.call('run.job.continue', { jobId, toolChange: 1 })).result)
    // the status still shows tool change 1 for a moment: not reported again
    const second = s.call('job.wait', { jobId, timeoutSeconds: 60 })
    let done = false
    void second.then(() => (done = true))
    t.timers.advance(WAIT_POLL_MS)
    await settle()
    expect(done).toBe(false)
    t.status.job = { jobId, phase: 'streaming' }
    t.timers.advance(WAIT_POLL_MS)
    await settle()
    expect(done).toBe(false)
    // an M0 pause, seen by the poll
    t.status.job = { jobId, phase: 'programPause', pause: 1 }
    t.timers.advance(WAIT_POLL_MS)
    expect(t.value((await second).result)).toMatchObject({
      timedOut: false,
      waiting: {
        kind: 'programPause',
        pause: 1,
        next: { name: 'run.job.continue', args: { jobId, pause: 1 } },
      },
    })
  })

  it('returns at the same tool again later in the program (T2, T3, T2)', async () => {
    const t = setup()
    const s = t.session
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('run.job.start', { planId: 'pl' })).result) as {
      jobId: string
    }
    const tc2 = { n: 2, name: 'T2 Flat 6.22' }
    t.status.job = { jobId, phase: 'toolChange', toolChange: tc2, line: 40 }
    expectOk((await s.call('run.job.continue', { jobId, toolChange: 2 })).result)
    // the dogfood's plate: T2 drills, T3 countersinks, T2 again for the cut-off
    t.status.job = { jobId, phase: 'toolChange', toolChange: tc2, line: 1558 }
    const again = t.value((await s.call('job.wait', { jobId, timeoutSeconds: 60 })).result)
    expect(again).toMatchObject({
      timedOut: false,
      // DF149: the next call names the wait's line, so a late retry cannot end a later T2 wait
      waiting: {
        kind: 'toolChange',
        toolChange: tc2,
        next: { name: 'run.job.continue', args: { jobId, toolChange: 2, line: 1558 } },
      },
    })
  })

  it('names the setup change when the run ends and the plan has another setup', async () => {
    const t = setup()
    const s = t.session
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('run.job.start', { planId: 'pl' })).result) as {
      jobId: string
    }
    t.status.job = { jobId, phase: 'streaming' }
    const wait = s.call('job.wait', { jobId, timeoutSeconds: 60 })
    await settle()
    delete t.status.job
    t.finish()
    expect(t.value((await wait).result)).toMatchObject({
      state: 'finished',
      timedOut: false,
      waiting: {
        kind: 'setupChange',
        setup: { setupId: 's2', name: 'Top' },
        next: { name: 'run.job.start', args: { planId: 'pl', setupId: 's2' } },
      },
    })
  })

  it('times out as before while the run streams', async () => {
    const t = setup()
    const s = t.session
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('run.job.start', { planId: 'pl' })).result) as {
      jobId: string
    }
    t.status.job = { jobId, phase: 'streaming' }
    const wait = s.call('job.wait', { jobId, timeoutSeconds: 1 })
    await settle()
    t.timers.advance(1000)
    const v = t.value((await wait).result)
    expect(v).toMatchObject({ state: 'running', timedOut: true })
    expect(v['waiting']).toBeUndefined()
    t.finish()
  })
})
