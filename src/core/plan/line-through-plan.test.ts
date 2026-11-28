// The user's cut-off through the plan (DF147 SL3, engraved-patterns.md § Cutting the part out along
// a line): a 100 mm aluminium plate, a straight through Line 22 mm from the front edge cut by the
// 1/4" (Ø6.22) flat end mill, 10 mm + 0.4 mm breakthrough. Evaluated (two pieces, the cut-off's
// loose-piece warning), planned with no errors (the cut-off last of its face, the workholding
// warning naming both sides), generated (no move meets more than the stepdown of uncut material,
// DF144 `deepCuts`), exported (a golden) and streamed through the virtual machine.
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import { endMill } from '../toolpath/testing/fixtures'
import { deepCuts } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

export const PLATE = {
  name: 'Plate',
  shape: 'block' as const,
  length: '100',
  width: '100',
  thickness: '10',
  material: { name: 'Aluminium 6061', class: 'aluminum' as const },
}

const tool = (values: object) => ({ overallLength: '60', fluteCount: '1', ...values })

/** The user's 1/4" tools: the Ø6.22 1F flat end mill and the 90° V-bit. */
export async function userTools(s: Awaited<ReturnType<typeof planSetup>>) {
  const add = async (values: object) =>
    ((await s.run('library.tool.add', { values })) as { id: string }).id
  const flat = await add(
    tool({ name: 'Wexme 1/4in 1F', type: 'flatEndMill', diameter: '6.22', fluteLength: '22' }),
  )
  const vbit = await add(
    tool({
      name: '90 V-bit 1/4in',
      type: 'chamferMill',
      diameter: '1/4"',
      angle: '90',
      fluteLength: '10',
    }),
  )
  return { flat, vbit }
}

/** The cut-off: a straight through Line 22 mm from the front edge, the 1/4" flat on it. */
export async function cutOff(s: Awaited<ReturnType<typeof planSetup>>, flat: string) {
  await s.run('design.line.add', {
    partId: s.partId,
    paths: [{ segment: { start: ['0', '22'], end: ['100', '22'] } }],
    depth: 'through',
  })
  await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: 'line1',
    tool: { kind: 'specific', toolLibraryItemId: flat },
  })
}

/** Plans with the user's feeds and 0.4 mm breakthrough; returns the plan id. */
export async function planned(s: Awaited<ReturnType<typeof planSetup>>): Promise<string> {
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  for (const op of opsOf(s.plan(planId)))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '18000', feedRate: '600', plungeRate: '150', stepdown: '0.5' },
      ...(op.designOperationIds[0] === 'line1' ? { strategy: { breakthrough: '0.4' } } : {}),
    })
  return planId
}

/** Generates every toolpath; the toolpath of `designId`. */
export async function generated(
  s: Awaited<ReturnType<typeof planSetup>>,
  planId: string,
  designId: string,
): Promise<Toolpath> {
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { status: string }[]
  }
  expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
  const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(designId))!
  return (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
  ).toolpath
}

describe("the user's cut-off (DF147 SL3)", () => {
  it('evaluates in two pieces, plans with no error, cuts within the stepdown, exports, streams', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: PLATE })
    const { flat } = await userTools(s)
    await cutOff(s, flat)
    await s.run('project.apply', {})

    // the slot through the plate: two pieces, the cut-off's own loose-piece warning
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const line = input.operations[0]!
    expect(line).toMatchObject({ kind: 'line', through: true, depth: { start: 10, end: 10 } })
    expect(line).toMatchObject({ cutter: { kind: 'flat', diameter: 6.22 } })
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    expect(solid.pieces).toBe(2)
    expect(Math.abs(100 * 100 * 10 - solid.volume - 100 * 6.22 * 10)).toBeLessThan(5)
    const loose = solid.warnings.filter((w) => w.code === 'dfm.loosePiece')
    expect(loose).toHaveLength(1)
    expect(loose[0]).toMatchObject({ operation: 'line1', params: { cutOff: true } })

    const planId = await planned(s)
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
      .warnings
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    // no workholding yet: both sides are named loose
    const cut = warnings.find((w) => w.code === 'plan.workholding.cutOffLoose')
    expect(cut).toMatchObject({ params: { line: 'line1', sides: 'left,right' } })
    expect(cut!.message).toMatch(/Clamp both sides/)

    const toolpath = await generated(s, planId, 'line1')
    const tool = endMill(6.22, 22)
    const zs = toolpath.passes.flatMap((p) =>
      p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])),
    )
    expect(Math.min(...zs)).toBeCloseTo(-10.4, 9)
    // every feed move meets at most the stepdown of uncut material (DF144)
    expect(
      deepCuts(toolpath, tool, { length: 100, width: 100 }, { stepdown: 0.5, finishRadial: 0 }),
    ).toEqual([])

    const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot('__golden__/line-cut-off.nc')
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })

  it('a pocket on the plate comes before the cut-off; toe clamps on both sides silence the warning', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: PLATE })
    const { flat } = await userTools(s)
    await cutOff(s, flat)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['50', '60'], length: '30', width: '20' },
      depth: '2',
    })
    await s.run('project.apply', {})
    const planId = await planned(s)
    // the cut-off frees both sides: it comes last of its face
    expect(opsOf(s.plan(planId)).map((o) => o.designOperationIds[0])).toEqual(['pocket1', 'line1'])
    const list = () =>
      (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings
    expect(list().filter((w) => w.code === 'plan.loosePiece')).toEqual([])
    const setupId = s.plan(planId).setups[0]!.id
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [
        { kind: 'toeClamp', edge: 'vMin', at: '50' },
        { kind: 'toeClamp', edge: 'vMax', at: '50' },
      ],
    })
    expect(list().filter((w) => w.code === 'plan.workholding.cutOffLoose')).toEqual([])
    // only the back clamp: the front strip is loose
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'vMax', at: '50' }],
    })
    const cut = list().find((w) => w.code === 'plan.workholding.cutOffLoose')
    expect(cut).toMatchObject({ params: { sides: 'right' } })
  })
})
