/**
 * Worker performance budgets (docs/architecture/workers.md#performance-budgets), outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { afterAll, expect, inject, it } from 'vitest'
import { createEvaluationScheduler } from '../../core/design/evaluation'
import { buildTestPart, designSetup } from '../../core/design/design.fixture'
import { evaluatePart } from '../../core/geometry/evaluate'
import { pocketGrid } from '../../core/geometry/testing/stress-part'
import { loadManifold } from '../../core/geometry/manifold'
import { nodeManifoldSource } from '../../core/geometry/testing/node-wasm'
import { testPart } from '../../core/geometry/testing/test-part'
import { planOperationInputs } from '../../core/plan/inputs'
import { planSetup } from '../../core/plan/plan.fixture'
import { toGeneratorInputs } from '../../core/toolpath/inputs'
import { generateRequest } from '../../core/toolpath/request'
import { ToolpathSchema, ToolpathSpotSchema } from '../../core/toolpath/schemas'
import { PROTOCOL_VERSION } from '../../core/workers/protocol'
import { createWorkerPool, type WorkerPool } from '../../core/workers/pool'
import type { Steps } from '../../core/workers/steps'
import { geometryEvaluate, toolpathGenerate } from '../../core/workers/tasks'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { nodeWorkerFactory, readManifoldWasm } from './node'
import { testLoop } from './test-tasks'

const MB = 2 ** 20
const entry = inject('workerEntry')
const pools: WorkerPool[] = []
const pool = () => {
  const p = createWorkerPool({ factory: nodeWorkerFactory(entry), wasm: readManifoldWasm })
  pools.push(p)
  return p
}
afterAll(() => pools.forEach((p) => p.terminate()))

const ctl = (signal = new AbortController().signal, progress: () => void = () => {}) => ({
  signal,
  progress,
})
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const max = (xs: number[]) => Math.max(...xs)
const fmt = (ms: number) => `${ms.toFixed(2)} ms`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Records the time up to each `step()` call (labelled with that step) and to the end. */
function stepTimer(): Steps & { gaps: number[]; labels: string[]; end(): void } {
  let last = performance.now()
  let label = 'start'
  const gaps: number[] = []
  const labels: string[] = []
  return {
    gaps,
    labels,
    step(p) {
      const t = performance.now()
      label = p?.label ?? `${label}+`
      gaps.push(t - last)
      labels.push(label)
      last = t
      return Ok(undefined)
    },
    end() {
      gaps.push(performance.now() - last)
      labels.push('end')
    },
  }
}

it('worker spawn + WASM init (prewarm) ≤ 300 ms', async () => {
  const times: number[] = []
  const inits: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    let done: (v: { initMs: number }) => void = () => {}
    const ready = new Promise<{ initMs: number }>((r) => (done = r))
    const h = nodeWorkerFactory(entry)(
      { lane: 'geometry', workerId: `geometry-p${i}` },
      {
        message: (m) => {
          if ((m as { type: string }).type === 'ready') done(m as { initMs: number })
        },
        error: () => {},
        exit: () => {},
      },
    )
    h.post({
      type: 'init',
      protocol: PROTOCOL_VERSION,
      workerId: `geometry-p${i}`,
      lane: 'geometry',
      logLevel: 'warn',
      wasm: readManifoldWasm(),
    })
    const r = await ready
    times.push(performance.now() - t0)
    inits.push(r.initMs)
    h.terminate()
  }
  console.log(
    `spawn + WASM init: median ${fmt(median(times))}, max ${fmt(max(times))} ` +
      `(in-worker init median ${fmt(median(inits))}) (budget 300 ms)`,
  )
  expect(median(times)).toBeLessThanOrEqual(300)
})

