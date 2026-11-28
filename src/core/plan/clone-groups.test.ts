// Clone groups in Plan (hardening DF146 G1): the source operation and its Clones instances share
// one plan operation for every kind (a pocket, its edge chamfer, a Line); the toolpath joins the
// instances in path order, each pass named by its instance; one feed edit reaches every
// instance's G-code; skipping an instance removes it from the group; a rebuild without the
// Clones splits the group back to the source's own plan operation.
// Spec: docs/modes/features.md#clone-groups-in-plan-hardening-df146
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { groupInstances, planOperationLabel } from './labels'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const CHAMFER = {
  name: 'Chamfer 12',
  type: 'chamferMill' as const,
  diameter: len('12'),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
}

/** A rectangle pocket with an edge chamfer and a Line, cloned twice along X. */
async function setup() {
  const services = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services })
  await s.run('library.tool.add', { values: libraryInput(CHAMFER) })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['15', '15'], length: '12', width: '10' },
    depth: '2',
  })
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: '0.5' })
  const { shapeId } = (await s.run('design.shape.add', {
    partId: s.partId,
    name: 'Groove',
    items: [
      {
        kind: 'path',
        closed: false,
        start: ['0', '0'],
        segments: [{ kind: 'line', to: ['10', '0'] }],
      },
    ],
  })) as { shapeId: string }
  await s.run('design.line.add', {
    partId: s.partId,
    paths: [{ shapeId, center: ['15', '32'] }],
    depth: '0.5',
  })
  await s.run('design.clones.add', {
    partId: s.partId,
    source: { operationIds: ['pocket1', 'chamfer1', 'line1'] },
    rows: [{ kind: 'offset', count: 2, du: '30', dv: '0' }],
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  for (const op of opsOf(s.plan(planId)))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '16000', feedRate: '900', plungeRate: '300' },
    })
  const rows = () =>
    opsOf(s.plan(planId)).map((o) => ({
      id: o.id,
      ids: o.designOperationIds,
      label: planOperationLabel(s.plan(planId).design.part, o.designOperationIds),
    }))
  const errors = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
      (w) => w.severity === 'error',
    )
  const toolpath = async (planOperationId: string) => {
    const { jobId } = expectOk(
      await s.d.dispatch(
        'plan.toolpath.generate',
        { planId, planOperationIds: [planOperationId] },
        ui,
      ),
    ).value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    return (s.query('plan.toolpath.get', { planId, planOperationId }) as { toolpath: Toolpath })
      .toolpath
  }
  const exported = async () => expectOk(await exportPlan(s.d.doc, planId, services))
  return { s, planId, rows, errors, toolpath, exported }
}

const group = (id: string) => [id, `clones1_2_${id}`, `clones1_3_${id}`]

describe('clone groups in Plan (DF146 G1)', () => {
  it('a pocket, its edge chamfer and a Line each plan as one operation over every instance', async () => {
    const t = await setup()
    expect(t.errors()).toEqual([])
    const rows = t.rows()
    expect(rows.map((r) => r.ids)).toEqual(
      expect.arrayContaining([group('pocket1'), group('chamfer1'), group('line1')]),
    )
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Pocket 1 × 3', 'Chamfer 1 × 3', 'Line 1 × 3']),
    )
    // G2's instance rows: the stable numbers, 1 = the source
    const part = t.s.plan(t.planId).design.part
    expect(groupInstances(part, group('pocket1'))).toMatchObject({
      of: 'Pocket 1',
      instances: [{ n: 1 }, { n: 2 }, { n: 3 }],
    })
    expect(groupInstances(part, ['pocket1']).instances).toEqual([])
    // the toolpath joins the instances in path order, each pass named by its instance
    for (const r of rows) {
      const tp = await t.toolpath(r.id)
      const order = tp.passes.map((p) => p.operationId).filter((x, i, a) => x !== a[i - 1])
      expect(order, r.label).toEqual(r.ids)
    }
    // the program names each position once per group
    const e = await t.exported()
    const positions = e.lines.filter((l) => l.startsWith('(Clones 1'))
    expect(positions).toEqual(
      Array.from({ length: 3 }, () => ['(Clones 1 #1)', '(Clones 1 #2)', '(Clones 1 #3)']).flat(),
    )
  }, 60_000) // plans and generates nine region toolpaths

  it('one feed edit reaches every instance; a skipped instance leaves the group', async () => {
    const t = await setup()
    const pocket = t.rows().find((r) => r.ids[0] === 'pocket1')!
    await t.s.run('plan.operation.update', {
      planId: t.planId,
      planOperationId: pocket.id,
      overrides: { feedRate: '777' },
    })
    const tp = await t.toolpath(pocket.id)
    for (const id of pocket.ids) {
      const feeds = tp.passes
        .filter((p) => p.operationId === id)
        .flatMap((p) => p.moves.flatMap((m) => (m.kind === 'line' || m.kind === 'arc' ? [m] : [])))
        .map((m) => m.feed)
      expect(feeds, id).toContain(777)
      expect(feeds, id).not.toContain(900)
    }
    // skip a position in the Clones: its operations leave every group, the settings stay
    await t.s.run('design.clones.update', {
      partId: t.s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'offset', count: 2, du: '30', dv: '0', skip: [1] }],
    })
    await t.s.run('project.apply', {})
    await t.s.run('plan.rebuild', { planId: t.planId })
    const after = t.rows().find((r) => r.ids[0] === 'pocket1')!
    expect(after.id).toBe(pocket.id)
    expect(after.ids).toHaveLength(2)
    expect(after.ids[0]).toBe('pocket1')
    const skipped = pocket.ids.find((id) => !after.ids.includes(id))!
    expect(t.rows().flatMap((r) => r.ids)).not.toContain(skipped)
    const plan = t.s.plan(t.planId)
    const kept = opsOf(plan).find((o) => o.id === pocket.id)!
    expect(kept.overrides.feedRate).toMatchObject({ source: '777' })
    // without the Clones the group splits back to the source's own plan operation
    await t.s.run('design.feature.remove', { partId: t.s.partId, featureId: 'clones1' })
    await t.s.run('project.apply', {})
    await t.s.run('plan.rebuild', { planId: t.planId })
    expect(t.rows().map((r) => r.ids)).toEqual(
      expect.arrayContaining([['pocket1'], ['chamfer1'], ['line1']]),
    )
    expect(t.rows().find((r) => r.ids[0] === 'pocket1')!.id).toBe(pocket.id)
  }, 60_000)
})
