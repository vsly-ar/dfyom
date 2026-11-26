// Exit test of roughing passes on pockets (hardening DF122, slice R1): a 60 × 40 pocket 8 mm deep
// with R 1.5 corners on the 80 × 50 × 12 walnut lid, the pocket's tool a Ø 3 (its corners) and the
// roughing tool a Ø 8 (auto: the largest library end mill within 0.6 × the width). The roughing
// precedes the pocket with a tool change; the pocket skips the rings the roughing cleared; the two
// toolpaths together leave nothing the Ø 3 reaches and gouge nothing (heightmap oracle); the
// program exports for GRBL and streams through the virtual machine to Idle; the plan takes less
// time than the Ø 3 alone. Also: the roughing's strategy takes no finishing keys (notForRoughing),
// a thin wall margin warns (plan.roughingWallThin), a floor margin keeps the last level whole.
// Spec: docs/modes/roughing.md#goldens-and-tests, docs/modes/roughing.md#implementation-r1
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
import { regionCoverage } from '../toolpath/testing/region-coverage'
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

const POCKET = {
  shape: {
    kind: 'rectangle',
    center: ['40', '25'],
    length: '60',
    width: '40',
    cornerRadius: '1.5',
  },
  depth: '8',
}

/** The lid's pocket planned, generated, exported and streamed; with or without roughing. */
async function lid(roughing: unknown) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: LID })
  const add = (values: object) => s.run('library.tool.add', { values: libraryInput(values) })
  await add({ ...flat6(), name: 'Flat 3', diameter: len('3'), fluteLength: len('12'), presets: [] })
  await add({ ...flat6(), name: 'Flat 8', diameter: len('8') })
  await s.run('design.pocket.add', {
    partId: s.partId,
    ...POCKET,
    ...(roughing === undefined ? {} : { roughing }),
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

describe('pocket roughing DF122 R1 exit', () => {
  it('a 60 × 40 pocket: Ø 8 roughing then Ø 3 rest, golden, machine, oracle, time', async () => {
    const plain = await lid(undefined)
    const rough = await lid(true)
    expect(rough.ops.map((o) => o.designOperationIds.join('+'))).toEqual([
      'pocket1_roughing',
      'pocket1',
    ])
    expect(rough.diameters).toEqual(['8', '3'])
    expect(plain.diameters).toEqual(['3'])
    expect(
      rough.warnings.filter((w) => w.planOperationId !== undefined && w.code.startsWith('plan.r')),
    ).toEqual([])
    const [roughTp, restTp] = rough.paths as [Toolpath, Toolpath]
    // the Ø 3 skips the rings the Ø 8 cleared, keeps its outer rings and the finishing pass
    expect(restTp.stats.cutLength).toBeLessThan(0.5 * plain.paths[0]!.stats.cutLength)
    expect(restTp.passes.some((p) => p.kind === 'finish')).toBe(true)
    expect(roughTp.passes.every((p) => p.kind === 'rough')).toBe(true)
    // the plan takes less time with both tools than with the Ø 3 alone
    expect(rough.seconds).toBeLessThan(plain.seconds)
    // heightmap oracle: nothing the Ø 3 reaches is left above the floor, no gouge
    const region = region2d.normalise([rect(10, 5, 60, 40, 1.5)]).unwrap()
    const c0 = region2d.offset(region, 1.5).unwrap()
    const cov = regionCoverage(
      region,
      c0,
      restTp,
      endMill(3),
      { length: 80, width: 50 },
      -8,
      0.1,
      0.01,
      undefined,
      [{ tool: endMill(8), tp: roughTp }],
    )
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(cov.leftover).toBeLessThan(0.05)
    await expect(rough.lines.join('\n') + '\n').toMatchFileSnapshot('__golden__/pocket-roughing.nc')
    // measured (docs/modes/roughing.md#implementation-r1): the Ø 3 alone 17,345 mm in 575 s;
    // the Ø 8 2,571 mm in 38 s, then the Ø 3 2,527 mm in 88 s: 126 s
  })

  it('margins: the roughing strategy takes no finishing keys; a thin wall warns; a floor margin', async () => {
    const r = await lid({ wall: '0.1', floor: '1' })
    const roughOp = r.ops.find((o) => o.designOperationIds.includes('pocket1_roughing'))!
    const thin = r.warnings.filter((w) => w.code === 'plan.roughingWallThin')
    expect(thin.map((w) => [w.planOperationId, w.params['wall']])).toEqual([[roughOp.id, 0.1]])
    const e = expectErrCode(
      await r.s.d.dispatch(
        'plan.operation.update',
        { planId: r.planId, planOperationId: roughOp.id, strategy: { finishAllowance: '0.3' } },
        ui,
      ),
      'input.malformed',
    )
    expect(e.issues[0]?.rule).toBe('notForRoughing')
    // the roughing stops 1 mm above the floor; the Ø 3 still finishes every level to -8
    const [roughTp, restTp] = r.paths as [Toolpath, Toolpath]
    const lowest = (tp: Toolpath) =>
      Math.min(
        ...tp.passes.flatMap((p) => p.moves.flatMap((m) => (m.kind === 'drill' ? [] : [m.to[2]]))),
      )
    expect(lowest(roughTp)).toBeCloseTo(-7, 6)
    expect(lowest(restTp)).toBeCloseTo(-8, 6)
    const region = region2d.normalise([rect(10, 5, 60, 40, 1.5)]).unwrap()
    const c0 = region2d.offset(region, 1.5).unwrap()
    const cov = regionCoverage(
      region,
      c0,
      restTp,
      endMill(3),
      { length: 80, width: 50 },
      -8,
      0.1,
      0.01,
      undefined,
      [{ tool: endMill(8), tp: roughTp }],
    )
    expect(cov.gouge).toBe(0)
    expect(cov.leftover).toBeLessThan(0.05)
  })
})
