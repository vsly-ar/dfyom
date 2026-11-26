// Spec: docs/architecture/workers.md#automatic-evaluation-after-design-edits, #jobs-for-agents,
// Testing row "Unit, scheduler and cache".
import { describe, expect, it } from 'vitest'
import { fail, Ok, type AppResult } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createActionLog, type WritableActionLog } from '../commands/action-log'
import type { Timers } from '../commands/context'
import { createDispatcher, type Dispatcher } from '../commands/dispatcher'
import {
  createInProcessWorkers,
  inProcessWorkers,
  type WorkerControl,
  type WorkerPort,
  type WorkerTask,
} from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import type { PartEvaluation } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import type { DfmWarning, PartGeometryInput } from '../geometry/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { Library } from '../library/library'
import { createMemoryLibraryStorage } from '../library/memory-storage'
import { newProjectDoc, type ProjectDoc } from '../project/document'
import { testStock } from './design.fixture'
import {
  createEvaluationScheduler,
  mergeWarnings,
  type EvaluationScheduler,
  type EvaluationSource,
} from './evaluation'
import type { PartDTO } from './part.dto'

const ui = uiSource()
const settle = () => new Promise((r) => setTimeout(r, 0))

/** Timers that fire only on `advance`, moving the shared fake clock. */
function manualTimers(clock: ReturnType<typeof fakeClock>): Timers & { advance(ms: number): void } {
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    set(fn, ms) {
      pending.set(++seq, { at: clock.now() + ms, fn })
      return seq
    },
    clear(h) {
      pending.delete(h as number)
    },
    advance(ms) {
      const end = clock.now() + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (due === undefined) break
        pending.delete(due[0])
        clock.advance(due[1].at - clock.now())
        due[1].fn()
      }
      clock.advance(end - clock.now())
    },
  }
}

interface FakeRun {
  readonly input: PartGeometryInput
  readonly signal: AbortSignal
  resolve(r: AppResult<PartEvaluation>): void
}

/** Records each run; the test resolves it. Resolves `op.aborted` on abort (like the pool) unless told not to. */
function fakePort(opts: { ignoreAbort?: boolean } = {}) {
  const runs: FakeRun[] = []
  const port: WorkerPort = {
    run<I, O>(_task: WorkerTask<I, O>, input: I, ctl: WorkerControl) {
      return new Promise<AppResult<O>>((resolve) => {
        runs.push({
          input: input as PartGeometryInput,
          signal: ctl.signal,
          resolve: resolve as (r: AppResult<PartEvaluation>) => void,
        })
        if (!opts.ignoreAbort)
          ctl.signal.addEventListener(
            'abort',
            () => resolve(fail('op.aborted', 'aborted') as AppResult<O>),
            { once: true },
          )
      })
    },
  }
  return { runs, port }
}

const evaluation = (warnings: DfmWarning[] = []): PartEvaluation => ({
  positions: new Float32Array(3),
  indices: new Uint32Array(3),
  triangleSurface: new Uint32Array(1),
  surfaces: [],
  volume: 1,
  pieces: 1,
  construction: [],
  warnings,
  stats: { ms: 1, triangles: 1 },
})

const facingDepth = (r: FakeRun) => {
  const op = r.input.operations[0]
  return op?.kind === 'facing' ? op.depth : undefined
}

interface Setup {
  readonly d: Dispatcher
  readonly scheduler: EvaluationScheduler
  readonly timers: ReturnType<typeof manualTimers>
  readonly clock: ReturnType<typeof fakeClock>
  readonly runs: FakeRun[]
  readonly partId: string
  run(name: string, args: object): Promise<unknown>
  setDepth(depth: string): Promise<unknown>
  status(): string
}

/**
 * A project with one part (a facing of 0.5) and the scheduler attached after it was built, so
 * the attach starts one evaluation (`runs[0]`) at once.
 */
