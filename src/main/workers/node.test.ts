// Real `worker_threads` through the pool: the bundled test entry (global-setup.ts) with the
// production tasks and fixtures. Spec: docs/architecture/workers.md#testing
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import type { PauseState } from '../../core/commands/context'
import type { JobProgress } from '../../core/commands/context'
import { evaluatePart } from '../../core/geometry/evaluate'
import { loadManifold } from '../../core/geometry/manifold'
import { nodeCavalierWasm } from '../../core/geometry/2d/testing/node-wasm'
import { nodeManifoldSource } from '../../core/geometry/testing/node-wasm'
import { testPart } from '../../core/geometry/testing/test-part'
import { createWorkerPool, type PoolOptions, type WorkerPool } from '../../core/workers/pool'
import { geometryEvaluate } from '../../core/workers/tasks'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { nodeWorkerFactory, readManifoldWasm } from './node'
import { testExit, testHang, testLog, testLoop, testRegion2d, testThrow } from './test-tasks'

const region2dBytes = nodeCavalierWasm().slice().buffer as ArrayBuffer

const entry = inject('workerEntry')
const pools: WorkerPool[] = []

function pool(over: Partial<PoolOptions> = {}): WorkerPool {
  const p = createWorkerPool({
    factory: nodeWorkerFactory(entry),
    wasm: readManifoldWasm,
    abortGraceMs: 500,
    ...over,
  })
  pools.push(p)
  return p
}

afterEach(() => {
  for (const p of pools.splice(0)) p.terminate()
})

const ctl = (
  over: { signal?: AbortSignal; pause?: PauseState; progress?: (p: JobProgress) => void } = {},
) => ({
  signal: over.signal ?? new AbortController().signal,
  progress: over.progress ?? (() => {}),
  ...(over.pause === undefined ? {} : { pause: over.pause }),
})

