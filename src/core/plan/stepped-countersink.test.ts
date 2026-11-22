// A stepped countersunk hole through the plan (v0.4 F7, D41): the hole and its terraces get one
// end mill, the plan resolves the chamfer's entry to `stepped`, and the exported program loads
// that one tool and never changes it. Spec: docs/modes/plan-v0.4.md#stepped-chamfer-f7,
// docs/modes/design-v0.4.md#stepped-countersink-f7-d41
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createDispatcher } from '../commands/dispatcher'
import { createInProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeIds, uiSource } from '../commands/testing'
import { exportPlan, type ExportFiles } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { designIds, opsOf, planSetup, type PlanSetup } from './plan.fixture'

const ui = uiSource()

describe('stepped countersink in a plan (F7)', () => {
  it('one end mill bores the hole and cuts the terraces: no tool change', async () => {
    const s = await planSetup({ part: false })
    // M5: Ø5.5 hole; the 4 mm end mill bores it (2.75 < 4 < 5.5), the drill and 6 mm do not
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M5',
      type: 'countersink',
      csMethod: 'stepped',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const ops = opsOf(s.plan(planId))
    expect(ops.map((o) => o.designOperationIds)).toEqual([['hole1_drill'], ['hole1_countersink']])
    expect(new Set(ops.map((o) => o.tool)).size).toBe(1)
    const tool = s.plan(planId).snapshots.find((c) => c.id === ops[0]!.tool)!
    expect(tool.values).toMatchObject({ type: 'flatEndMill', name: expect.stringContaining('4') })
    for (const op of ops)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '12000', feedRate: '600', plungeRate: '200' },
      })
    const listed = s.query('plan.operation.list', { planId }) as {
      operations: { strategy: Record<string, unknown> }[]
    }
    // M5 cone (11.6 − 5.5) / 2 = 3.05 mm deep → 4 terraces of 0.7625 mm
    expect(listed.operations[1]!.strategy).toMatchObject({ entry: 'stepped' })
    expect(listed.operations[1]!.strategy['cutDepth']).toBeCloseTo(0.7625, 9)
    // a plunge or contour cannot be chosen for it
    const e = await s.failWith(
      'plan.operation.update',
      { planId, planOperationId: ops[1]!.id, strategy: { entry: 'plunge' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['strategy.entry', 'stepped']])
    const written: string[] = []
    const files: ExportFiles = {
      write(target, text) {
        written.push(text)
        return Promise.resolve(Ok({ filePath: target }))
      },
    }
    const d = createDispatcher({
      registry: expectOk(createAppRegistry()),
      doc: s.d.doc,
      revision: s.d.revision,
      ids: fakeIds(),
      services: {
        workers: createInProcessWorkers(),
        library: s.library,
        toolpaths: createToolpathCache(),
        exportFiles: files,
      },
    })
    const r = expectOk(await d.dispatch('plan.export', { planId, target: '/out/p.nc' }, ui))
      .value as { stats: { toolChanges: number }; warnings: { severity: string }[] }
    // the first tool is loaded before the program: no pause for a tool change at all
    expect(r.stats.toolChanges).toBe(0)
    expect(written[0]!.match(/TOOL CHANGE/g)).toHaveLength(1)
  })

  // the default order (drillings, pockets, chamfers) would put the pocket's 6 mm end mill between
  // the bore and its terraces; a chamfer sharing its edge's tool follows it instead
  const M5_STEPPED = { fastener: 'M5', type: 'countersink', csMethod: 'stepped' }
  const pocket = (s: PlanSetup) =>
    s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['70', '30'],
        length: '20',
        width: '20',
        cornerRadius: '4',
      },
      depth: '2',
    })
  async function exported(s: PlanSetup, planId: string, services: object) {
    for (const op of opsOf(s.plan(planId)))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '12000', feedRate: '600', plungeRate: '200' },
      })
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    return expectOk(await exportPlan(s.d.doc, planId, services as never))
  }
  const newServices = () => ({
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers(),
  })

  it('a pocket with another tool cuts after the terraces, not between: one tool change', async () => {
    const services = newServices()
    const s = await planSetup({ part: false, services })
    await pocket(s)
    await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...M5_STEPPED })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    expect(designIds(s.plan(planId))).toEqual(['hole1_drill', 'hole1_countersink', 'pocket1'])
    const ops = opsOf(s.plan(planId))
    expect(ops[1]!.tool).toBe(ops[0]!.tool)
    expect(ops[2]!.tool).not.toBe(ops[0]!.tool)
    expect((await exported(s, planId, services)).stats.toolChanges).toBe(1)
  })

  it('a stepped countersunk hole added to a plan joins its bore on rebuild', async () => {
    const services = newServices()
    const s = await planSetup({ part: false, services })
    await pocket(s)
    await s.run('project.apply', {})
    // a draft plan follows the design: the new hole's operations are placed on rebuild
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...M5_STEPPED })
    await s.run('project.apply', {})
    expect(designIds(s.plan(planId))).toEqual(['hole1_drill', 'hole1_countersink', 'pocket1'])
    expect((await exported(s, planId, services)).stats.toolChanges).toBe(1)
  })

  it('Clones of a stepped countersunk hole: every bore and terrace in one tool block (D34)', async () => {
    const services = newServices()
    const s = await planSetup({ part: false, services })
    await pocket(s)
    await s.run('design.hole.add', { partId: s.partId, center: ['15', '30'], ...M5_STEPPED })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureId: 'hole1' },
      rows: [{ kind: 'offset', count: 2, du: '15', dv: '0' }],
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    expect(opsOf(s.plan(planId)).map((o) => o.designOperationIds)).toEqual([
      ['hole1_drill', 'clones1_2_hole1_drill', 'clones1_3_hole1_drill'],
      ['hole1_countersink', 'clones1_2_hole1_countersink', 'clones1_3_hole1_countersink'],
      ['pocket1'],
    ])
    expect((await exported(s, planId, services)).stats.toolChanges).toBe(1)
  })
})