async function setup(
  opts: { workers?: WorkerPort; ignoreAbort?: boolean; evaluations?: false; part?: object[] } = {},
): Promise<Setup> {
  const clock = fakeClock(1_000)
  const timers = manualTimers(clock)
  const fake = fakePort({ ignoreAbort: opts.ignoreAbort ?? false })
  const scheduler = createEvaluationScheduler({ workers: opts.workers ?? fake.port, timers, clock })
  const library = expectOk(await Library.open(createMemoryLibraryStorage()))
  const d = createDispatcher({
    registry: expectOk(createAppRegistry()),
    doc: newProjectDoc({ name: 'Bracket', unitSystem: 'mm' }),
    ids: fakeIds(),
    clock,
    services: {
      workers: opts.workers ?? inProcessWorkers,
      library,
      ...(opts.evaluations === false ? {} : { evaluations: scheduler }),
    },
  })
  const run = async (name: string, args: object) => expectOk(await d.dispatch(name, args, ui)).value
  const stock = (await run('library.stock.add', { values: testStock() })) as { id: string }
  const { partId } = (await run('design.part.add', {
    name: 'Bracket',
    stockLibraryItemId: stock.id,
  })) as { partId: string }
  for (const [name, args] of (opts.part as [string, object][] | undefined) ?? [
    ['design.facing.add', { depth: '0.5' }],
  ])
    await run(name, { partId, ...args })
  scheduler.attach(d)
  return {
    d,
    scheduler,
    timers,
    clock,
    runs: fake.runs,
    partId,
    run,
    setDepth: (depth) => run('design.facing.update', { partId, operationId: 'facing1', depth }),
    status: () => scheduler.state(d.doc, partId).status,
  }
}

async function finish(r: FakeRun, result: AppResult<PartEvaluation> = Ok(evaluation())) {
  r.resolve(result)
  await settle()
}

