// The rest region `plan.toolpath.get` returns for the Plan viewport's shading (hardening DF122,
// R3's viewport item): a pocket and an outside profile cut after their roughing; none for the
// roughing itself or without one.
// Spec: docs/modes/roughing.md#plan-viewport-rest-shading
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { len, libraryInput } from '../library/library.fixture'
import { flat6, opsOf, planSetup } from '../plan/plan.fixture'
import { createToolpathCache } from './cache'

const region2d = nodeRegion2d()
const ui = uiSource()

const LID = {
  name: 'Lid',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

interface Rest {
  level: number
  area: number
  patch: { outer: [number, number][]; holes: [number, number][][] }[]
}

/** The lid with one operation added by `add`, planned and generated; `rest` per design op. */
async function planned(
  add: (s: Awaited<ReturnType<typeof planSetup>>, flat3: string) => Promise<void>,
) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: LID })
  const tool = (name: string, d: string) =>
    s.run('library.tool.add', {
      values: libraryInput({ ...flat6(), name, diameter: len(d), fluteLength: len('15') }),
    }) as Promise<{ id: string }>
  const flat3 = (await tool('Flat 3', '3')).id
  await tool('Flat 8', '8')
  await add(s, flat3)
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const gen = expectOk(await s.d.job(jobId).unwrap().result) as { operations: { status: string }[] }
  // DF122: an owner whose roughing left no rest at some level still generates (R4 fix)
  expect(gen.operations.map((o) => o.status)).not.toContain('failed')
  const rest = new Map<string, Rest | null>()
  for (const o of opsOf(s.plan(planId)))
    rest.set(
      o.designOperationIds.join('+'),
      (s.query('plan.toolpath.get', { planId, planOperationId: o.id }) as { rest: Rest | null })
        .rest,
    )
  return rest
}

const points = (r: Rest) => r.patch.flatMap((p) => [...p.outer, ...p.holes.flat()])

const pocket = (roughing: boolean) => async (s: Awaited<ReturnType<typeof planSetup>>) => {
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '60',
      width: '40',
      cornerRadius: '1.5',
    },
    depth: '8',
    ...(roughing ? { roughing: true } : {}),
  })
}

describe('rest shading (DF122, R3 viewport item)', () => {
  it("a pocket after its roughing: the band and corners the Ø 8 left, at the pocket's floor", async () => {
    const rest = await planned(pocket(true))
    expect(rest.get('pocket1_roughing')).toBeNull()
    const r = rest.get('pocket1')!
    expect(r).not.toBeNull()
    expect(r.level).toBeCloseTo(-8, 6)
    // the 60 × 40 pocket less the Ø 8's 59.6 × 39.6 R 4 (wall margin ≈ 0.2): a thin ring
    expect(r.area).toBeGreaterThan(10)
    expect(r.area).toBeLessThan(150)
    // one ring along the walls: inside the pocket, round its middle
    expect(r.patch).toHaveLength(1)
    expect(r.patch[0]!.holes).toHaveLength(1)
    for (const [x, y] of points(r)) {
      expect(x).toBeGreaterThanOrEqual(10 - 1e-6)
      expect(x).toBeLessThanOrEqual(70 + 1e-6)
      expect(y).toBeGreaterThanOrEqual(5 - 1e-6)
      expect(y).toBeLessThanOrEqual(45 + 1e-6)
    }
  })

  it('no rest without a roughing', async () => {
    const rest = await planned(pocket(false))
    expect([...rest.values()]).toEqual([null])
  })

  it('an outside profile after its roughing: the rest in its slot', async () => {
    const rest = await planned(async (s, flat3) => {
      await s.run('design.profile.add', {
        partId: s.partId,
        shape: {
          kind: 'rectangle',
          center: ['40', '25'],
          length: '40',
          width: '20',
          cornerRadius: '0',
        },
        side: 'outside',
        slotWidth: '9',
        depth: '6',
        roughing: true,
      })
      await s.run('design.operation.tool.set', {
        partId: s.partId,
        operationId: 'profile1',
        tool: { kind: 'specific', toolLibraryItemId: flat3 },
      })
    })
    const r = [...rest.entries()].find(([k]) => k === 'profile1')?.[1]
    expect(rest.get('profile1_roughing')).toBeNull()
    expect(r).toBeTruthy()
    expect(r!.level).toBeLessThan(0)
    // in the slot: outside the 40 × 20 part, within 9 mm of it
    for (const [x, y] of points(r!)) {
      const outside = x <= 20 + 1e-3 || x >= 60 - 1e-3 || y <= 15 + 1e-3 || y >= 35 - 1e-3
      expect(outside).toBe(true)
      expect(x).toBeGreaterThanOrEqual(11 - 1e-3)
      expect(x).toBeLessThanOrEqual(69 + 1e-3)
    }
  })
})