function pauseState() {
  const listeners = new Set<(p: boolean) => void>()
  let paused = false
  return {
    state: {
      get paused() {
        return paused
      },
      onChange(l: (p: boolean) => void) {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    } satisfies PauseState,
    set(p: boolean) {
      paused = p
      for (const l of listeners) l(p)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('worker_threads host', { timeout: 60_000 }, () => {
  it('evaluates the test part end to end: buffers transferred, no live objects', async () => {
    const p = pool()
    const e = expectOk(await p.run(geometryEvaluate, testPart(), ctl()))
    expect(e.positions).toBeInstanceOf(Float32Array)
    expect(e.indices.length / 3).toBe(e.stats.triangles)
    expect(e.triangleSurface.length).toBe(e.stats.triangles)
    // the same result as in-process
    const kernel = expectOk(await loadManifold(nodeManifoldSource()))
    const local = expectOk(kernel.withSolids((s) => evaluatePart(testPart(), s)))
    expect(e.volume).toBeCloseTo(local.volume, 6)
    expect(e.surfaces).toEqual(local.surfaces)
    const stats = p.lastStats('geometry')!
    expect(stats.stats.liveObjects).toBe(0)
    expect(stats.stats.heapBytes).toBeGreaterThan(0)
  })

  it('reports progress, and abort resolves at once while the worker stops at its next step', async () => {
    const p = pool()
    const ticks: JobProgress[] = []
    const ac = new AbortController()
    const run = p.run(
      testLoop,
      { steps: 200, stepMs: 10 },
      ctl({ signal: ac.signal, progress: (t) => ticks.push(t) }),
    )
    while (ticks.length === 0) await sleep(5)
    // ordering, not wall clock (budgets are in workers.perf.ts): the run settles within the
    // abort's own microtasks, before any further worker message (a macrotask) is handled
    let settled = false
    void run.then(() => (settled = true))
    const before = ticks.length
    ac.abort()
    for (let i = 0; i < 3; i++) await Promise.resolve()
    expect(settled).toBe(true)
    expect(ticks.length).toBe(before) // no progress delivered after the abort
    expectErrCode(await run, 'op.aborted')
    // the lane frees within one step: the next task runs on the same worker
    expectOk(await p.run(testLoop, { steps: 1, stepMs: 0 }, ctl()))
    expect(p.lastStats('toolpath')!.workerId).toBe('toolpath-1')
    // progress is throttled in the worker (≤ 1 per 50 ms + final)
    expect(ticks.length).toBeLessThan(10)
  })

  it('pause parks the worker at its next step; resume continues', async () => {
    const p = pool()
    const pause = pauseState()
    const ticks: JobProgress[] = []
    const run = p.run(
      testLoop,
      { steps: 40, stepMs: 5 },
      ctl({ pause: pause.state, progress: (t) => ticks.push(t) }),
    )
    while (ticks.length === 0) await sleep(5)
    pause.set(true)
    await sleep(100)
    const parked = ticks.length
    await sleep(200)
    expect(ticks.length).toBe(parked)
    pause.set(false)
    expect(expectOk(await run)).toEqual({ done: 40 })
  })

  it('a throwing task is internal.unexpected; the worker survives', async () => {
    const p = pool()
    expectErrCode(await p.run(testThrow, null, ctl()), 'internal.unexpected')
    expectOk(await p.run(testLoop, { steps: 1, stepMs: 0 }, ctl()))
    expect(p.lastStats('toolpath')!.workerId).toBe('toolpath-1')
  })

  it('a crashed worker fails its run with the exit code and is respawned', async () => {
    const p = pool()
    const e = expectErrCode(await p.run(testExit, { code: 3 }, ctl()), 'internal.unexpected')
    expect(e.frames[0]?.data).toMatchObject({ lane: 'toolpath', task: 'test.exit', exitCode: 3 })
    expectOk(await p.run(testLoop, { steps: 1, stepMs: 0 }, ctl()))
    expect(p.lastStats('toolpath')!.workerId).toBe('toolpath-2')
  })

  it('a hanging task times out, is terminated after the grace and the lane recovers', async () => {
    const p = pool({ abortGraceMs: 200 })
    const t0 = performance.now()
    expectErrCode(await p.run(testHang, { timeoutMs: 300 }, ctl()), 'op.timeout')
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290)
    expectOk(await p.run(testLoop, { steps: 1, stepMs: 0 }, ctl()))
    expect(p.lastStats('toolpath')!.workerId).toBe('toolpath-2')
  })

  it('loads the 2D port lazily in the toolpath lane from the bytes the host sends', async () => {
    const p = pool({ region2dWasm: () => region2dBytes })
    const r = expectOk(await p.run(testRegion2d, { size: 20, d: 2 }, ctl()))
    expect(r.area).toBeCloseTo(256, 9)
    // without the bytes the task fails, the worker survives
    const none = pool()
    expectErrCode(await none.run(testRegion2d, { size: 20, d: 2 }, ctl()), 'internal.unexpected')
    expectOk(await none.run(testLoop, { steps: 1, stepMs: 0 }, ctl()))
  })

  it('forwards worker logs with the worker id', async () => {
    const batches: { batch: unknown; worker: string }[] = []
    const p = pool({
      logLevel: 'info',
      onLog: (batch, o) => batches.push({ batch, worker: o.worker }),
    })
    expectOk(await p.run(testLog, { count: 3 }, ctl()))
    await sleep(50)
    const entries = batches.flatMap((b) => b.batch as { msg: string; worker: string }[])
    expect(entries.filter((e) => e.msg === 'hello from the worker')).toHaveLength(3)
    expect(entries[0]).toMatchObject({ proc: 'worker', worker: 'toolpath-1', task: 'test.log' })
    expect(batches[0]!.worker).toBe('toolpath-1')
  })

  it('keeps the WASM heap flat over 35 evaluations', async () => {
    const p = pool()
    const input = testPart()
    for (let i = 0; i < 5; i++) expectOk(await p.run(geometryEvaluate, input, ctl()))
    const warm = p.lastStats('geometry')!.stats.heapBytes!
    for (let i = 0; i < 30; i++) expectOk(await p.run(geometryEvaluate, input, ctl()))
    const last = p.lastStats('geometry')!
    expect(last.stats.heapBytes).toBe(warm)
    expect(last.stats.liveObjects).toBe(0)
    expect(last.workerId).toBe('geometry-1')
  })
})

/**
 * The production electron-vite chunk (CJS, dependencies externalized), when `npm run build` has
 * produced one that is newer than the sources; otherwise skipped.
 */
function builtWorkerChunk(): string | undefined {
  const root = resolve(import.meta.dirname, '../../..')
  const dir = join(root, 'out/main/chunks')
  const name = existsSync(dir) ? readdirSync(dir).find((f) => /^entry-.*\.js$/.test(f)) : undefined
  if (name === undefined) return undefined
  const chunk = join(dir, name)
  const newest = (d: string): number =>
    Math.max(
      0,
      ...readdirSync(d, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? newest(join(d, e.name)) : statSync(join(d, e.name)).mtimeMs,
      ),
    )
  const sources = Math.max(
    ...['src/core', 'src/main', 'src/shared'].map((d) => newest(join(root, d))),
  )
  return statSync(chunk).mtimeMs >= sources ? chunk : undefined
}

const built = builtWorkerChunk()

describe('production worker chunk (out/main, after npm run build)', { timeout: 60_000 }, () => {
  it.skipIf(built === undefined)(
    'evaluates the test part through the built CJS chunk',
    async () => {
      const p = createWorkerPool({ factory: nodeWorkerFactory(built!), wasm: readManifoldWasm })
      pools.push(p)
      const e = expectOk(await p.run(geometryEvaluate, testPart(), ctl()))
      expect(e.positions).toBeInstanceOf(Float32Array)
      expect(p.lastStats('geometry')!.stats.liveObjects).toBe(0)
    },
  )
})