describe('automatic evaluation', () => {
  it('evaluates every part at attach, then only after 200 ms without edits (trailing, no max wait)', async () => {
    const s = await setup()
    expect(s.runs).toHaveLength(1)
    expect(s.status()).toBe('pending')
    await finish(s.runs[0]!)
    expect(s.status()).toBe('done')
    // edits every 150 ms: nothing is requested while they keep arriving
    for (const depth of ['0.6', '0.7', '0.8', '0.9', '1']) {
      await s.setDepth(depth)
      expect(s.status()).toBe('pending')
      s.timers.advance(150)
    }
    expect(s.runs).toHaveLength(1)
    s.timers.advance(49)
    expect(s.runs).toHaveLength(1)
    s.timers.advance(1)
    expect(s.runs).toHaveLength(2)
    expect(facingDepth(s.runs[1]!)).toBe(1) // the latest input only
    await finish(s.runs[1]!)
    expect(s.status()).toBe('done')
  })

  it('tells listeners when a part may have changed state (window mesh push)', async () => {
    const s = await setup()
    const seen: string[] = []
    const off = s.scheduler.onChange((partId) =>
      seen.push(`${partId}:${s.scheduler.state(s.d.doc, partId).status}`),
    )
    await finish(s.runs[0]!)
    expect(seen).toEqual([`${s.partId}:done`])
    await s.setDepth('1')
    expect(seen.at(-1)).toBe(`${s.partId}:pending`)
    s.timers.advance(200)
    await finish(s.runs[1]!)
    expect(seen.at(-1)).toBe(`${s.partId}:done`)
    // a rename keeps the input: no notification
    const n = seen.length
    await s.run('design.part.update', { partId: s.partId, name: 'Renamed' })
    expect(seen).toHaveLength(n)
    off()
    await s.setDepth('2')
    expect(seen).toHaveLength(n)
  })

  it('a newer revision aborts the running evaluation at once and debounces again', async () => {
    const s = await setup()
    await finish(s.runs[0]!)
    await s.setDepth('1')
    s.timers.advance(200)
    const running = s.runs[1]!
    expect(running.signal.aborted).toBe(false)
    await s.setDepth('2')
    expect(running.signal.aborted).toBe(true)
    await settle()
    expect(s.runs).toHaveLength(2)
    s.timers.advance(200)
    expect(s.runs).toHaveLength(3)
    expect(facingDepth(s.runs[2]!)).toBe(2)
  })

  it('an unchanged input hash (a rename) does nothing', async () => {
    const s = await setup()
    await finish(s.runs[0]!)
    await s.run('design.part.update', { partId: s.partId, name: 'Renamed' })
    s.timers.advance(1_000)
    expect(s.runs).toHaveLength(1)
    expect(s.status()).toBe('done')
  })

  it('drops a result that finished after its abort (straggler); the next one runs after it', async () => {
    const s = await setup({ ignoreAbort: true })
    const before = s.d.doc
    await s.setDepth('1') // aborts runs[0], whose worker still answers later
    s.timers.advance(200)
    expect(s.runs).toHaveLength(1) // one evaluation at a time: waits for the straggler
    await finish(s.runs[0]!)
    expect(s.scheduler.state(before, s.partId).status).toBe('pending') // not stored
    expect(s.runs).toHaveLength(2)
    expect(facingDepth(s.runs[1]!)).toBe(1)
  })

  it('undo back to an evaluated input is done after the debounce, without a worker run', async () => {
    const s = await setup()
    await finish(s.runs[0]!)
    await s.setDepth('1')
    s.timers.advance(200)
    await finish(s.runs[1]!)
    expectOk(await s.d.dispatch('history.undo', {}, ui))
    expect(s.status()).toBe('pending') // nothing shown until edits stop + 200 ms
    s.timers.advance(200)
    expect(s.status()).toBe('done')
    expectOk(await s.d.dispatch('history.redo', {}, ui))
    expect(s.status()).toBe('pending')
    s.timers.advance(200)
    expect(s.status()).toBe('done')
    expect(s.runs).toHaveLength(2)
  })

  it('a drag back over an evaluated value shows nothing until the edits stop', async () => {
    const s = await setup()
    await finish(s.runs[0]!) // depth 0.5 evaluated
    await s.setDepth('0.6')
    s.timers.advance(100)
    await s.setDepth('0.5') // back to a cached input mid-drag
    expect(s.status()).toBe('pending')
    s.timers.advance(199)
    expect(s.status()).toBe('pending')
    s.timers.advance(1)
    expect(s.status()).toBe('done')
    expect(s.runs).toHaveLength(1)
  })

  it.each([
    ['internal.unexpected', 'worker lane unavailable'],
    ['op.timeout', 'took too long'],
    ['op.aborted', 'the worker pool was closed'],
  ] as const)(
    'a transient %s is not cached by hash: design.part.evaluate runs it again',
    async (code, message) => {
      const s = await setup()
      const waiter = s.scheduler.evaluate(s.partId, new AbortController().signal)
      await finish(s.runs[0]!, fail(code, message))
      expect(s.runs).toHaveLength(2) // retried once
      await finish(s.runs[1]!, fail(code, message))
      const first = expectOk(await waiter) // joined waiters are answered, never left hanging
      expect(first).toMatchObject({ status: 'failed', error: { code } })
      expect(s.scheduler.state(s.d.doc, s.partId)).toMatchObject({ status: 'failed' })
      const again = s.scheduler.evaluate(s.partId, new AbortController().signal)
      await settle()
      expect(s.runs).toHaveLength(3)
      await finish(s.runs[2]!)
      expect(expectOk(await again).status).toBe('done')
    },
  )

  it('a second attach is a close then an attach: waiters end, the part is evaluated again', async () => {
    const s = await setup()
    const waiter = s.scheduler.evaluate(s.partId, new AbortController().signal)
    s.scheduler.attach(s.d)
    expectErrCode(await waiter, 'op.aborted')
    expect(s.runs[0]!.signal.aborted).toBe(true)
    await settle()
    expect(s.runs).toHaveLength(2)
    await finish(s.runs[1]!)
    expect(s.status()).toBe('done')
  })

  it('a deterministic error is stored as failed and not retried', async () => {
    const s = await setup()
    await finish(s.runs[0]!, fail('geometry.evaluation', 'boom'))
    const st = s.scheduler.state(s.d.doc, s.partId)
    expect(st.status).toBe('failed')
    expect(st.error?.code).toBe('geometry.evaluation')
    s.timers.advance(1_000)
    expect(s.runs).toHaveLength(1)
  })

  it.each(['internal.unexpected', 'op.timeout'] as const)(
    '%s is retried once, then stored as failed',
    async (code) => {
      const s = await setup()
      await finish(s.runs[0]!, fail(code, 'worker trouble'))
      expect(s.runs).toHaveLength(2)
      expect(s.status()).toBe('pending')
      await finish(s.runs[1]!, fail(code, 'worker trouble again'))
      expect(s.runs).toHaveLength(2)
      expect(s.scheduler.state(s.d.doc, s.partId).error?.code).toBe(code)
      // a retry that succeeds is stored
      const t = await setup()
      await finish(t.runs[0]!, fail(code, 'once'))
      await finish(t.runs[1]!)
      expect(t.status()).toBe('done')
    },
  )
})

