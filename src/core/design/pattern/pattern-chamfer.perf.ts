/**
 * Chamfered patterns (patterns P3, docs/modes/patterns.md#implementation-p3): 500 and 2 000
 * rounded hexagons with the owned edge chamfer through the real commands, each on a fresh WASM
 * heap (S8 trapped at ≈ 713 MB with one heap through the whole run): `design.pattern.add`, the
 * geometry input, a fresh evaluation and its longest step, toolpath generation and export.
 * Budgets ≈ 2–3× the measurement on the development machine. Outside `npm run check`:
 * `npm run perf`.
 */
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectOk } from '../../../shared/testing/result'
import { createInProcessWorkers } from '../../commands/jobs'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../geometry/evaluate'
import { loadManifold } from '../../geometry/manifold'
import { nodeManifoldSource } from '../../geometry/testing/node-wasm'
import { deg, len, libraryInput, num } from '../../library/library.fixture'
import { flat6, planSetup } from '../../plan/plan.fixture'
import { exportPlan } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { Steps } from '../../workers/steps'
import { partGeometryInput } from '../load'

const region2d = nodeRegion2d()
const ui = uiSource()
const now = () => performance.now()

const CELL = {
  kind: 'polygon',
  sides: '6',
  diameter: '3',
  across: 'flats',
  cornerRadius: '0.3',
  rotation: '30',
}

async function run(board: [string, string], width: string, budgets: Record<string, number>) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({
    part: false,
    services: svc,
    stock: {
      name: 'Board',
      shape: 'block' as const,
      length: board[0],
      width: board[1],
      thickness: '12',
      material: { name: 'Walnut', class: 'hardwood' as const },
    },
  })
  await s.run('library.tool.add', {
    values: libraryInput({ ...flat6(), name: 'Flat 1.5', diameter: len('1.5'), presets: [] }),
  })
  await s.run('library.tool.add', {
    values: libraryInput({
      name: 'V-bit 90',
      type: 'chamferMill' as const,
      diameter: len('6'),
      angle: deg('90'),
      fluteLength: len('8'),
      overallLength: len('50'),
      fluteCount: num('2'),
      toolMaterial: 'carbide' as const,
      presets: [],
    }),
  })
  let t = now()
  const out = (await s.run('design.pattern.add', {
    partId: s.partId,
    lattice: 'hex',
    cell: CELL,
    spacing: { gap: '1' },
    margin: '8',
    depth: '1',
    chamfer: { width },
  })) as { cells: number }
  const addMs = now() - t
  await s.run('project.apply', {})
  t = now()
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const inputMs = now() - t
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  let last = now()
  let longest = 0
  const steps: Steps = {
    step() {
      const n = now()
      longest = Math.max(longest, n - last)
      last = n
      return Ok(undefined)
    },
  }
  t = now()
  last = t
  const ev = kernel.withSolids((x) => evaluatePart(input, x, steps, region2d)).unwrap()
  const evalMs = now() - t
  const heapMB = kernel.heapBytes().unwrapOr(0) / 2 ** 20
  // a second evaluation on the same heap (an edit before the pool recycles the worker at 512 MB):
  // the freed heap is reused, it does not grow by another evaluation
  kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
  const heap2MB = kernel.heapBytes().unwrapOr(0) / 2 ** 20
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  t = now()
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { status: string }[]
  }
  const generateMs = now() - t
  expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
  t = now()
  const e = expectOk(await exportPlan(s.d.doc, planId, svc))
  const exportMs = now() - t
  const m = {
    add: addMs,
    input: inputMs,
    evaluate: evalMs,
    step: longest,
    generate: generateMs,
    export: exportMs,
  }
  console.log(
    `pattern chamfer perf: ${out.cells} cells, width ${width}; ${Object.entries(m)
      .map(([k, v]) => `${k} ${v.toFixed(0)} ms`)
      .join(
        ', ',
      )}, WASM heap ${heapMB.toFixed(0)} MB (again ${heap2MB.toFixed(0)} MB), ${ev.stats.triangles} triangles, ${e.lines.length} lines`,
  )
  for (const [k, v] of Object.entries(budgets))
    expect(k === 'heapMB' ? heap2MB : m[k as keyof typeof m], k).toBeLessThan(v)
  return out.cells
}

// rounded hexagons 3 mm across flats, gap 1, hex lattice; 0.4 mm bevels stay apart on the 1 mm
// web, 0.7 mm bevels meet (every cell gets neighbours, coloured into a few meshes)
describe('chamfered patterns', () => {
  it('500 cells, bevels apart', async () => {
    expect(
      await run(['115', '95'], '0.4', {
        add: 500,
        evaluate: 3000,
        step: 2000,
        generate: 1500,
        export: 3000,
        heapMB: 300,
      }),
    ).toBeGreaterThan(400)
  })
  it('500 cells, bevels meeting', async () => {
    expect(
      await run(['115', '95'], '0.7', {
        add: 500,
        evaluate: 4000,
        step: 2500,
        generate: 1500,
        export: 3000,
        heapMB: 300,
      }),
    ).toBeGreaterThan(400)
  })
  it('2 000 cells, bevels apart', async () => {
    expect(
      await run(['200', '170'], '0.4', {
        add: 1000,
        evaluate: 10000,
        step: 6000,
        generate: 6000,
        export: 10000,
        heapMB: 700,
      }),
    ).toBeGreaterThan(1800)
  })
  it('2 000 cells, bevels meeting', async () => {
    expect(
      await run(['200', '170'], '0.7', {
        add: 1000,
        evaluate: 13000,
        step: 8000,
        generate: 6000,
        export: 13000,
        heapMB: 700,
      }),
    ).toBeGreaterThan(1800)
  })
})
