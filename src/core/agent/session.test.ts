// Session core: binding, routing, digest, project.log.list, job.wait, stale writes, urgent abort.
// Spec: docs/architecture/llm-api.md#testing (Session (core))
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { fail, None, Ok, Some, type AppResult } from '../../shared/result'
import type { Source, Timers } from '../commands/context'
import { getProject, renameProject } from '../commands/commands.fixture'
import { defineCommand } from '../commands/define'
import { createDispatcher, type Dispatcher } from '../commands/dispatcher'
import { createRegistry } from '../commands/registry'
import { agentSource, fakeClock, fakeIds, uiSource } from '../commands/testing'
import { LIFECYCLE_COMMANDS, LIFECYCLE_QUERIES, type HostPort } from '../project/lifecycle'
import { newProjectDoc } from '../project/document'
import { AgentSession, type SessionHost, type SessionInfo } from './session'

const ui = uiSource('win-1')

/** A job that runs until the test opens its gate (or it is aborted). */
function gatedJob() {
  const gates: (() => void)[] = []
  const def = defineCommand({
    kind: 'job',
    name: 'plan.toolpath.generate',
    summary: 'Test job.',
    title: () => 'Generate',
    machine: false,
    args: z.object({}),
    result: z.object({ done: z.boolean() }),
    async run(_doc, _args, ctx) {
      ctx.progress({ done: 1, total: 2, label: 'half' })
      await new Promise<void>((resolve) => {
        gates.push(resolve)
        ctx.signal.addEventListener('abort', () => resolve())
      })
      await ctx.checkpoint()
      return Ok({ done: true })
    },
  })
  return { def, open: () => gates.splice(0).forEach((g) => g()) }
}