describe('several parts (hand-made source; v0.1 projects have one part)', () => {
  /** Part DTOs of the setup's part at facing depths 0.5, 1, 2 and then `more`. */
  async function versions(more: string[] = []) {
    const s = await setup()
    const v: PartDTO[] = [s.d.doc.parts[s.partId]!]
    for (const depth of ['1', '2', ...more]) {
      await s.setDepth(depth)
      v.push(s.d.doc.parts[s.partId]!)
    }
    s.scheduler.close()
    return { base: s.d.doc, v }
  }

  function handSource(base: ProjectDoc, parts: Record<string, PartDTO>) {
    const log: WritableActionLog = createActionLog()
    const src = { doc: { ...base, parts } as ProjectDoc, revision: 1, log }
    const commit = (parts: Record<string, PartDTO>, partId: string, op: 'replace' | 'remove') => {
      src.doc = { ...src.doc, parts }
      src.revision += 1
      log.append({
        type: 'command',
        name: 'design.facing.update',
        args: {},
        outcome: { ok: true, value: {} },
        patches: [
          { op, path: ['parts', partId], ...(op === 'replace' ? { value: parts[partId] } : {}) },
        ],
        at: '2026-11-17T10:00:00.000Z',
        source: ui,
        revision: src.revision,
      })
    }
    return { src: src as EvaluationSource & typeof src, commit }
  }

  const as = (dto: PartDTO, id: string): PartDTO => ({ ...dto, id })

  it('serves the most recently edited part first', async () => {
    // distinct inputs everywhere: an input another part has is served from its result
    const { base, v } = await versions(['3', '4', '5'])
    const clock = fakeClock(0)
    const timers = manualTimers(clock)
    const fake = fakePort()
    const sch = createEvaluationScheduler({ workers: fake.port, timers, clock })
    const parts = { a: as(v[3]!, 'a'), b: as(v[4]!, 'b'), c: as(v[5]!, 'c') }
    const h = handSource(base, parts)
    sch.attach(h.src)
    for (let i = 0; i < 3; i++) await finish(fake.runs[i]!) // one at a time
    expect(fake.runs).toHaveLength(3)
    // c runs long; meanwhile a, then b are edited and both become due
    h.commit({ ...h.src.doc.parts, c: as(v[1]!, 'c') }, 'c', 'replace')
    timers.advance(200)
    expect(fake.runs).toHaveLength(4)
    h.commit({ ...h.src.doc.parts, a: as(v[0]!, 'a') }, 'a', 'replace')
    timers.advance(50)
    h.commit({ ...h.src.doc.parts, b: as(v[2]!, 'b') }, 'b', 'replace')
    timers.advance(300)
    expect(fake.runs).toHaveLength(4)
    await finish(fake.runs[3]!)
    expect(facingDepth(fake.runs[4]!)).toBe(2) // b, edited last
    await finish(fake.runs[4]!)
    expect(facingDepth(fake.runs[5]!)).toBe(0.5) // then a
  })

  it('a removed part aborts its evaluation and its waiters', async () => {
    const { base, v } = await versions()
    const clock = fakeClock(0)
    const fake = fakePort()
    const sch = createEvaluationScheduler({
      workers: fake.port,
      timers: manualTimers(clock),
      clock,
    })
    const h = handSource(base, { a: as(v[0]!, 'a') })
    sch.attach(h.src)
    const waiting = sch.evaluate('a', new AbortController().signal)
    const running = fake.runs[0]!
    h.commit({}, 'a', 'remove')
    expect(running.signal.aborted).toBe(true)
    expectErrCode(await waiting, 'op.aborted')
    await settle()
    expect(fake.runs).toHaveLength(1)
  })

  it('a result for the current input is stored even if its revision is not newer', async () => {
    const { base, v } = await versions()
    const clock = fakeClock(0)
    const timers = manualTimers(clock)
    const fake = fakePort()
    const sch = createEvaluationScheduler({ workers: fake.port, timers, clock })
    const h = handSource(base, { a: as(v[0]!, 'a') })
    h.src.revision = 20
    sch.attach(h.src)
    await finish(fake.runs[0]!) // stored at revision 20
    h.src.revision = 5 // e.g. another dispatcher's numbering after a re-attach
    h.commit({ a: as(v[1]!, 'a') }, 'a', 'replace')
    const waiter = sch.evaluate('a', new AbortController().signal)
    await settle()
    expect(fake.runs).toHaveLength(2)
    await finish(fake.runs[1]!)
    expect(sch.state(h.src.doc, 'a').status).toBe('done')
    expect(expectOk(await waiter).status).toBe('done')
  })

  it('an input that cannot be built is failed without a worker run', async () => {
    const { base, v } = await versions()
    const clock = fakeClock(0)
    const fake = fakePort()
    const sch = createEvaluationScheduler({
      workers: fake.port,
      timers: manualTimers(clock),
      clock,
    })
    const broken = { ...as(v[0]!, 'a'), stock: 'missing-snapshot' }
    const h = handSource(base, { a: broken })
    sch.attach(h.src)
    await settle()
    expect(fake.runs).toHaveLength(0)
    const st = sch.state(h.src.doc, 'a')
    expect(st.status).toBe('failed')
    expect(st.error?.code).toBe('input.malformed')
    expect(expectOk(await sch.evaluate('a', new AbortController().signal)).status).toBe('failed')
  })
})

