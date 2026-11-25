// Patterns P1 exit, headless (docs/modes/patterns.md#implementation-p1): a honeycomb of rounded
// hexagons on a walnut lid's top through the real commands, evaluated (removed volume = cells ×
// cell area × depth), planned, generated, exported (GRBL, a golden) and streamed through the
// virtual machine.
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { regionArea } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

const LID = {
  name: 'Lid',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

describe('patterns P1 exit', () => {
  it('a honeycomb on the lid top: volume, plan, export golden, virtual machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Honeycomb',
      lattice: 'hex',
      cell: {
        kind: 'polygon',
        sides: '6',
        diameter: '12',
        across: 'flats',
        cornerRadius: '2.5',
        rotation: '30',
      },
      spacing: { gap: '3' },
      margin: '5',
      depth: '2',
    })) as { cells: number; warnings: { code: string }[] }
    // rows of 4, 3 and 4 cells
    expect(out.cells).toBe(11)
    expect(out.warnings).toEqual([])
    await s.run('project.apply', {})

    // removed volume = cells × cell area × depth
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const pieces = pocket.shape.contour.region.pieces
    expect(pieces).toHaveLength(11)
    const cellArea = regionArea({ pieces: [pieces[0]!] })
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    // within the chords' shortfall on the rounded corners (0.01 mm chord tolerance)
    const want = 11 * cellArea * 2
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.002)

    // planned with no error, generated, exported, streamed
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('pattern1_pocket'))!
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
    ).toolpath
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-2, 9)
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-honeycomb-lid.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
})
