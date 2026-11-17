// Spec: docs/architecture/workers.md#lanes-and-pool, #worker-death-timeouts-and-restart,
// #wasm-lifetime (pool against a fake factory, fake timers and a fake clock)
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from '../../shared/errors/app-error'
import { Err, Ok, toWire, type AppResult } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { PauseState, Timers } from '../commands/context'
import type { Lane, WorkerTask } from '../commands/jobs'
import { createWorkerPool, type PoolOptions, type WorkerEvents } from './pool'
import { PROTOCOL_VERSION, type HostMessage } from './protocol'

const task = (name: string, lane: Lane, timeoutMs = 1_000): WorkerTask<number, number> => ({
  name,
  lane,
  input: z.number(),
  output: z.number(),
  timeoutMs,
  run: (n) => Ok(n),
})
const tp = task('test.tp', 'toolpath')
const geo = task('test.geo', 'geometry')

interface FakeWorker {
  readonly lane: Lane
  readonly workerId: string
  readonly events: WorkerEvents
  readonly posted: HostMessage[]
  terminated: boolean
  idle: boolean | undefined
}

function fakeTimers() {
  let t = 0
  let seq = 0
  const queue = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      queue.set(id, { at: t + ms, fn })
      return id
    },
    clear: (h) => void queue.delete(h as number),
  }
  return {
    timers,
    now: () => t,
    advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (due === undefined) break
        queue.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = end
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup(over: Partial<PoolOptions> = {}) {
  const workers: FakeWorker[] = []
  const clock = fakeTimers()
  const wasm = new ArrayBuffer(16)
  const pool = createWorkerPool({
    factory: ({ lane, workerId }, events) => {
      const w: FakeWorker = {
        lane,
        workerId,
        events,
        posted: [],
        terminated: false,
        idle: undefined,
      }
      workers.push(w)
      return {
        post: (m) => void w.posted.push(m),
        terminate: () => void (w.terminated = true),
        setIdle: (idle) => void (w.idle = idle),
      }
    },
    timers: clock.timers,
    now: clock.now,
    wasm: () => wasm,
    ...over,
  })
  const ready = (w: FakeWorker, protocol = PROTOCOL_VERSION) =>
    w.events.message({ type: 'ready', protocol, workerId: w.workerId, initMs: 1 })
  const runs = (w: FakeWorker) =>
    w.posted.filter((m): m is Extract<HostMessage, { type: 'run' }> => m.type === 'run')
  const lastRun = (w: FakeWorker) => runs(w).at(-1)!
  const reply = (
    w: FakeWorker,
    result: AppResult<unknown>,
    stats: Record<string, number> = { ms: 1 },
    id = lastRun(w).id,
  ) => w.events.message({ type: 'result', id, result: toWire(result), stats })
  /** Starts a run; `state()` tells whether it settled yet. */
  const start = <I, O>(
    t: WorkerTask<I, O>,
    input: I,
    ctl: { signal?: AbortSignal; pause?: PauseState } = {},
  ) => {
    let out: AppResult<O> | undefined
    const ac = new AbortController()
    const promise = pool
      .run(t, input, {
        signal: ctl.signal ?? ac.signal,
        progress: () => {},
        ...(ctl.pause === undefined ? {} : { pause: ctl.pause }),
      })
      .then((r) => (out = r))
    return { promise, abort: () => ac.abort(), settled: () => out }
  }
  return { pool, workers, clock, wasm, ready, runs, lastRun, reply, start }
}

describe('worker pool', () => {
  it('spawns lazily, sends init (wasm only to geometry) and runs after ready', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    expect(s.workers).toHaveLength(1)
    const w = s.workers[0]!
    expect(w.posted[0]).toMatchObject({
      type: 'init',
      lane: 'toolpath',
      protocol: PROTOCOL_VERSION,
    })
    expect(w.posted[0]).not.toHaveProperty('wasm')
    expect(s.runs(w)).toHaveLength(0)
    s.ready(w)
    expect(s.lastRun(w)).toMatchObject({ task: 'test.tp', input: 1 })
    expect(w.idle).toBe(false)
    s.reply(w, Ok(2))
    expect(expectOk(await a.promise)).toBe(2)
    expect(w.idle).toBe(true)
    s.start(geo, 1)
    expect(s.workers[1]!.posted[0]).toMatchObject({ type: 'init', lane: 'geometry', wasm: s.wasm })
  })

  it('queues FIFO per lane; the geometry lane never waits behind the toolpath lane', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const b = s.start(tp, 2)
    const w = s.workers[0]!
    s.ready(w)
    expect(s.runs(w)).toHaveLength(1)
    const g = s.start(geo, 9)
    const gw = s.workers[1]!
    s.ready(gw)
    s.reply(gw, Ok(9))
    expect(expectOk(await g.promise)).toBe(9)
    expect(a.settled()).toBeUndefined()
    s.reply(w, Ok(1))
    expect(s.runs(w)).toHaveLength(2)
    expect(s.lastRun(w).input).toBe(2)
    s.reply(w, Ok(2))
    expect(expectOk(await a.promise)).toBe(1)
    expect(expectOk(await b.promise)).toBe(2)
  })

  it('abort resolves at once; the lane frees on the late result', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const b = s.start(tp, 2)
    const w = s.workers[0]!
    s.ready(w)
    const control = new Int32Array(s.lastRun(w).control)
    a.abort()
    await settle()
    expectErrCode(a.settled()!, 'op.aborted')
    expect(Atomics.load(control, 0)).toBe(2)
    expect(s.runs(w)).toHaveLength(1) // busy until the worker answers
    s.reply(w, Ok(1))
    expect(s.lastRun(w).input).toBe(2)
    expect(w.terminated).toBe(false)
    s.reply(w, Ok(2))
    expect(expectOk(await b.promise)).toBe(2)
  })

  it('without a result within the grace the worker is terminated and the lane frees', async () => {
    const s = setup({ abortGraceMs: 1_000 })
    const a = s.start(tp, 1)
    const b = s.start(tp, 2)
    const w = s.workers[0]!
    s.ready(w)
    a.abort()
    s.clock.advance(999)
    expect(w.terminated).toBe(false)
    s.clock.advance(1)
    expect(w.terminated).toBe(true)
    // the next task gets a fresh worker; a kill is not a crash
    const w2 = s.workers[1]!
    s.ready(w2)
    s.reply(w2, Ok(2))
    expect(expectOk(await b.promise)).toBe(2)
    w.events.exit(1) // the terminated worker's exit is ignored
    expect(s.workers).toHaveLength(2)
  })

  it('abort while queued removes the task without touching the worker', async () => {
    const s = setup()
    s.start(tp, 1)
    const b = s.start(tp, 2)
    b.abort()
    await settle()
    expectErrCode(b.settled()!, 'op.aborted')
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Ok(1))
    expect(s.runs(w)).toHaveLength(1)
  })

  it('an already aborted signal resolves without queueing', async () => {
    const s = setup()
    const ac = new AbortController()
    ac.abort()
    expectErrCode(await s.pool.run(tp, 1, { signal: ac.signal, progress: () => {} }), 'op.aborted')
    expect(s.workers).toHaveLength(0)
  })

  it('times out with op.timeout, excluding paused time', async () => {
    const s = setup()
    const listeners = new Set<(p: boolean) => void>()
    let paused = false
    const pause: PauseState = {
      get paused() {
        return paused
      },
      onChange: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
    const setPaused = (p: boolean) => {
      paused = p
      for (const l of listeners) l(p)
    }
    const a = s.start(tp, 1, { pause })
    const w = s.workers[0]!
    s.ready(w)
    const control = new Int32Array(s.lastRun(w).control)
    s.clock.advance(600)
    setPaused(true)
    expect(Atomics.load(control, 0)).toBe(1)
    s.clock.advance(5_000)
    await settle()
    expect(a.settled()).toBeUndefined()
    setPaused(false)
    expect(Atomics.load(control, 0)).toBe(0)
    s.clock.advance(399)
    await settle()
    expect(a.settled()).toBeUndefined()
    s.clock.advance(1)
    await settle()
    const e = expectErrCode(a.settled()!, 'op.timeout')
    expect(e.severity).toBe('warn')
    expect(Atomics.load(control, 0)).toBe(2)
  })

  it('a crash fails the run with the exit info and the next task respawns lazily', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const w = s.workers[0]!
    s.ready(w)
    w.events.exit(3)
    const e = expectErrCode(await a.promise, 'internal.unexpected')
    expect(e.frames[0]?.data).toMatchObject({
      workerId: 'toolpath-1',
      lane: 'toolpath',
      task: 'test.tp',
      exitCode: 3,
    })
    expect(s.workers).toHaveLength(1) // lazy
    const b = s.start(tp, 2)
    const w2 = s.workers[1]!
    s.ready(w2)
    s.reply(w2, Ok(2))
    expect(expectOk(await b.promise)).toBe(2)
  })

  it('3 crashes in 60 s stop the lane for 30 s', async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) {
      const r = s.start(tp, i)
      const w = s.workers.at(-1)!
      s.ready(w)
      w.events.error(new Error('boom'))
      expectErrCode(await r.promise, 'internal.unexpected')
      s.clock.advance(1_000)
    }
    const spawned = s.workers.length
    const blocked = s.start(tp, 9)
    const e = expectErrCode(await blocked.promise, 'internal.unexpected')
    expect(e.message).toMatch(/unavailable/)
    expect(s.workers).toHaveLength(spawned)
    s.clock.advance(30_000)
    const again = s.start(tp, 10)
    expect(s.workers).toHaveLength(spawned + 1)
    const w = s.workers.at(-1)!
    s.ready(w)
    s.reply(w, Ok(10))
    expect(expectOk(await again.promise)).toBe(10)
  })

  it('recycles a worker that leaked solid objects after delivering the result', async () => {
    const s = setup()
    const a = s.start(geo, 1)
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Ok(1), { ms: 1, liveObjects: 2, heapBytes: 1 })
    expect(expectOk(await a.promise)).toBe(1)
    expect(w.terminated).toBe(true)
  })

  it('recycles a geometry worker after an internal.unexpected result', async () => {
    const s = setup()
    const a = s.start(geo, 1)
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Err(new AppError('internal.unexpected', 'bug')))
    expectErrCode(await a.promise, 'internal.unexpected')
    expect(w.terminated).toBe(true)
  })

  it('recycles when idle once the heap exceeds the limit', async () => {
    const s = setup({ maxHeapBytes: 100 })
    const a = s.start(geo, 1)
    const b = s.start(geo, 2)
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Ok(1), { ms: 1, heapBytes: 200, liveObjects: 0 })
    expectOk(await a.promise)
    expect(w.terminated).toBe(false) // still has queued work
    s.reply(w, Ok(2), { ms: 1, heapBytes: 200, liveObjects: 0 })
    expectOk(await b.promise)
    expect(w.terminated).toBe(true)
    expect(s.pool.lastStats('geometry')).toMatchObject({ workerId: 'geometry-1', task: 'test.geo' })
  })

  it('a protocol mismatch is internal.unexpected and the lane never respawns', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const w = s.workers[0]!
    s.ready(w, PROTOCOL_VERSION + 1)
    expectErrCode(await a.promise, 'internal.unexpected')
    expect(w.terminated).toBe(true)
    s.clock.advance(120_000)
    expectErrCode(await s.start(tp, 2).promise, 'internal.unexpected')
    expect(s.workers).toHaveLength(1)
  })

  it('a malformed worker message fails the run and terminates the worker', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const w = s.workers[0]!
    s.ready(w)
    w.events.message({ type: 'result', id: s.lastRun(w).id })
    expectErrCode(await a.promise, 'internal.unexpected')
    expect(w.terminated).toBe(true)
  })

  it('an output that fails the task schema is internal.unexpected', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Ok('not a number'))
    const e = expectErrCode(await a.promise, 'internal.unexpected')
    expect(e.message).toMatch(/malformed output/)
    expect(s.pool.lastStats('toolpath')!.outputCheckMs).toBeGreaterThanOrEqual(0)
  })

  it('drops results for other runs', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const w = s.workers[0]!
    s.ready(w)
    s.reply(w, Ok(5), { ms: 1 }, 'toolpath-1:999')
    await settle()
    expect(a.settled()).toBeUndefined()
    s.reply(w, Ok(1))
    expect(expectOk(await a.promise)).toBe(1)
  })

  it('forwards progress and log batches', async () => {
    const batches: { worker: string; lane: Lane }[] = []
    const s = setup({ onLog: (_b, o) => batches.push(o) })
    const ticks: unknown[] = []
    const p = s.pool.run(tp, 1, {
      signal: new AbortController().signal,
      progress: (t) => ticks.push(t),
    })
    const w = s.workers[0]!
    s.ready(w)
    const id = s.lastRun(w).id
    w.events.message({ type: 'progress', id, done: 1, total: 2, label: 'x' })
    w.events.message({ type: 'log', batch: [{ level: 'info', msg: 'hi' }] })
    s.reply(w, Ok(1))
    expectOk(await p)
    expect(ticks).toEqual([{ done: 1, total: 2, label: 'x' }])
    expect(batches).toEqual([{ worker: 'toolpath-1', lane: 'toolpath' }])
  })

  it('a worker that never gets ready counts as a crash', async () => {
    const s = setup({ spawnTimeoutMs: 100 })
    s.start(tp, 1)
    s.clock.advance(100)
    expect(s.workers[0]!.terminated).toBe(true)
    expect(s.workers).toHaveLength(2) // respawned for the queued task
  })

  it('prewarm spawns the lane worker, which goes idle when ready', () => {
    const s = setup()
    s.pool.prewarm('geometry')
    expect(s.workers).toHaveLength(1)
    s.ready(s.workers[0]!)
    expect(s.workers[0]!.idle).toBe(true)
    s.pool.prewarm('geometry')
    expect(s.workers).toHaveLength(1)
  })

  it('terminate() aborts queued and running tasks and kills the workers', async () => {
    const s = setup()
    const a = s.start(tp, 1)
    const b = s.start(tp, 2)
    s.ready(s.workers[0]!)
    s.pool.terminate()
    expectErrCode(await a.promise, 'op.aborted')
    expectErrCode(await b.promise, 'op.aborted')
    expect(s.workers[0]!.terminated).toBe(true)
    expectErrCode(await s.start(tp, 3).promise, 'op.aborted')
  })
})