describe('design.warning.list and design.part.evaluate', () => {
  const warningList = (s: Setup) =>
    expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: DfmWarning[]
      construction: unknown[]
      evaluation: string
      error?: { code: string }
    }

  const startJob = async (s: Setup) => {
    const { jobId } = (await s.run('design.part.evaluate', { partId: s.partId })) as {
      jobId: string
    }
    return s.d.job(jobId).unwrap()
  }

  // profile without tabs: a parameter warning (dfm.tabsNone) and a geometry one (dfm.loosePiece)
  const noTabs: object[] = [
    ['design.facing.add', { depth: '0.5' }],
    [
      'design.profile.add',
      {
        shape: {
          kind: 'rectangle',
          center: ['50', '30'],
          length: '84',
          width: '44',
          cornerRadius: '5',
        },
        slotWidth: '6',
        tabs: { count: '0' },
      },
    ],
  ]

  it('merges the geometry warnings of a done evaluation in design order (real worker)', async () => {
    const workers = createInProcessWorkers({ solids: () => loadManifold(nodeManifoldSource()) })
    const s = await setup({ workers, part: noTabs })
    const pending = warningList(s)
    expect(pending.evaluation).toBe('pending')
    expect(pending.warnings.map((w) => w.code)).not.toContain('dfm.loosePiece')
    const job = await startJob(s)
    const r = expectOk(await job.result) as { evaluation: string; warnings: DfmWarning[] }
    expect(r.evaluation).toBe('done')
    const done = warningList(s)
    expect(done.evaluation).toBe('done')
    expect(done.warnings).toEqual(r.warnings)
    const codes = done.warnings.map((w) => `${w.operation} ${w.code}`)
    expect(codes).toContain('profile1 dfm.loosePiece')
    // parameter warnings first within an operation
    expect(codes.indexOf('profile1 dfm.tabsNone')).toBeLessThan(
      codes.indexOf('profile1 dfm.loosePiece'),
    )
    expect(done.warnings.slice(0, pending.warnings.length)).toEqual(
      expect.arrayContaining(pending.warnings.filter((w) => w.operation !== 'profile1')),
    )
  })

  // DF118 V2: the user's clamps_40 (TG #369), the chamfer wide enough to cut the recess floor away
  const clamps: object[] = [
    ['design.facing.add', { depth: '0.3' }],
    ['design.facing.add', { on: 'stock.bottom', depth: '0.3' }],
    [
      'design.pocket.add',
      {
        on: 'facing2.floor',
        depth: '2',
        shape: {
          kind: 'rectangle',
          center: ['30', '22'],
          length: '11.3',
          width: '31',
          cornerRadius: '5.6',
        },
      },
    ],
    [
      'design.pocket.add',
      {
        on: 'pocket1.floor',
        depth: '7.8',
        shape: {
          kind: 'rectangle',
          center: ['30', '22'],
          length: '5.5',
          width: '25',
          cornerRadius: '2.5',
        },
      },
    ],
    ['design.chamfer.add', { edgeOf: 'pocket2', on: 'pocket1.floor', width: '3.2', angle: '90' }],
  ]

  it('lists the construction surfaces of a done evaluation, without their patches (DF118 V2)', async () => {
    const workers = createInProcessWorkers({
      solids: () => loadManifold(nodeManifoldSource()),
      region2d: () => Ok(nodeRegion2d()),
    })
    const s = await setup({ workers, part: clamps })
    expect(warningList(s)).toMatchObject({ evaluation: 'pending', construction: [] })
    const job = await startJob(s)
    const r = expectOk(await job.result) as { construction: unknown[]; warnings: DfmWarning[] }
    const expected = [
      {
        surface: 'pocket1.floor',
        consumedBy: ['pocket2', 'chamfer1'],
        referencedBy: [
          { operationId: 'pocket2', param: 'on' },
          { operationId: 'chamfer1', param: 'on' },
        ],
      },
    ]
    expect(r.construction).toEqual(expected)
    expect(r.warnings.map((w) => w.code)).not.toContain('dfm.surfaceCutAway')
    expect(warningList(s).construction).toEqual(expected)
  })

  it('a failed evaluation returns the parameter warnings and the error', async () => {
    const s = await setup({ part: noTabs })
    const params = warningList(s).warnings
    await finish(s.runs[0]!, fail('geometry.evaluation', 'boom'))
    const failed = warningList(s)
    expect(failed).toMatchObject({ evaluation: 'failed', error: { code: 'geometry.evaluation' } })
    expect(failed.warnings).toEqual(params)
  })

  it('the job joins a running evaluation of the same input (one worker run)', async () => {
    const s = await setup()
    const job = await startJob(s)
    await settle()
    expect(s.runs).toHaveLength(1)
    await finish(s.runs[0]!, Ok(evaluation()))
    expect(expectOk(await job.result)).toEqual({
      evaluation: 'done',
      warnings: [],
      construction: [],
    })
  })

  it('the job skips the debounce', async () => {
    const s = await setup()
    await finish(s.runs[0]!)
    await s.setDepth('1')
    const job = await startJob(s)
    await settle()
    expect(s.runs).toHaveLength(2) // no timer advanced
    expect(facingDepth(s.runs[1]!)).toBe(1)
    await finish(s.runs[1]!)
    expect(expectOk(await job.result)).toMatchObject({ evaluation: 'done' })
  })

  it('a newer revision of the part aborts the job', async () => {
    const s = await setup()
    const job = await startJob(s)
    await settle()
    await s.setDepth('1')
    expectErrCode(await job.result, 'op.aborted')
  })

  it('fails without an evaluation service', async () => {
    const s = await setup({ evaluations: false })
    const job = await startJob(s)
    expectErrCode(await job.result, 'internal.unexpected')
  })
})

