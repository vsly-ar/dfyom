// Stop across scopes (hardening DF80): a homing or Probe Z job started without a project is
// stopped from a project window and by a bound agent, and a project window's job from a window
// without a project, through every stop path (Q50/Q64: stop paths are every source's). The
// in-process machine host runs at real time so a cycle is still moving when the stop arrives.
// Spec: docs/modes/run.md#run-without-a-project-df80, docs/architecture/llm-api.md#machine-scope-df80,
// docs/modes/run.md#1-emergency-stop-stop-and-reset
import { afterEach, describe, expect, it } from 'vitest'
import { libraryInput, machineValues } from '../../core/library/library.fixture'
import { MachineClient } from '../../core/run/host/client'
import { inProcessHostFactory } from '../../core/run/host/in-process'
import { systemTimerHost } from '../../core/run/clock'
import type { RunStatus } from '../../core/run/service'
import type { AgentSession } from '../../core/agent/session'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { tempDir, testHost } from './host.fixture'
import { abortElsewhere } from './stop'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setup() {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const machine = new MachineClient({
    factory: inProcessHostFactory({ timers: systemTimerHost }),
    logLevel: 'warn',
  })
  cleanups.push(() => machine.close())
  const host = await testHost(t.dir, { machine })
  cleanups.push(() => host.shutdown())
  // a window without a project, a project window, an unbound and a bound agent
  const free = host.openSession({ kind: 'ui', id: 'win-free' })
  const win = host.openSession({ kind: 'ui', id: 'win-project' })
  const agentFree = host.openSession({ kind: 'agent', id: 'stdio-free' })
  const agent = host.openSession({ kind: 'agent', id: 'stdio-bound' })
  const value = async (s: AgentSession, name: string, args: object = {}) =>
    expectOk((await s.call(name, args)).result).value
  const { key } = (await value(win, 'project.create', { name: 'P', unitSystem: 'mm' })) as {
    key: string
  }
  expectOk(agent.bind(key))
  const { id } = (await value(free, 'library.machine.add', {
    values: libraryInput(machineValues()),
  })) as { id: string }
  await value(free, 'run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' })
  const status = async () => (await value(free, 'run.status.get')) as RunStatus
  /** Waits until the machine reports a state matching `re`. */
  const reach = async (re: RegExp) => {
    const until = Date.now() + 20_000
    while (Date.now() < until && !re.test((await status()).state)) await sleep(5)
    expect((await status()).state).toMatch(re)
  }
  /** A homing cycle at real time from `s`, already moving. */
  const homing = async (s: AgentSession) => {
    await value(free, 'run.timeScale.set', { scale: 1 })
    const { jobId } = (await value(s, 'run.machine.home')) as { jobId: string }
    await reach(/^Home/)
    return jobId
  }
  /** A Probe Z cycle at real time from `s` (homed at max speed first), already moving. */
  const probing = async (s: AgentSession) => {
    const home = (await value(free, 'run.machine.home')) as { jobId: string }
    await value(free, 'job.wait', { jobId: home.jobId, timeoutSeconds: 30 })
    expect((await status()).homed).toBe(true)
    await value(free, 'run.timeScale.set', { scale: 1 })
    const { jobId } = (await value(s, 'run.machine.probeZ', { plateThickness: 10, feed: 20 })) as {
      jobId: string
    }
    await reach(/^Run/)
    return jobId
  }
  /** The job as `s` sees it, once finished: aborted, and the machine no longer moving. */
  const expectStopped = async (s: AgentSession, jobId: string) => {
    const t0 = Date.now()
    const waited = (await value(s, 'job.wait', { jobId, timeoutSeconds: 10 })) as {
      state: string
      outcome?: { ok: boolean; error?: { code: string } }
    }
    expect(waited).toMatchObject({ state: 'finished', outcome: { ok: false } })
    expect(waited.outcome?.error?.code).toBe('op.aborted')
    expect(Date.now() - t0).toBeLessThan(5_000)
    await reach(/^(Alarm|Idle)/)
  }
  return { host, free, win, agentFree, agent, key, value, status, homing, probing, expectStopped }
}

