// A Line in a plan (engraved-patterns.md E1): planned with the library's V-bit chosen over a flat
// end mill that also fits, and the plan copy's depth edited with a string through
// plan.design.operation.update (its paths and { start, end } stay design-side).
// Doc: docs/modes/engraved-patterns.md#implementation-e1
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()

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

describe('a Line in a plan', () => {
  it('is planned with the V-bit and takes a plan-only depth edit', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc })
    const vbit = (
      (await s.run('library.tool.add', { values: libraryInput(V_BIT) })) as { id: string }
    ).id
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      name: 'Flute',
      items: [
        {
          kind: 'path',
          closed: false,
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['40', '0'] }],
        },
      ],
    })) as { shapeId: string }
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId, center: ['50', '30'] }],
      depth: { start: '0.2', end: '1' },
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const op = opsOf(s.plan(planId))[0]!
    expect(op.designOperationIds).toEqual(['line1'])
    const snapshot = s.plan(planId).snapshots.find((x) => x.id === op.tool)
    expect(JSON.stringify(snapshot)).toContain(vbit)

    await s.toStatus(planId, 'settledDesign')
    await s.run('plan.design.operation.update', { planId, operationId: 'line1', depth: '0.6' })
    const copy = s.plan(planId).design.part.operations.find((o) => o.id === 'line1')!
    expect(copy).toMatchObject({ kind: 'line', depth: { source: '0.6' } })
    // the design keeps its ramp
    expect(s.op('line1')).toMatchObject({ depth: { start: { source: '0.2' } } })
  })
})
