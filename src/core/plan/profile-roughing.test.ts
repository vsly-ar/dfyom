// Exit test of roughing passes on profiles (hardening DF122, slice R4): the lid's outline (a plus
// of 56 × 20 and 20 × 36 with sharp inside corners) cut through the 80 × 50 × 12 walnut lid as an
// outside profile with a 7 mm slot, four 2 mm tabs and a Ø 3 owner; the roughing tool a Ø 6 (auto:
// the largest library end mill in the slot). The roughing runs first, stops above the tabs (the
// skin) and cuts no tabs; the owner cuts the skin with its tabs, and above it only the corners the
// Ø 6 left (R3 clipping) plus its finishing pass. Oracles: nothing left in the slot, no gouge, the
// same heights as the Ø 3 alone, no plunge into material; the program exports for GRBL and streams
// to Idle; the plan takes less time than the Ø 3 alone. Also: a profile without tabs keeps the
// 0.5 mm skin, and `side: on` refuses roughing.
// Spec: docs/modes/roughing.md#goldens-and-tests, docs/modes/roughing.md#implementation-r4
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { rect } from '../geometry/2d/testing/fixtures'
import { len, libraryInput } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import { endMill } from '../toolpath/testing/fixtures'
import { airCut, heightDifference, regionCoverage } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { flat6, opsOf, planSetup } from './plan.fixture'

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

/** The outline: a plus of two rectangles centred on the lid (four sharp inside corners). */
const PLUS = [
  { kind: 'rectangle', center: ['0', '0'], length: '56', width: '20', cornerRadius: '0' },
  { kind: 'rectangle', center: ['0', '0'], length: '20', width: '36', cornerRadius: '0' },
]

const SIZE = { length: 80, width: 50 }
const lowest = (tp: Toolpath) =>
  Math.min(
    ...tp.passes.flatMap((p) => p.moves.flatMap((m) => (m.kind === 'drill' ? [] : [m.to[2]]))),
  )

/** The lid's outline profile planned, generated, exported and streamed; with or without roughing. */
async function lid(roughing: unknown, tabs: object = {}) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: LID })
  const flat3 = (
    (await s.run('library.tool.add', {
      values: libraryInput({
        ...flat6(),
        name: 'Flat 3',
        diameter: len('3'),
        fluteLength: len('15'),
        presets: [],
      }),
    })) as { id: string }
  ).id
  await s.run('design.shape.add', { partId: s.partId, items: PLUS })
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['40', '25'] },
    side: 'outside',
    slotWidth: '7',
    tabs,
    ...(roughing === undefined ? {} : { roughing }),
  })
  // the owner's Ø 3 (its sharp inside corners want the smallest tool)
  await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: 'profile1',
    tool: { kind: 'specific', toolLibraryItemId: flat3 },
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { status: string }[]
  }
  expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
  const ops = opsOf(s.plan(planId))
  const paths = ops.map(
    (o) =>
      (s.query('plan.toolpath.get', { planId, planOperationId: o.id }) as { toolpath: Toolpath })
        .toolpath,
  )
  const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  const loaded = loadPlan(s.d.doc, planId, 'test').unwrap()
  const run = await streamProgram(e.lines, loaded.machine.unwrap())
  expect(run.lines).toBe(e.lines.length)
  const diameters = ops.map(
    (o) =>
      (
        loaded.dto.snapshots.find((x) => x.id === o.tool)?.values as {
          diameter?: { source?: string }
        }
      )?.diameter?.source,
  )
  const seconds = paths.reduce((a, t) => a + t.stats.estimatedSeconds, 0)
  return { s, planId, ops, paths, lines: e.lines, diameters, seconds, warnings }
}

