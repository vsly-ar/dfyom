/**
 * Patterns at the cell limit (patterns P1, docs/modes/patterns.md#implementation-p1): ≈ 2 000
 * rounded hexagons through the real commands: the cells' resolution, `design.pattern.add` (its
 * DFM included), the part's geometry input, a fresh evaluation and its longest step, the plan's
 * toolpath generation (pocket ordering, S8's 11.5 s) and the export. Budgets ≈ 2–3× the
 * measurement on the development machine. Outside `npm run check`: `npm run perf`.
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
import { len, libraryInput } from '../../library/library.fixture'
import { flat6, planSetup } from '../../plan/plan.fixture'
import { exportPlan } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { Steps } from '../../workers/steps'
import { partGeometryInput } from '../load'
import { resolveDefinition } from '../shape'
import { resolvePattern } from './layout'
import { touchOffSpot } from '../../geometry/flat-patch'

const region2d = nodeRegion2d()
const ui = uiSource()
const now = () => performance.now()

/** Rounded hexagons 3 mm across flats, gap 1, hex lattice; the board sized for ≈ 2 000 cells. */
const CELL = {
  kind: 'polygon',
  sides: '6',
  diameter: '3',
  across: 'flats',
  cornerRadius: '0.3',
  rotation: '30',
}
const BOARD = {
  name: 'Board',
  shape: 'block' as const,
  length: '190',
  width: '160',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

describe('patterns at the cell limit', () => {
  it('2 000 cells: resolve, add, evaluate, generate, export within budget', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: BOARD })
    await s.run('library.tool.add', {
      values: libraryInput({ ...flat6(), name: 'Flat 1.5', diameter: len('1.5'), presets: [] }),
    })
    let t = now()
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      lattice: 'hex',
      cell: CELL,
      spacing: { gap: '1' },
      margin: '3',
      depth: '1',
    })) as { cells: number }
    const addMs = now() - t
    expect(out.cells).toBeGreaterThan(1800)
    expect(out.cells).toBeLessThanOrEqual(2000)
    await s.run('project.apply', {})

    // the cells alone (uncached: a fresh definition)
    t = now()
    const r = resolvePattern(
      region2d,
      {
        kind: 'pattern',
        op: 'add',
        cell: [
          {
            kind: 'polygon',
            op: 'add',
            center: [0, 0],
            sides: 6,
            diameter: 3,
            across: 'flats',
            cornerRadius: 0.3001,
          },
        ],
        cellRotation: 30,
        lattice: 'hex',
        angle: 0,
        spacing: { gap: 1 },
        boundary: { min: [0, 0], max: [190, 160] },
        margin: 3,
      },
      (d) => resolveDefinition(region2d, d),
    ).unwrap()
    const resolveMs = now() - t
    expect(r.cells).toBe(out.cells)

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
    kernel.withSolids((x) => evaluatePart(input, x, steps, region2d)).unwrap()
    const evalMs = now() - t

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
    console.log(
      `patterns perf: ${out.cells} cells; resolve ${resolveMs.toFixed(0)} ms, add ${addMs.toFixed(0)} ms, input ${inputMs.toFixed(0)} ms, evaluate ${evalMs.toFixed(0)} ms (longest step ${longest.toFixed(0)} ms), generate ${generateMs.toFixed(0)} ms, export ${exportMs.toFixed(0)} ms, ${e.lines.length} lines`,
    )
    expect(resolveMs).toBeLessThan(100)
    expect(addMs).toBeLessThan(5000)
    expect(inputMs).toBeLessThan(100)
    expect(evalMs).toBeLessThan(3000)
    expect(generateMs).toBeLessThan(10000)
    expect(exportMs).toBeLessThan(5000)
  })

  it('the Z-reference touch-off spot on a face with 2 000 holes (S8 finding 7)', () => {
    const cells = resolvePattern(
      region2d,
      {
        kind: 'pattern',
        op: 'add',
        cell: [{ kind: 'circle', op: 'add', center: [0, 0], diameter: 2 }],
        cellRotation: 0,
        lattice: 'hex',
        angle: 0,
        spacing: { gap: 2 },
        boundary: { min: [0, 0], max: [185, 155] },
        margin: 3,
      },
      (d) => resolveDefinition(region2d, d),
    ).unwrap()
    expect(cells.cells).toBeGreaterThan(1800)
    const face = expectOk(
      region2d.normalise([
        {
          elements: [
            { kind: 'line', a: [0, 0], b: [185, 0] },
            { kind: 'line', a: [185, 0], b: [185, 155] },
            { kind: 'line', a: [185, 155], b: [0, 155] },
            { kind: 'line', a: [0, 155], b: [0, 0] },
          ],
        },
      ]),
    )
    const patch = expectOk(region2d.difference(face, cells.region))
    const t = now()
    const spot = touchOffSpot(region2d, patch, 0.5, 0.5)
    const ms = now() - t
    console.log(`patterns perf: touch-off spot over ${cells.cells} holes ${ms.toFixed(0)} ms`)
    expect(spot).toBeDefined()
    expect(ms).toBeLessThan(600)
  })
})