describe('plan parts (snapshot scene, plan-v0.2.md)', () => {
  /** The setup's part evaluated, then a plan of it (debounce over). */
  async function withPlan(status: 'draft' | 'settledDesign' = 'settledDesign') {
    const s = await setup()
    await finish(s.runs[0]!)
    const seen: string[] = []
    s.scheduler.onPlanChange((id) => seen.push(id))
    const { planId } = (await s.run('plan.create', { partId: s.partId })) as { planId: string }
    if (status === 'settledDesign')
      await s.run('plan.status.set', { planId, status: 'settledDesign' })
    s.timers.advance(200)
    await settle()
    const plan = () => s.scheduler.planState(s.d.doc, planId)
    const part = () => s.scheduler.state(s.d.doc, s.partId)
    return { s, planId, plan, part, seen }
  }

  it("an unedited plan's part is served from the design part's result (same hash, no run)", async () => {
    const { s, planId, plan, part, seen } = await withPlan()
    expect(s.runs).toHaveLength(1)
    expect(plan().status).toBe('done')
    expect(plan().inputHash).toBe(part().inputHash)
    expect(plan().evaluation).toBe(part().evaluation)
    expect(seen).toContain(planId)
  })

  it("a plan-only edit evaluates the plan's part; revert and undo come back from the cache", async () => {
    const { s, planId, plan, part } = await withPlan()
    const designHash = part().inputHash
    await s.run('plan.design.operation.update', { planId, operationId: 'facing1', depth: '1' })
    expect(plan().status).toBe('pending')
    s.timers.advance(200)
    expect(s.runs).toHaveLength(2)
    expect(facingDepth(s.runs[1]!)).toBe(1) // the plan's version, not the design's 0.5
    await finish(s.runs[1]!)
    expect(plan().status).toBe('done')
    const editedHash = plan().inputHash
    expect(editedHash).not.toBe(designHash)
    expect(part()).toMatchObject({ status: 'done', inputHash: designHash }) // untouched
    const planOperationId = s.d.doc.plans[planId]!.setups[0]!.operations[0]!.id
    await s.run('plan.design.operation.revert', { planId, planOperationId })
    s.timers.advance(200)
    expect(plan()).toMatchObject({ status: 'done', inputHash: designHash })
    expectOk(await s.d.dispatch('history.undo', {}, ui))
    s.timers.advance(200)
    expect(plan()).toMatchObject({ status: 'done', inputHash: editedHash })
    expect(s.runs).toHaveLength(2)
  })

  it('a design edit leaves a settled plan alone; a following draft plan shares the new result', async () => {
    const settled = await withPlan()
    await settled.s.setDepth('2')
    settled.s.timers.advance(200)
    expect(settled.s.runs).toHaveLength(2)
    expect(facingDepth(settled.s.runs[1]!)).toBe(2)
    expect(settled.plan().status).toBe('done') // still the snapshot's 0.5
    const draft = await withPlan('draft')
    await draft.s.setDepth('2')
    await draft.s.run('project.apply', {}) // the draft follows the new design on Apply
    draft.s.timers.advance(200)
    expect(draft.s.runs).toHaveLength(2)
    expect(draft.plan().status).toBe('pending')
    await finish(draft.s.runs[1]!)
    expect(draft.s.runs).toHaveLength(2)
    expect(draft.plan()).toMatchObject({ status: 'done', inputHash: draft.part().inputHash })
  })

  it('evaluatePlan skips the debounce and waits; unknown and removed plans', async () => {
    const { s, planId, plan, seen } = await withPlan()
    await s.run('plan.design.operation.update', { planId, operationId: 'facing1', depth: '1' })
    const waiting = s.scheduler.evaluatePlan(planId, new AbortController().signal)
    expect(s.runs).toHaveLength(2)
    await finish(s.runs[1]!)
    expect(expectOk(await waiting).status).toBe('done')
    expectErrCode(
      await s.scheduler.evaluatePlan('nope', new AbortController().signal),
      'input.malformed',
    )
    seen.length = 0
    await s.run('plan.remove', { planId, confirm: true })
    expect(seen).toEqual([planId])
    expect(plan()).toMatchObject({ status: 'failed', error: { code: 'input.malformed' } })
  })
})

describe('mergeWarnings', () => {
  const w = (operation: string, code: DfmWarning['code']): DfmWarning => ({
    code,
    severity: 'warning',
    message: '',
    operation,
    params: {},
  })
  it('orders by design order, parameter warnings first within an operation, unknown ids last', () => {
    const merged = mergeWarnings(
      [w('pocket1', 'dfm.cornerSharp'), w('facing1', 'dfm.facingDeep')],
      [w('stock', 'dfm.loosePiece'), w('pocket1', 'dfm.retainedRemoved')],
      ['facing1', 'pocket1'],
    )
    expect(merged.map((x) => `${x.operation} ${x.code}`)).toEqual([
      'facing1 dfm.facingDeep',
      'pocket1 dfm.cornerSharp',
      'pocket1 dfm.retainedRemoved',
      'stock dfm.loosePiece',
    ])
  })
})