describe('stop across scopes (DF80)', { timeout: 90_000 }, () => {
  it('job.abort of a homing job stops the cycle by a reset (ALARM:6), not only the job', async () => {
    const t = await setup()
    const jobId = await t.homing(t.free)
    expectOk((await t.free.call('job.abort', { jobId })).result)
    await t.expectStopped(t.free, jobId)
    const s = await t.status()
    expect(s.homed).toBe(false)
    expect(s.alarm?.code).toBe(6)
  })

  for (const stopper of ['win', 'agent'] as const)
    for (const cycle of ['homing', 'probing'] as const)
      it(`a ${cycle} job of the machine scope stops by job.abort from the ${stopper === 'win' ? 'project window' : 'bound agent'}`, async () => {
        const t = await setup()
        const jobId = await t[cycle](t.free)
        const by = t[stopper]
        expect(by.boundKey).toBe(t.key)
        // the project does not know the job: the session sends it to the machine scope
        const r = expectOk((await by.call('job.abort', { jobId })).result)
        expect(r.value).toMatchObject({ state: 'running' })
        // and follows it there (job.get, job.wait)
        expectOk((await by.call('job.get', { jobId })).result)
        await t.expectStopped(by, jobId)
      })

  for (const stopper of ['win', 'agent'] as const)
    for (const path of ['run.machine.reset', 'run.machine.jogCancel'] as const)
      it(`${path} from the ${stopper === 'win' ? 'project window' : 'bound agent'} reaches the machine-scope connection`, async () => {
        const t = await setup()
        if (path === 'run.machine.reset') {
          const jobId = await t.homing(t.free)
          expectOk((await t[stopper].call(path, {})).result)
          await t.expectStopped(t.free, jobId)
        } else {
          const home = (await t.value(t.free, 'run.machine.home')) as { jobId: string }
          await t.value(t.free, 'job.wait', { jobId: home.jobId, timeoutSeconds: 30 })
          await t.value(t.free, 'run.timeScale.set', { scale: 1 })
          await t.value(t.free, 'run.machine.jog', { by: [-200, 0, 0], feed: 500 })
          const until = Date.now() + 10_000
          while (Date.now() < until && !(await t.status()).state.startsWith('Jog')) await sleep(5)
          expectOk((await t[stopper].call(path, {})).result)
          const end = Date.now() + 10_000
          while (Date.now() < end && (await t.status()).state !== 'Idle') await sleep(5)
          expect((await t.status()).state).toBe('Idle')
          expect((await t.status()).mpos[0]).toBeGreaterThan(-150)
        }
      })

  it('job.pause of a machine-scope job reaches it from a bound session', async () => {
    const t = await setup()
    const jobId = await t.homing(t.free)
    expect((await t.agent.call('job.pause', { jobId })).result.isOk()).toBe(true)
    expect(await t.value(t.free, 'job.get', { jobId })).toMatchObject({ state: 'paused' })
    expectOk((await t.agent.call('job.abort', { jobId })).result)
    await t.expectStopped(t.agent, jobId)
  })

  for (const cycle of ['homing', 'probing'] as const)
    it(`a project window's ${cycle} job stops from a window without a project`, async () => {
      const t = await setup()
      const jobId = await t[cycle](t.win)
      // the machine scope does not know it: refused there, then found in the open project (ipc.ts)
      expectErrCode((await t.free.call('job.abort', { jobId })).result, 'input.malformed')
      const r = await abortElsewhere(t.host, { kind: 'ui', id: 'stop-1' }, undefined, { jobId })
      expect(r?.isOk()).toBe(true)
      await t.expectStopped(t.win, jobId)
      // the stop session ended
      expect(t.host.sessions().some((s) => s.source.id === 'stop-1')).toBe(false)
    })

  it("a project's job: an unbound agent stops it with run.machine.reset; abortElsewhere skips the own project", async () => {
    const t = await setup()
    const jobId = await t.homing(t.win)
    // an unbound agent's job.abort reaches the machine scope only; reset reaches the connection
    expectErrCode((await t.agentFree.call('job.abort', { jobId })).result, 'input.malformed')
    expect(
      await abortElsewhere(t.host, { kind: 'ui', id: 'stop-2' }, t.key, { jobId }),
    ).toBeUndefined()
    expectOk((await t.agentFree.call('run.machine.reset', {})).result)
    await t.expectStopped(t.win, jobId)
  })
})
