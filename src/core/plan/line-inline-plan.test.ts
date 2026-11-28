// A Line's inline Straight / Arc in a plan (DF147 SL2, engraved-patterns.md § Simple Line): a
// straight Line 22 mm from the front edge and a three-point arc export the same program as the
// same lines drawn as named shapes (byte-equal motion), and "Convert to shape" keeps it.
// Doc: docs/modes/engraved-patterns.md#implementation-sl1sl2
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { planSetup } from './plan.fixture'

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

/** The program's motion lines (header and comments left out: names and dates differ). */
const motion = (text: string) => text.split('\n').filter((l) => /^(G[0-3]|X|Y|Z)/.test(l))

/** A plan of one Line (`paths` as given, or a named shape from `items` placed at `center`). */
async function program(
  line: (s: Awaited<ReturnType<typeof planSetup>>) => Promise<Record<string, unknown>>,
  after?: (s: Awaited<ReturnType<typeof planSetup>>) => Promise<void>,
): Promise<string> {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc })
  await s.run('library.tool.add', { values: libraryInput(V_BIT) })
  await s.run('design.line.add', { partId: s.partId, depth: '0.8', ...(await line(s)) })
  if (after !== undefined) await after(s)
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  return expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
}

const shape = async (
  s: Awaited<ReturnType<typeof planSetup>>,
  segments: unknown[],
  center: [string, string],
) => {
  const { shapeId } = (await s.run('design.shape.add', {
    partId: s.partId,
    items: [{ kind: 'path', closed: false, start: ['0', '0'], segments }],
  })) as { shapeId: string }
  return { paths: [{ shapeId, center }] }
}

describe('a Line in Straight / Arc mode in a plan (DF147 SL2)', () => {
  it('a straight line 22 mm from the front edge cuts as the same line drawn as a shape', async () => {
    const inline = await program(async () => ({
      paths: [{ segment: { start: ['0', '22'], end: ['100', '22'] } }],
    }))
    const named = await program((s) => shape(s, [{ kind: 'line', to: ['100', '0'] }], ['50', '22']))
    expect(motion(inline).length).toBeGreaterThan(4)
    expect(motion(inline)).toEqual(motion(named))
  })

  it('a three-point arc cuts as the same arc drawn as a shape; Convert to shape keeps it', async () => {
    // chord 60, sagitta 15: radius 37.5, its box 20…80 × 30…45 (centre 50, 37.5)
    const arc = { arc: { start: ['20', '30'], through: ['50', '45'], end: ['80', '30'] } }
    const inline = await program(async () => ({ paths: [arc] }))
    const named = await program((s) =>
      shape(s, [{ kind: 'arc', to: ['60', '0'], radius: '37.5', cw: true }], ['50', '37.5']),
    )
    expect(motion(inline)).toEqual(motion(named))
    const converted = await program(
      async () => ({ paths: [arc] }),
      async (s) => {
        await s.run('design.shape.convert', { partId: s.partId, operationId: 'line1' })
        expect(s.op('line1')).toMatchObject({ paths: [{ kind: 'named', shapeId: 'shape1' }] })
      },
    )
    expect(motion(converted)).toEqual(motion(inline))
  })
})