function manualTimers(): Timers & { fire(): void; readonly pending: number } {
  const pending = new Map<number, () => void>()
  let n = 0
  return {
    set: (fn) => (pending.set(++n, fn), n),
    clear: (h) => void pending.delete(h as number),
    fire: () => {
      const all = [...pending.values()]
      pending.clear()
      for (const f of all) f()
    },
    get pending() {
      return pending.size
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup(opts: { logCapacity?: number } = {}) {
  const job = gatedJob()
  const projectRegistry = expectOk(
    createRegistry({ commands: [renameProject, job.def], queries: [getProject] }),
  )
  const projects = new Map<string, Dispatcher>()
  const sessions: { info: SessionInfo; ended: boolean }[] = []
  const byFile = new Map<string, string>()
  let n = 0
  const newProject = (name: string, key = `p${++n}`) => {
    projects.set(
      key,
      createDispatcher({
        registry: projectRegistry,
        doc: newProjectDoc({ name, unitSystem: 'mm' }),
        ids: fakeIds(),
        clock: fakeClock(),
        progressIntervalMs: 0,
        ...(opts.logCapacity === undefined ? {} : { logCapacity: opts.logCapacity }),
      }),
    )
    return key
  }
  const hostPort: HostPort = {
    create: async (init) => Ok({ key: newProject(init.name), revision: 0 }),
    open: async (file) => {
      const known = byFile.get(file)
      if (known !== undefined && projects.has(known))
        return Ok({ key: known, revision: projects.get(known)!.revision, alreadyOpen: true })
      const key = newProject(file)
      byFile.set(file, key)
      return Ok({ key, revision: 0, alreadyOpen: false })
    },
    close: async (key) => {
      projects.delete(key)
      return Ok(undefined)
    },
    list: () => [],
    listRecovery: async () => Ok([]),
    resolveRecovery: async () => fail('input.malformed', 'none'),
  }
  const app = createDispatcher({
    registry: expectOk(
      createRegistry({ commands: LIFECYCLE_COMMANDS, queries: LIFECYCLE_QUERIES, builtins: false }),
    ),
    doc: newProjectDoc({ name: '', unitSystem: 'mm' }),
    services: { workers: { run: async () => fail('internal.unexpected', 'none') }, host: hostPort },
  })
  const timers = manualTimers()
  const host: SessionHost = {
    app,
    registries: {
      app: expectOk(
        createRegistry({
          commands: LIFECYCLE_COMMANDS,
          queries: LIFECYCLE_QUERIES,
          builtins: false,
        }),
      ),
      project: projectRegistry,
    },
    project: (key) => {
      const d = projects.get(key)
      return d === undefined ? None : Some(d)
    },
    sessionChanged: (info, ended = false) => sessions.push({ info, ended }),
  }
  const session = (source: Source = agentSource('stdio-1')) =>
    new AgentSession(host, { source, timers })
  const value = (r: AppResult<{ value: unknown }>) => expectOk(r).value
  return { job, projects, sessions, timers, session, value, newProject }
}

describe('agent session', () => {
  it('project tools need a bound project (noProject); app tools work unbound', async () => {
    const t = setup()
    const s = t.session()
    const r = await s.call('project.doc.get', {})
    expect(expectErrCode(r.result, 'input.malformed').issues[0]?.rule).toBe('noProject')
    expectErrCode((await s.call('nope.x.y', {})).result, 'command.unknown')
    // project.create binds
    const created = t.value(
      (await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result,
    )
    expect(created).toEqual({ key: 'p1', revision: 0 })
    expect(s.boundKey).toBe('p1')
    expect(t.value((await s.call('project.doc.get', {})).result)).toEqual({
      name: 'A',
      unitSystem: 'mm',
    })
    expect(t.sessions.at(-1)?.info).toMatchObject({ key: 'p1' })
    // project.close of the bound project unbinds
    expectOk((await s.call('project.close', { key: 'p1' })).result)
    expect(s.boundKey).toBeUndefined()
    s.end()
    expect(t.sessions.at(-1)?.ended).toBe(true)
  })

  it('project.bind binds to an open project; unknown keys fail; a closed project unbinds', async () => {
    const t = setup()
    const key = t.newProject('B')
    const s = t.session()
    expectErrCode((await s.call('project.bind', { key: 'nope' })).result, 'input.malformed')
    expect(t.value((await s.call('project.bind', { key })).result)).toEqual({ key, revision: 0 })
    t.projects.delete(key) // closed by someone else
    const r = await s.call('project.doc.get', {})
    expect(expectErrCode(r.result, 'input.malformed').issues[0]?.rule).toBe('noProject')
  })

  it('strips expectedRevision and passes it to dispatch; validates it', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const ok = await s.call('project.name.update', { name: 'X', expectedRevision: 0 })
    expect(expectOk(ok.result).revision).toBe(1)
    const stale = await s.call('project.name.update', { name: 'Y', expectedRevision: 0 })
    expectErrCode(stale.result, 'command.conflict')
    const bad = await s.call('project.name.update', { name: 'Y', expectedRevision: -1 })
    expect(expectErrCode(bad.result, 'input.malformed').issues[0]?.path).toEqual([
      'expectedRevision',
    ])
  })

  it('a UI edit between an agent read and write gives command.conflict (stale write)', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const d = t.projects.get('p1')!
    expectOk((await s.call('project.doc.get', {})).result)
    expectOk(await d.dispatch('project.name.update', { name: 'user' }, ui))
    expectErrCode(
      (await s.call('project.name.update', { name: 'agent' })).result,
      'command.conflict',
    )
    expectOk((await s.call('project.doc.get', {})).result)
    expectOk((await s.call('project.name.update', { name: 'agent' })).result)
  })

  it("digests other sources' events since the last call and advances the cursor", async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const d = t.projects.get('p1')!
    expectOk((await s.call('project.doc.get', {})).result)
    expectOk(await d.dispatch('project.name.update', { name: 'u1' }, ui))
    expectOk(await d.dispatch('project.name.update', { name: 'u2' }, ui))
    expectOk(await d.dispatch('history.undo', {}, ui))
    expectErrCode(await d.dispatch('project.name.update', { nme: 'x' }, ui), 'input.malformed')
    const r = await s.call('project.doc.get', {})
    expect(r.digest?.line).toBe(
      'Since your last call: 3 actions by ui:win-1 (project.name.update ×2, history.undo), revision 0 → 3.',
    )
    expect(r.digest?.meta).toMatchObject({ count: 3, gap: false, revision: { from: 0, to: 3 } })
    // own commands are not reported; the cursor moved on
    expectOk((await s.call('project.name.update', { name: 'me' })).result)
    expect((await s.call('project.doc.get', {})).digest).toBeUndefined()
  })

  it('reports a gap when the ring buffer dropped events (digest and project.log.list)', async () => {
    const t = setup({ logCapacity: 2 })
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const d = t.projects.get('p1')!
    for (const n of ['a', 'b', 'c', 'd'])
      expectOk(await d.dispatch('project.name.update', { name: n }, ui))
    const r = await s.call('project.log.list', {})
    const log = t.value(r.result) as {
      events: { seq: number; patches?: unknown }[]
      gap: boolean
      lastSeq: number
    }
    expect(log.gap).toBe(true)
    expect(log.events.map((e) => e.seq)).toEqual([3, 4])
    expect(log.events.every((e) => e.patches === undefined)).toBe(true)
    expect(r.digest?.meta.gap).toBe(true)
    const filtered = t.value(
      (await s.call('project.log.list', { afterSeq: 3, sources: ['agent:x'] })).result,
    ) as { events: unknown[]; gap: boolean }
    expect(filtered).toMatchObject({ events: [], gap: false })
  })

  it('job.wait returns job.get once finished, reports progress and the own job in the digest', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const started = await s.call('plan.toolpath.generate', {})
    expect(started.kind).toBe('job')
    const { jobId } = t.value(started.result) as { jobId: string }
    const ticks: unknown[] = []
    const wait = s.call('job.wait', { jobId }, { onProgress: (p) => ticks.push(p) })
    await settle()
    t.job.open()
    const r = await wait
    expect(t.value(r.result)).toMatchObject({
      jobId,
      state: 'finished',
      timedOut: false,
      outcome: { ok: true, value: { done: true } },
    })
    expect(r.digest?.line).toContain('1 action by you (plan.toolpath.generate finished)')
    expect(t.timers.pending).toBe(0)
  })

  it('job.wait times out (timedOut: true) and a cancelled wait leaves the job running', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('plan.toolpath.generate', {})).result) as {
      jobId: string
    }
    const wait = s.call('job.wait', { jobId, timeoutSeconds: 5 })
    await settle()
    t.timers.fire()
    expect(t.value((await wait).result)).toMatchObject({
      state: 'running',
      timedOut: true,
      progress: { done: 1 },
    })
    const ctl = new AbortController()
    const cancelled = s.call('job.wait', { jobId }, { signal: ctl.signal })
    await settle()
    ctl.abort()
    expectErrCode((await cancelled).result, 'op.aborted')
    expect(t.projects.get('p1')!.job(jobId).unwrap().state).toBe('running')
    expectErrCode((await s.call('job.wait', { jobId: 'nope' })).result, 'input.malformed')
    expectErrCode(
      (await s.call('job.wait', { jobId, timeoutSeconds: 301 })).result,
      'input.malformed',
    )
    t.job.open()
  })

  it('job_abort succeeds while the same session is waiting in job_wait (urgent path)', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('plan.toolpath.generate', {})).result) as {
      jobId: string
    }
    const wait = s.call('job.wait', { jobId })
    await settle()
    expect(t.value((await s.call('job.abort', { jobId })).result)).toEqual({ state: 'running' })
    const r = t.value((await wait).result) as {
      state: string
      outcome: { ok: boolean; error: { code: string } }
    }
    expect(r.state).toBe('finished')
    expect(r.outcome.error.code).toBe('op.aborted')
  })
})

