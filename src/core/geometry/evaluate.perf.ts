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

/** 30 filleted pockets (6 × 5 grid on 300 × 200 × 20), 4 flat drills in each floor. */
export function pocketGrid(): PartGeometryInput {
  const operations: OperationGeometry[] = []
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 5; j++) {
      const [x, y] = [25 + 50 * i, 20 + 40 * j]
      const n = operations.length / 5
      operations.push({
        kind: 'pocket',
        id: `pocket${n + 1}`,
        onZ: 0,
        shape: {
          center: [x, y],
          contour: { kind: 'rectangle', length: 40, width: 30, cornerRadius: 4 },
        },
        depth: 8,
        floorRadius: 2,
      })
      for (const [dx, dy] of [
        [-10, -7],
        [10, -7],
        [10, 7],
        [-10, 7],
      ] as const)
        operations.push({
          kind: 'drilling',
          id: `drill${operations.length}`,
          onZ: -8,
          center: [x + dx, y + dy],
          diameter: 4,
          bottom: { kind: 'flat', depth: 4 },
        })
    }
  return { stock: { length: 300, width: 200, thickness: 20 }, operations }
}

it('evaluates 30 filleted pockets with 4 drills each within the budget', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const input = pocketGrid()
  for (let i = 0; i < 5; i++) kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
  const times: number[] = []
  let triangles = 0
  let warnings = 0
  for (let i = 0; i < 40; i++) {
    const t = performance.now()
    const e = kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
    times.push(performance.now() - t)
    triangles = e.stats.triangles
    warnings = e.warnings.length
  }
  times.sort((a, b) => a - b)
  console.log(
    `30 filleted pockets + 120 drills: warm median ${times[20]!.toFixed(1)} ms, ` +
      `p95 ${times[38]!.toFixed(1)} ms, ${triangles} triangles, ${warnings} warning(s)`,
  )
  expect(warnings).toBe(0)
  expect(kernel.liveObjects()).toBe(0)
})

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