/** The plus outline and its 7 mm slot, in the lid frame. */
function slot() {
  const part = region2d
    .union(
      region2d.normalise([rect(12, 15, 56, 20, 0)]).unwrap(),
      region2d.normalise([rect(30, 7, 20, 36, 0)]).unwrap(),
    )
    .unwrap()
  const outer = region2d.offset(part, -7).unwrap()
  const region = region2d.difference(outer, part).unwrap()
  // the Ø 3's tool centres in the slot
  const c0 = region2d
    .difference(region2d.offset(part, -5.5).unwrap(), region2d.offset(part, -1.5).unwrap())
    .unwrap()
  return { region, c0 }
}

describe('profile roughing DF122 R4 exit', () => {
  it('a through outline: Ø 6 roughing above the tabs, Ø 3 rest and skin, golden, oracle, time', async () => {
    const plain = await lid(undefined)
    const rough = await lid(true)
    expect(rough.ops.map((o) => o.designOperationIds.join('+'))).toEqual([
      'profile1_roughing',
      'profile1',
    ])
    expect(rough.diameters).toEqual(['6', '3'])
    expect(plain.diameters).toEqual(['3'])
    const [roughTp, restTp] = rough.paths as [Toolpath, Toolpath]
    // the roughing: level passes only, no tabs, stopping at the tabs' top (2 mm above the bottom)
    expect(roughTp.passes.every((p) => p.kind === 'rough')).toBe(true)
    expect(lowest(roughTp)).toBeCloseTo(-10, 6)
    // the owner: the skin and the corners, its finishing pass through (breakthrough 0.5 mm)
    expect(restTp.passes.some((p) => p.kind === 'finish')).toBe(true)
    expect(lowest(restTp)).toBeCloseTo(-12.5, 6)
    expect(restTp.stats.cutLength).toBeLessThan(0.6 * plain.paths[0]!.stats.cutLength)
    expect(rough.seconds).toBeLessThan(plain.seconds)
    // oracles: the slot cleared to the breakthrough except the tabs, no gouge
    const { region, c0 } = slot()
    const before = [{ tool: endMill(6), tp: roughTp }]
    const cov = regionCoverage(
      region,
      c0,
      restTp,
      endMill(3),
      SIZE,
      -12.5,
      0.1,
      0.01,
      undefined,
      before,
    )
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    // the same heights as the Ø 3 alone (tabs included), no plunge into material
    const alone = [{ tool: endMill(3), tp: plain.paths[0]! }]
    expect(heightDifference(SIZE, [...before, { tool: endMill(3), tp: restTp }], alone)).toBe(0)
    const air = airCut(restTp, endMill(3), SIZE, before)
    // the only plunges into material are the tab layer's (entries and drops after the tabs, cut
    // whole below the roughing's floor), which the Ø 3 alone has too
    const plainAir = airCut(plain.paths[0]!, endMill(3), SIZE, [])
    expect(air.plunges).toBeLessThanOrEqual(plainAir.plunges)
    await expect(rough.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/profile-roughing.nc',
    )
  }, 90_000) // plans and simulates two profiles; slow under the check-under-load criterion

  it('without tabs the roughing keeps a 0.5 mm skin; side on refuses roughing', async () => {
    const r = await lid(true, { count: '0' })
    const [roughTp, restTp] = r.paths as [Toolpath, Toolpath]
    expect(lowest(roughTp)).toBeCloseTo(-11.5, 6)
    expect(lowest(restTp)).toBeCloseTo(-12.5, 6)
    const e = expectErrCode(
      await r.s.d.dispatch(
        'design.profile.update',
        { partId: r.s.partId, operationId: 'profile1', side: 'on', roughing: true },
        ui,
      ),
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('notForGroove')
    // a switch to `on` alone turns roughing off (one update, the roughing profile goes)
    await r.s.run('design.profile.update', {
      partId: r.s.partId,
      operationId: 'profile1',
      side: 'on',
    })
    expect(r.s.d.doc.parts[r.s.partId]!.operations.map((o) => o.id)).toEqual(['profile1'])
  }, 90_000) // plans and simulates a profile; slow under the check-under-load criterion
})
