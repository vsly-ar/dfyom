// The M6 countersink with a 1/4" 90° V-bit through the plan (hardening DF142, user TG #488): the
// bore by the 1/4" end mill comes first, the countersink is contoured in levels by the V-bit with
// no plan errors, and the program cuts it down to the countersink's depth.
// Spec: docs/modes/plan-v0.4.md#chamfers-wider-than-the-cutting-edge-hardening-df142
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { opsOf, planSetup } from './plan.fixture'

const tool = (values: object) => ({ overallLength: '60', fluteCount: '1', ...values })

describe('M6 countersink in levels (DF142)', () => {
  it('bore first, then the V-bit in levels: no errors, cut to the countersink depth', async () => {
    const services = { toolpaths: createToolpathCache(), workers: createInProcessWorkers() }
    const s = await planSetup({ part: false, services })
    const add = async (values: object) =>
      ((await s.run('library.tool.add', { values })) as { id: string }).id
    await add(
      tool({ name: '1/4in 1F end mill', type: 'flatEndMill', diameter: '1/4"', fluteLength: '25' }),
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
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M6',
      type: 'countersink',
      // the user's Ø6.4 → Ø13.84 (close fit; dk 13.44 + 2 × 0.2 head sink)
      fit: 'close',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const ops = opsOf(s.plan(planId))
    // the bore before its countersink (the edge dependency)
    expect(ops.map((o) => o.designOperationIds)).toEqual([['hole1_drill'], ['hole1_countersink']])
    const cs = s.plan(planId).snapshots.find((c) => c.id === ops[1]!.tool)!
    expect(cs.libraryItemId).toBe(vbit)
    for (const op of ops)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '16000', feedRate: '600', plungeRate: '200' },
      })
    const listed = s.query('plan.operation.list', { planId }) as {
      operations: { strategy: Record<string, unknown> }[]
    }
    expect(listed.operations[1]!.strategy).toMatchObject({ entry: 'contour' })
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    const out = expectOk(await exportPlan(s.d.doc, planId, services as never))
    // the countersink's last level: (13.84 − 6.4) / 2 = 3.72 below the top
    expect(out.text).toMatch(/Z-3\.72\b/)
  })
})
