/**
 * Geometry performance budgets (docs/architecture/geometry.md#performance-budgets-v01), outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { evaluatePart } from './evaluate'
import { loadManifold } from './manifold'
import { nodeManifoldSource } from './testing/node-wasm'
import { testPart } from './testing/test-part'

const MB = 2 ** 20

it('meets the v0.1 budgets on the test part', async () => {
  const input = testPart()
  const t0 = performance.now()
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const init = performance.now() - t0
  const first = kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
  const cold = performance.now() - t0

  for (let i = 0; i < 20; i++) kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
  const warmHeap = kernel.heapBytes().unwrap()
  const times: number[] = []
  for (let i = 0; i < 1000; i++) {
    const t = performance.now()
    kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const median = times[500]!
  const p95 = times[950]!
  const growth = kernel.heapBytes().unwrap() - warmHeap

  console.log(
    [
      `WASM init ${init.toFixed(1)} ms; cold (init + first evaluation) ${cold.toFixed(1)} ms (budget 150)`,
      `warm evaluation median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (budget 50)`,
      `triangles ${first.stats.triangles} (budget 20 000)`,
      `WASM heap ${(warmHeap / MB).toFixed(1)} MB after warm-up; growth over 1 000 evaluations ` +
        `${(growth / MB).toFixed(2)} MB (budget 10); live objects ${kernel.liveObjects()}`,
    ].join('\n'),
  )
  expect(cold).toBeLessThanOrEqual(150)
  expect(median).toBeLessThanOrEqual(50)
  expect(first.stats.triangles).toBeLessThanOrEqual(20_000)
  expect(growth).toBeLessThanOrEqual(10 * MB)
  expect(kernel.liveObjects()).toBe(0)
})