it('evaluation round trip: overhead ≤ 5 ms, main-thread result handling ≤ 2 ms, heap flat', async () => {
  const p = pool()
  const input = testPart()
  for (let i = 0; i < 20; i++) expectOk(await p.run(geometryEvaluate, input, ctl()))
  const warmHeap = p.lastStats('geometry')!.stats.heapBytes!
  const overhead: number[] = []
  const check: number[] = []
  const wall: number[] = []
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now()
    expectOk(await p.run(geometryEvaluate, input, ctl()))
    const t = performance.now() - t0
    const s = p.lastStats('geometry')!
    wall.push(t)
    overhead.push(t - s.stats.ms)
    check.push(s.outputCheckMs)
  }
  const last = p.lastStats('geometry')!
  const growth = last.stats.heapBytes! - warmHeap
  console.log(
    [
      `evaluation through the worker: wall median ${fmt(median(wall))}, ` +
        `overhead (post, Zod both sides, clone, transfer) median ${fmt(median(overhead))}, ` +
        `p95 ${fmt([...overhead].sort((a, b) => a - b)[950]!)} (budget 5 ms)`,
      `host output check (Zod, main thread) median ${fmt(median(check))}, max ${fmt(max(check))} (budget 2 ms)`,
      `WASM heap ${(warmHeap / MB).toFixed(1)} MB after warm-up; growth over 1 000 evaluations ` +
        `${(growth / MB).toFixed(2)} MB (budget 10); live objects ${last.stats.liveObjects}`,
    ].join('\n'),
  )
  expect(median(overhead)).toBeLessThanOrEqual(5)
  expect(median(check)).toBeLessThanOrEqual(2)
  expect(growth).toBeLessThanOrEqual(10 * MB)
  expect(last.stats.liveObjects).toBe(0)
})

it('longest step ≤ 50 ms on the test part and the stress case', async () => {
  const kernel = expectOk(await loadManifold(nodeManifoldSource()))
  for (const [name, input] of [
    ['test part', testPart()],
    ['stress case (30 pockets + 120 drills)', pocketGrid()],
  ] as const) {
    for (let i = 0; i < 3; i++) kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
    // per run: its longest step; GC pauses of the test process make single runs noisy
    const longest: { ms: number; label: string }[] = []
    for (let i = 0; i < 10; i++) {
      const steps = stepTimer()
      kernel.withSolids((s) => evaluatePart(input, s, steps)).unwrap()
      steps.end()
      const k = steps.gaps.indexOf(max(steps.gaps))
      longest.push({ ms: steps.gaps[k]!, label: steps.labels[k]! })
    }
    longest.sort((a, b) => a.ms - b.ms)
    const typical = longest[5]!
    const worst = longest[9]!
    console.log(
      `${name}: longest step median ${fmt(typical.ms)} (until ${typical.label}), ` +
        `worst ${fmt(worst.ms)} (until ${worst.label}) (budget 50 ms)`,
    )
    expect(typical.ms).toBeLessThanOrEqual(50)
  }
})

it('abort: run resolved at once, worker free within one step; progress ≤ 20/s', async () => {
  const p = pool()
  const input = pocketGrid()
  for (let i = 0; i < 3; i++) expectOk(await p.run(geometryEvaluate, input, ctl()))
  const resolve: number[] = []
  const free: number[] = []
  for (let i = 0; i < 10; i++) {
    const ac = new AbortController()
    const run = p.run(geometryEvaluate, input, ctl(ac.signal))
    await sleep(40 + 10 * i)
    const ta = performance.now()
    ac.abort()
    await run
    resolve.push(performance.now() - ta)
    const tiny = performance.now()
    expectOk(await p.run(geometryEvaluate, testPart(), ctl()))
    free.push(performance.now() - tiny - p.lastStats('geometry')!.stats.ms)
  }
  // progress messages: the most in any 1 s window of a 2 s task (worker throttle: 1 per 50 ms)
  const times: number[] = []
  expectOk(
    await p.run(
      testLoop,
      { steps: 400, stepMs: 5 },
      ctl(undefined, () => times.push(performance.now())),
    ),
  )
  let perSecond = 0
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= 1000) j++
    perSecond = Math.max(perSecond, i - j + 1)
  }
  console.log(
    `abort: resolved after max ${fmt(max(resolve))} (immediate); worker free after median ` +
      `${fmt(median(free))}, max ${fmt(max(free))} (budget 50 ms); ` +
      `progress messages ≤ ${perSecond} in any second (budget 20; +1 for host jitter)`,
  )
  expect(max(resolve)).toBeLessThan(2)
  expect(median(free)).toBeLessThanOrEqual(50)
  expect(perSecond).toBeLessThanOrEqual(21)
})

