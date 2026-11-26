/**
 * Geometry performance budgets (docs/architecture/geometry.md#performance-budgets-v01), outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { evaluatePart } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput } from './model'
import { nodeManifoldSource } from './testing/node-wasm'
import { pocketGrid } from './testing/stress-part'
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

it('meets the warm budget on the test part with side and bottom operations (v0.2)', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const base = testPart()
  const input: PartGeometryInput = {
    ...base,
    operations: [
      ...base.operations,
      {
        kind: 'drilling',
        id: 'side1',
        direction: '+x',
        onZ: 0,
        center: [30, 10],
        diameter: 6,
        bottom: { kind: 'through' },
      },
      {
        kind: 'drilling',
        id: 'side2',
        direction: '-y',
        onZ: 0,
        center: [30, 8],
        diameter: 5,
        bottom: { kind: 'flat', depth: 20 },
      },
      {
        kind: 'pocket',
        id: 'bottom1',
        direction: '-z',
        onZ: 0,
        shape: {
          center: [50, 30],
          contour: { kind: 'rectangle', length: 30, width: 16, cornerRadius: 4 },
        },
        depth: 6,
        floorRadius: 2,
      },
    ],
  }
  for (let i = 0; i < 20; i++) kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
  const times: number[] = []
  let triangles = 0
  for (let i = 0; i < 200; i++) {
    const t = performance.now()
    triangles = kernel.withSolids((s) => evaluatePart(input, s)).unwrap().stats.triangles
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const median = times[100]!
  console.log(
    `test part + side and bottom operations: warm median ${median.toFixed(1)} ms, ` +
      `p95 ${times[190]!.toFixed(1)} ms, ${triangles} triangles (budget 50)`,
  )
  expect(median).toBeLessThanOrEqual(50)
  expect(triangles).toBeLessThanOrEqual(20_000)
  expect(kernel.liveObjects()).toBe(0)
})

/**
 * DF118 construction surfaces (docs/modes/construction-surfaces.md#risks): 100 cloned recesses,
 * each with a deeper slot and then a stepped pocket of the same outline on its floor, so every
 * floor is a construction surface consumed by two operations (one boolean each, as clamps_40). Against the same part without
 * references (no construction work).
 */
it('measures the construction-surface check on 100 clones that consume their floors', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const recess = (i: number, id: string, onZ: number, size = 1): OperationGeometry => ({
    kind: 'pocket',
    id,
    onZ,
    shape: {
      center: [10 + 18 * (i % 10), 10 + 18 * Math.floor(i / 10)],
      contour: { kind: 'rectangle', length: 12 * size, width: 8 * size, cornerRadius: 2 * size },
    },
    depth: 2 / size,
    floorRadius: 0,
  })
  const n = 100
  const a = Array.from({ length: n }, (_, i) => recess(i, `a${i}`, 0))
  const slot = Array.from({ length: n }, (_, i) => recess(i, `s${i}`, -2, 0.5))
  const b = Array.from({ length: n }, (_, i) => recess(i, `b${i}`, -2))
  const plain: PartGeometryInput = {
    stock: { length: 190, width: 190, thickness: 10 },
    operations: [...a, ...slot, ...b],
    cloneGroups: [a, slot, b].map((g) => g.map((o) => o.id)),
  }
  const referenced: PartGeometryInput = {
    ...plain,
    references: [...slot, ...b].map((o) => ({
      operation: o.id,
      parameter: 'on',
      surface: `a${o.id.slice(1)}.floor`,
    })),
    dependants: Object.fromEntries(a.map((_, i) => [`a${i}.floor`, [`s${i}`, `b${i}`]])),
  }
  // interleaved runs after a warm-up of both, so neither pays the first evaluations alone
  const runs = { plain: [] as number[], referenced: [] as number[] }
  let construction = 0
  for (let i = 0; i < 14; i++)
    for (const key of ['plain', 'referenced'] as const) {
      const t = performance.now()
      const e = kernel
        .withSolids((s) => evaluatePart(key === 'plain' ? plain : referenced, s))
        .unwrap()
      if (i >= 3) runs[key].push(performance.now() - t)
      if (key === 'referenced') {
        construction = e.construction.length
        expect(e.construction[7]!.consumedBy).toEqual(['s7', 'b7'])
      }
      expect(e.warnings.filter((w) => w.code === 'dfm.surfaceCutAway')).toEqual([])
    }
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
  const without = { median: median(runs.plain) }
  const withChecks = { median: median(runs.referenced), construction }
  console.log(
    `100 clones consuming their floors: ${without.median.toFixed(1)} ms without references, ` +
      `${withChecks.median.toFixed(1)} ms with ${withChecks.construction} construction surfaces ` +
      `(+${(withChecks.median - without.median).toFixed(1)} ms)`,
  )
  expect(withChecks.construction).toBe(n)
  expect(kernel.liveObjects()).toBe(0)
})