describe('agent session: reads and runtimes', () => {
  it('a project this call opened or created is a read; bind and alreadyOpen are not', async () => {
    const t = setup()
    const a = t.session()
    t.value((await a.call('project.open', { file: 'f.dfyom' })).result)
    // opened by this call: an edit needs no query first
    expectOk((await a.call('project.name.update', { name: 'mine' })).result)
    const d = t.projects.get('p1')!
    expectOk(await d.dispatch('project.name.update', { name: 'user' }, ui))
    // another agent binds, or opens the same file (already open): neither is a read
    const b = t.session(agentSource('http-2'))
    t.value((await b.call('project.bind', { key: 'p1' })).result)
    expectErrCode((await b.call('history.undo', {})).result, 'command.conflict')
    const c = t.session(agentSource('http-3'))
    expect(t.value((await c.call('project.open', { file: 'f.dfyom' })).result)).toMatchObject({
      alreadyOpen: true,
    })
    expectErrCode((await c.call('history.undo', {})).result, 'command.conflict')
    // re-binding does not clear the conflict; a query does
    t.value((await b.call('project.bind', { key: 'p1' })).result)
    expectErrCode((await b.call('history.undo', {})).result, 'command.conflict')
    expectOk((await b.call('history.list', {})).result) // reads no document
    expectErrCode((await b.call('history.undo', {})).result, 'command.conflict')
    expectOk((await b.call('project.doc.get', {})).result)
    expectOk((await b.call('history.undo', {})).result)
  })

  it('a project closed and reopened under the same key unbinds the session', async () => {
    const t = setup()
    const a = t.session()
    t.value((await a.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    t.newProject('A again', 'p1') // same key, new runtime
    expect(a.boundKey).toBeUndefined()
    const r = await a.call('project.doc.get', {})
    const e = expectErrCode(r.result, 'input.malformed')
    expect(e.message).toContain('(p1) was closed')
    expect(r.digest).toBeUndefined()
    t.value((await a.call('project.bind', { key: 'p1' })).result)
    expect(t.value((await a.call('project.doc.get', {})).result)).toMatchObject({ name: 'A again' })
  })

  it('abortWaits ends pending job.wait calls (op.aborted); the job keeps running', async () => {
    const t = setup()
    const s = t.session()
    t.value((await s.call('project.create', { name: 'A', unitSystem: 'mm' })).result)
    const { jobId } = t.value((await s.call('plan.toolpath.generate', {})).result) as {
      jobId: string
    }
    const wait = s.call('job.wait', { jobId, timeoutSeconds: 300 })
    await settle()
    s.abortWaits()
    expectErrCode((await wait).result, 'op.aborted')
    expect(t.timers.pending).toBe(0)
    expect(t.projects.get('p1')!.job(jobId).unwrap().state).toBe('running')
    t.job.open()
  })
})
