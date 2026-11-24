// Manual machine control without a project (hardening DF80): a session with no bound project
// runs the manual-control run commands on the host's machine-scope dispatcher (in-process machine
// host, time scale max); plan runs still need a project; a bound session shares the connection.
// Spec: docs/architecture/llm-api.md#machine-scope-df80, docs/modes/run.md#run-without-a-project-df80
import { afterEach, describe, expect, it } from 'vitest'
import { libraryInput, machineValues } from '../../core/library/library.fixture'
import { MachineClient } from '../../core/run/host/client'
import { inProcessHostFactory } from '../../core/run/host/in-process'
import { systemTimerHost } from '../../core/run/clock'
import type { RunStatus } from '../../core/run/service'
import { MACHINE_SCOPE_COMMANDS, MACHINE_SCOPE_QUERIES } from '../../core/commands/registry'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { AgentSession } from '../../core/agent/session'
import { tempDir, testHost } from './host.fixture'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

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
  const ui = host.openSession({ kind: 'ui', id: 'win-1' })
  const agent = host.openSession({ kind: 'agent', id: 'stdio-1' })
  const value = async (s: typeof ui, name: string, args: object = {}) =>
    expectOk((await s.call(name, args)).result).value
  const status = async () => (await value(ui, 'run.status.get')) as RunStatus
  return { host, ui, agent, value, status, machine }
}

const rule = (r: Awaited<ReturnType<AgentSession['call']>>) =>
  expectErrCode(r.result, 'input.malformed').issues[0]?.rule

describe('machine scope (DF80)', { timeout: 60_000 }, () => {
  it('is a subset of the project scope: no new tools', async () => {
    const { host } = await setup()
    for (const c of MACHINE_SCOPE_COMMANDS)
      expect(host.registries.project.command(c.name).isSome(), c.name).toBe(true)
    for (const q of MACHINE_SCOPE_QUERIES)
      expect(host.registries.project.query(q.name).isSome(), q.name).toBe(true)
    // the plan-reading run commands are not in it
    for (const name of ['run.job.start', 'run.job.check', 'run.align.goto'])
      expect(host.machineScope.registry.command(name).isNone(), name).toBe(true)
  })

  it('without a project: connect a library machine, home, jog, zero, overrides, disconnect', async () => {
    const { ui, agent, value, status } = await setup()
    expect(ui.boundKey).toBeUndefined()
    const { id } = (await value(ui, 'library.machine.add', {
      values: libraryInput(machineValues()),
    })) as { id: string }
    // a plan needs a project
    const withPlan = await ui.call('run.connection.open', {
      target: 'virtual',
      planId: 'plan1',
      timeScale: 'max',
    })
    expect(rule(withPlan)).toBe('noProject')
    expect(rule(await ui.call('run.job.start', { planId: 'plan1' }))).toBe('noProject')
    expect(rule(await ui.call('project.log.list', {}))).toBe('noProject')

    await value(ui, 'run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' })
    expect((await status()).connection).toMatchObject({ state: 'open', target: 'virtual' })
    // homing is a job of the machine scope: job.wait and job.get follow it
    const { jobId } = (await value(ui, 'run.machine.home')) as { jobId: string }
    const waited = (await value(ui, 'job.wait', { jobId, timeoutSeconds: 30 })) as {
      state: string
      outcome?: { ok: boolean }
    }
    expect(waited).toMatchObject({ state: 'finished', outcome: { ok: true } })
    expect(await value(ui, 'job.get', { jobId })).toMatchObject({ state: 'finished' })
    expect((await status()).homed).toBe(true)

    await value(ui, 'run.machine.jog', { by: [-10, -10, -5], feed: 5000 })
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      const s = await status()
      if (s.state === 'Idle' && s.mpos[0] === -11) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect((await status()).mpos).toEqual([-11, -11, -6])
    const zero = (await value(ui, 'run.workZero.set', { axes: ['x', 'y', 'z'] })) as {
      workZero: number[]
    }
    expect(zero.workZero).toEqual([-11, -11, -6])
    await value(ui, 'run.override.set', { feed: '+10' })
    // an unbound agent may move the virtual machine (Q50: virtual only), with expectedRevision
    await value(agent, 'run.machine.jog', { by: [-1, 0, 0], feed: 2000, expectedRevision: 0 })
    await value(ui, 'run.connection.close')
    expect((await status()).connection.state).toBe('closed')
  })

  it('one connection for the instance: a bound session sees and controls it', async () => {
    const { ui, value, status } = await setup()
    const { id } = (await value(ui, 'library.machine.add', {
      values: libraryInput(machineValues()),
    })) as { id: string }
    await value(ui, 'run.connection.open', { target: 'virtual', machineId: id, timeScale: 'max' })
    const bound = ui
    await value(bound, 'project.create', { name: 'P', unitSystem: 'mm' })
    expect(bound.boundKey).toBeDefined()
    // through the project's dispatcher now: the same machine
    expect(((await value(bound, 'run.status.get')) as RunStatus).connection.state).toBe('open')
    expectErrCode(
      (await bound.call('run.connection.open', { target: 'virtual', machineId: id })).result,
      'run.busy',
    )
    await value(bound, 'run.connection.close')
    expect((await status()).connection.state).toBe('closed')
  })
})
