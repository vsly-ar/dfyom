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

  it('undo back to an evaluated input is done without a worker run', async () => {
    const s = await setup()
    await finish(s.runs[0]!)
    await s.setDepth('1')
    s.timers.advance(200)
    await finish(s.runs[1]!)
    expectOk(await s.d.dispatch('history.undo', {}, ui))
    expect(s.status()).toBe('done')
    s.timers.advance(200)
    expectOk(await s.d.dispatch('history.redo', {}, ui))
    s.timers.advance(200)
    expect(s.status()).toBe('done')
    expect(s.runs).toHaveLength(2)
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
  /** Part DTOs of the setup's part at facing depths 0.5, 1 and 2. */
  async function versions() {
    const s = await setup()
    const v: PartDTO[] = [s.d.doc.parts[s.partId]!]
    for (const depth of ['1', '2']) {
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
    const { base, v } = await versions()
    const clock = fakeClock(0)
    const timers = manualTimers(clock)
    const fake = fakePort()
    const sch = createEvaluationScheduler({ workers: fake.port, timers, clock })
    const parts = { a: as(v[0]!, 'a'), b: as(v[0]!, 'b'), c: as(v[0]!, 'c') }
    const h = handSource(base, parts)
    sch.attach(h.src)
    for (let i = 0; i < 3; i++) await finish(fake.runs[i]!) // one at a time
    expect(fake.runs).toHaveLength(3)
    // c runs long; meanwhile a, then b are edited and both become due
    h.commit({ ...h.src.doc.parts, c: as(v[1]!, 'c') }, 'c', 'replace')
    timers.advance(200)
    expect(fake.runs).toHaveLength(4)
    h.commit({ ...h.src.doc.parts, a: as(v[1]!, 'a') }, 'a', 'replace')
    timers.advance(50)
    h.commit({ ...h.src.doc.parts, b: as(v[2]!, 'b') }, 'b', 'replace')
    timers.advance(300)
    expect(fake.runs).toHaveLength(4)
    await finish(fake.runs[3]!)
    expect(facingDepth(fake.runs[4]!)).toBe(2) // b, edited last
    await finish(fake.runs[4]!)
    expect(facingDepth(fake.runs[5]!)).toBe(1) // then a
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
    expect(expectOk(await job.result)).toEqual({ evaluation: 'done', warnings: [] })
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
