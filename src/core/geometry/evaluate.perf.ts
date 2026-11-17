/**
 * Geometry performance budgets (docs/architecture/geometry.md#performance-budgets-v01), outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { evaluatePart } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput } from './model'
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

/** Test part variants that take the costly check paths: a loose offcut, a cut-away tab. */
function warningVariants(): Record<string, PartGeometryInput> {
  const base = testPart()
  const withTabs = (count: number): PartGeometryInput => ({
    ...base,
    operations: base.operations.map((op) =>
      op.kind === 'profile' ? { ...op, tabs: { ...op.tabs, count } } : op,
    ),
  })
  const overTab: OperationGeometry = {
    kind: 'pocket',
    id: 'pocket2',
    onZ: -0.5,
    shape: {
      center: [50, 5],
      contour: { kind: 'rectangle', length: 12, width: 8, cornerRadius: 2 },
    },
    depth: 19,
    floorRadius: 0,
  }
  return {
    'loose offcut (tabs.count 0)': withTabs(0),
    'pocket over a tab': { ...base, operations: [...base.operations, overTab] },
  }
}

it('meets the warm budget when the checks report warnings', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  for (const [name, input] of Object.entries(warningVariants())) {
    for (let i = 0; i < 20; i++) kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
    const times: number[] = []
    let warnings = 0
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      warnings = kernel.withSolids((s) => evaluatePart(input, s)).unwrap().warnings.length
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const median = times[100]!
    console.log(
      `${name}: warm median ${median.toFixed(1)} ms, p95 ${times[190]!.toFixed(1)} ms, ` +
        `${warnings} warning(s) (budget 50)`,
    )
    expect(warnings).toBeGreaterThan(0)
    expect(median).toBeLessThanOrEqual(50)
  }
  expect(kernel.liveObjects()).toBe(0)
})
