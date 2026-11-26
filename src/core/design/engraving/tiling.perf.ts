/**
 * Engraved patterns E4 at size (docs/modes/engraved-patterns.md#implementation-e4): a 100 × 100
 * face full of a small tile — Waves at 10 mm wide (10 × 5 tiles, 40 arcs each, ≈ 220 tiles,
 * clipped) — through the real commands: the tiles' resolution, `design.engraving.add` (its DFM
 * with `dfm.lineMerge` included), the part's geometry input, a fresh evaluation (the groove's
 * removal solid), the plan's toolpath generation and the export. Budgets ≈ 2–3× the measurement
 * on the development machine. Outside `npm run check`: `npm run perf`.
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
import { planSetup } from '../../plan/plan.fixture'
import { exportPlan } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import { partGeometryInput } from '../load'
import { resolveEngraving } from './resolve'

const region2d = nodeRegion2d()
const ui = uiSource()
const now = () => performance.now()

const V_BIT = {
  name: 'V-bit 60',
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('60'),
  fluteLength: len('6'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
}
const PLATE = {
  name: 'Plate',
  shape: 'block' as const,
  length: '100',
  width: '100',
  thickness: '6',
  material: { name: 'Birch plywood', class: 'sheetGood' as const },
}

describe('an engraved pattern of small tiles', () => {
  it('Waves 10 mm wide over 100 × 100: resolve, add, evaluate, generate, export within budget', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: PLATE })
    await s.run('library.tool.add', { values: libraryInput(V_BIT) })

    // the tiles alone (uncached: a record of its own)
    let t = now()
    const r = expectOk(
      resolveEngraving(
        {
          motif: { preset: 'waves' },
          boundary: { min: [0, 0], max: [100, 100] },
          margin: 3.0001,
          rotation: 0,
          size: 10,
          fit: 'clip',
          layout: { lattice: 'square', angle: 0, spacing: { gap: 0 } },
        },
        new Map(),
        undefined,
      ),
    )
    const resolveMs = now() - t

    t = now()
    const out = (await s.run('design.engraving.add', {
      partId: s.partId,
      motif: { preset: 'waves' },
      size: '10',
      depth: { min: '0.2', max: '0.8' },
    })) as { tiles: number; lines: number; length: number; warnings: { code: string }[] }
    const addMs = now() - t
    expect(out.tiles).toBeGreaterThan(200)
    expect(out.warnings.map((w) => w.code)).toEqual(['dfm.engravingHeavy'])
    await s.run('project.apply', {})

    t = now()
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const inputMs = now() - t
    const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
    t = now()
    kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
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
      `engraving tiles perf: ${out.tiles} tiles, ${r.facts.elements} arcs, ${out.lines} lines, ${Math.round(out.length)} mm; resolve ${resolveMs.toFixed(0)} ms, add ${addMs.toFixed(0)} ms, input ${inputMs.toFixed(0)} ms, evaluate ${evalMs.toFixed(0)} ms, generate ${generateMs.toFixed(0)} ms, export ${exportMs.toFixed(0)} ms, ${e.lines.length} gCode lines`,
    )
    expect(resolveMs).toBeLessThan(500)
    expect(addMs).toBeLessThan(5000)
    expect(inputMs).toBeLessThan(500)
    expect(evalMs).toBeLessThan(10000)
    expect(generateMs).toBeLessThan(15000)
    expect(exportMs).toBeLessThan(5000)
  })
})
