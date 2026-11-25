// Edge chamfers E1 through the plan (docs/modes/edge-chamfers.md#implementation-e1): a chamfer on
// the rim of a named-shape pocket with an island, its tool chosen (a chamfer mill), entry contour,
// F10 feeds at the bevel's depth, the plunge refused (`loopEntry`), the slant check; and the E1
// exit-style flow headless: planned, generated, exported (GRBL) and streamed through the virtual
// machine, the bevel's tip Z in the program.
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { designIds, opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const chamferMill = (diameter: string, extra: object = {}) => ({
  name: `Chamfer ${diameter}`,
  type: 'chamferMill' as const,
  diameter: len(diameter),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
  ...extra,
})

interface OpView {
  id: string
  tool: unknown
  strategy: Record<string, number | string>
  feeds: Record<string, { value: number; source: string } | null>
}

/** A 40 × 24 R3 pocket with a Ø 8 island at (50, 30), 4 deep, its rim chamfered 1 × 45°. */
async function edgePlan(chamferArgs: object = {}) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc })
  const partId = s.partId
  const cm = (
    (await s.run('library.tool.add', { values: libraryInput(chamferMill('6')) })) as {
      id: string
    }
  ).id
  await s.run('design.shape.add', {
    partId,
    items: [
      { kind: 'rectangle', center: ['0', '0'], length: '40', width: '24', cornerRadius: '3' },
      { kind: 'circle', center: ['0', '0'], diameter: '8', op: 'subtract' },
    ],
  })
  await s.run('design.pocket.add', {
    partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
    depth: '4',
  })
  await s.run('design.chamfer.add', { partId, edgeOf: 'pocket1', width: '1', ...chamferArgs })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const planOp = (design: string) =>
    opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(design))!.id
  const chamfer = planOp('chamfer1')
  const view = () =>
    (s.query('plan.operation.list', { planId }) as { operations: OpView[] }).operations.find(
      (o) => o.id === chamfer,
    )!
  const errors = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
      (w) => w.severity === 'error',
    )
  const generate = async () => {
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    return expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { planOperationId: string; status: string }[]
    }
  }
  const toolpath = () =>
    (s.query('plan.toolpath.get', { planId, planOperationId: chamfer }) as { toolpath: Toolpath })
      .toolpath
  return { s, svc, planId, cm, chamfer, planOp, view, errors, generate, toolpath }
}

describe('edge chamfers in a plan (E1)', () => {
  it('chooses the chamfer mill, contours at the bevel depth, F10 feeds; the plunge is refused', async () => {
    const t = await edgePlan()
    expect(designIds(t.s.plan(t.planId))).toEqual(['pocket1', 'chamfer1'])
    expect(t.s.op('chamfer1').tool).toMatchObject({ kind: 'specific' })
    expect(t.errors()).toEqual([])
    const v = t.view()
    expect(v.strategy).toMatchObject({ entry: 'contour' })
    expect(v.strategy['cutDepth']).toBeCloseTo(1, 9)
    for (const f of ['spindleSpeed', 'feedRate', 'plungeRate']) expect(v.feeds[f], f).not.toBeNull()
    const e = await t.s.failWith(
      'plan.operation.update',
      { planId: t.planId, planOperationId: t.chamfer, strategy: { entry: 'plunge' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['loopEntry'])
  })

  it('no library mill covers a 3.5 bevel (none chosen); the 6 mm one assigned: slant', async () => {
    const t = await edgePlan({ width: '3.5' })
    expect(t.errors().map((w) => `${w.field}:${w.rule}`)).toEqual(['tool:noTool'])
    await t.s.run('plan.tool.assign', {
      planId: t.planId,
      planOperationId: t.chamfer,
      toolLibraryItemId: t.cm,
    })
    expect(t.errors().map((w) => `${w.field}:${w.rule}`)).toContain('tool:slant')
  })

  it('E1 exit: generated, exported and streamed through the virtual machine', async () => {
    const t = await edgePlan()
    const generated = await t.generate()
    expect(generated.operations.every((o) => o.status === 'generated')).toBe(true)
    const tp = t.toolpath()
    // one ring around the rim, one around the island, at tip Z = −1
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-1, 9)
    const e = expectOk(await exportPlan(t.s.d.doc, t.planId, t.svc))
    expect(e.regenerated).toEqual([])
    expect(e.lines.some((l) => /Z-1(\.0+)?\b/.test(l))).toBe(true)
    const machine = loadPlan(t.s.d.doc, t.planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
})