it('toolpaths of the test plan: all operations ≤ 500 ms, output check per operation', async () => {
  const s = await planSetup()
  const planId = (await s.run('plan.create', {
    partId: s.partId,
    machineLibraryItemId: s.machineId,
  })) as { planId: string }
  for (const op of s.plan(planId.planId).setups[0]!.operations)
    if (op.designOperationIds[0]!.startsWith('drill'))
      await s.run('plan.operation.update', {
        planId: planId.planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
  const inputs = expectOk(planOperationInputs(s.d.doc, planId.planId))
  const requests = inputs.map((i) => expectOk(toGeneratorInputs(i)))
  const p = pool()
  for (const r of requests) expectOk(await p.run(toolpathGenerate, r, ctl())) // warm-up
  const totals: number[] = []
  const checks = new Map<string, number[]>()
  for (let round = 0; round < 20; round++) {
    const t0 = performance.now()
    for (const [k, r] of requests.entries()) {
      expectOk(await p.run(toolpathGenerate, r, ctl()))
      const id = `${inputs[k]!.planOperationId} (${r.kind})`
      checks.set(id, [...(checks.get(id) ?? []), p.lastStats('toolpath')!.outputCheckMs])
    }
    totals.push(performance.now() - t0)
  }
  const lines = [...checks].map(([id, xs], k) => {
    const tp = expectOk(generateRequest(requests[k]!))
    const moves = tp.passes.reduce((n, pass) => n + pass.moves.length, 0)
    const t = performance.now()
    for (let i = 0; i < 20; i++) ToolpathSpotSchema.parse(tp)
    const spot = (performance.now() - t) / 20
    const t2 = performance.now()
    for (let i = 0; i < 20; i++) ToolpathSchema.parse(tp)
    const full = (performance.now() - t2) / 20
    return `  ${id}: ${moves} moves, full check in host median ${fmt(median(xs))} (alone ${fmt(full)}), spot check ${fmt(spot)}`
  })
  console.log(
    [
      `toolpaths of the test part through the worker: median ${fmt(median(totals))} (budget 500 ms)`,
      'toolpath output check per plan operation (budget 5 ms):',
      ...lines,
    ].join('\n'),
  )
  expect(median(totals)).toBeLessThanOrEqual(500)
  for (const xs of checks.values()) expect(median(xs)).toBeLessThanOrEqual(5)
})

it('last edit → current evaluation in the host ≤ 250 ms (warm, test part)', async () => {
  const s = await designSetup()
  await buildTestPart(s)
  const scheduler = createEvaluationScheduler({ workers: pool() })
  scheduler.attach(s.d)
  const waitDone = async () => {
    while (scheduler.state(s.d.doc, s.partId).status !== 'done') await sleep(1)
  }
  await waitDone()
  const times: number[] = []
  const depths = ['7', '7.5', '8', '6.5', '6', '8', '7']
  for (const depth of depths) {
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth })
    const t0 = performance.now()
    await waitDone()
    times.push(performance.now() - t0)
  }
  scheduler.close()
  console.log(
    `last edit → current evaluation: median ${fmt(median(times))}, max ${fmt(max(times))} ` +
      `(budget 250 ms, of which 200 ms debounce)`,
  )
  expect(median(times)).toBeLessThanOrEqual(250)
})
