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
import type { ExportFiles } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { opsOf, planSetup } from './plan.fixture'

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
})
