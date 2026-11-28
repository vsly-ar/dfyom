// The calibration cut commands on the virtual machine (v0.5 RV9).
// Spec: docs/modes/run-calibration.md
import { afterEach, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { AppResult } from '../../shared/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeIds, uiSource } from '../commands/testing'
import { testStock } from '../design/design.fixture'
import { planSetup } from '../plan/plan.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { systemTimerHost } from './clock'
import { MachineClient } from './host/client'
import { inProcessHostFactory } from './host/in-process'
import type { RunStatus } from './service'

const ui = uiSource()
const clients: MachineClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

async function waitFor(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

async function setup() {
  // room beside the test part (100 × 60 of the stock, its profile reaches the edges)
  const s = await planSetup({ stock: { ...testStock(), length: '180' } })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // the fixture's drill has no feeds (as run commands.test.ts)
  const ops = s.plan(planId).setups.at(-1)!.operations
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
      machine: client,
    },
  })
  const run = async (name: string, args: object, source = ui): Promise<AppResult<unknown>> =>
    (await d.dispatch(name, args, source)).map((o) => o.value)
  const status = () => expectOk(d.query('run.status.get', {}, ui)).value as RunStatus
  return { s, planId, d, run, status }
}

interface Checked {
  at: [number, number]
  footprint: { x: [number, number]; y: [number, number] }
  stockTop: { x: [number, number]; y: [number, number] }
  lines: string[]
  problems: { rule: string }[]
  findings: unknown[]
  travelChecked: boolean
  toolId: string
}

describe('run.calibration.*', { timeout: 60_000 }, () => {
  it('checks a spot, refuses a bad one and runs the dimension test to its end', async () => {
    const t = await setup()
    // without a connection: a free spot, the program, no travel check
    const free = expectOk(
      await t.run('run.calibration.check', { planId: t.planId, test: 'dimension' }),
    ) as Checked
    expect(free.problems).toEqual([])
    expect(free.travelChecked).toBe(false)
    expect(free.footprint.x[0]).toBeGreaterThanOrEqual(free.stockTop.x[0] + 2 - 1e-9)
    expect(free.footprint.x[1]).toBeLessThanOrEqual(free.stockTop.x[1] - 2 + 1e-9)
    expect(free.lines.some((l) => l.startsWith('M0 '))).toBe(true)
    // the part's operations are kept out of: the stock's centre is taken
    const mid: [number, number] = [
      (free.stockTop.x[0] + free.stockTop.x[1]) / 2,
      (free.stockTop.y[0] + free.stockTop.y[1]) / 2,
    ]
    const taken = expectOk(
      await t.run('run.calibration.check', { planId: t.planId, test: 'dimension', at: mid }),
    ) as Checked
    expect(taken.problems.map((p) => p.rule)).toContain('operation')
    // an earlier cut at the free spot is kept out of too
    const avoided = expectOk(
      await t.run('run.calibration.check', {
        planId: t.planId,
        test: 'dimension',
        at: free.at,
        avoid: [free.footprint],
      }),
    ) as Checked
    expect(avoided.problems.map((p) => p.rule)).toContain('earlierCut')

    expectOk(
      await t.run('run.connection.open', {
        target: 'virtual',
        planId: t.planId,
        timeScale: 'max',
        prepare: true,
      }),
    )
    const live = expectOk(
      await t.run('run.calibration.check', { planId: t.planId, test: 'feedLadder' }),
    ) as Checked
    expect(live.travelChecked).toBe(true)
    expect(live.findings).toEqual([])
    // a spot with a problem does not start
    const refused = expectOk(
      await t.run('run.calibration.start', { planId: t.planId, test: 'dimension', at: mid }),
    ) as { jobId: string }
    expectErrCode(await t.d.job(refused.jobId).unwrap().result, 'plan.check')

    const { jobId } = expectOk(
      await t.run('run.calibration.start', { planId: t.planId, test: 'dimension', at: free.at }),
    ) as { jobId: string }
    const result = t.d.job(jobId).unwrap().result
    let done = false
    void result.then(() => (done = true))
    // the program waits for the tool and its Z zero first, then every wait is continued
    const waits: string[] = []
    for (;;) {
      expect(
        await waitFor(() => {
          const p = t.status().job?.phase
          return done || p === 'toolChange' || p === 'programPause'
        }),
      ).toBe(true)
      if (done) break
      const job = t.status().job!
      waits.push(job.phase)
      expectOk(
        await t.run(
          'run.job.continue',
          job.phase === 'toolChange'
            ? { jobId, toolChange: job.toolChange!.n }
            : { jobId, pause: job.pause! },
        ),
      )
      // the next wait is another one (a pause right after the tool change is a new line)
      await waitFor(() => done || t.status().job?.line !== job.line)
    }
    expect(waits[0]).toBe('toolChange')
    const summary = expectOk(await result) as { toolChanges: number; footprint: unknown }
    expect(summary).toMatchObject({ toolChanges: 1, footprint: free.footprint })
    // no plan run recorded: nothing marked cut, nothing to resume
    expect(t.status().lastRun).toBeUndefined()
  })
})
