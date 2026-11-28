// The user's cut-off (DF147 SL3/SL4): a 100 mm aluminium plate, the 1/4" (Ø6.22) flat end mill and
// 90° V-bit, a straight through Line 22 mm from the front edge, planned with the user's feeds and
// 0.4 mm breakthrough. Shared by line-through-plan.test.ts and line-chamfer-plan.test.ts.
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { expect } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import type { Toolpath } from '../toolpath/model'
import { opsOf, planSetup } from './plan.fixture'

const ui = uiSource()

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
      overrides: {
        spindleSpeed: '18000',
        feedRate: '600',
        plungeRate: '150',
        // a chamfer has no stepdown (its rings are cut whole)
        ...(op.designOperationIds[0] === 'line1' ? { stepdown: '0.5' } : {}),
      },
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
  expect(
    gen.operations.every((o) => o.status === 'generated' || o.status === 'cached'),
    JSON.stringify(gen),
  ).toBe(true)
  const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(designId))!
  return (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
  ).toolpath
}
