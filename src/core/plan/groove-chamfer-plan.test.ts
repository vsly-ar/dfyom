// One-sided chamfers along blind grooves through the plan (DF147 SL4 follow-up, engraved-patterns.md
// § Implementation (SL3–SL4)): on the user's plate with the 1/4" flat and 90° V-bit, (1) a straight
// Line 3 mm deep across the plate, bevelled 0.5 mm on its left; (2) a profile `on` along a 40 × 30
// rectangle, 3 mm deep, bevelled 0.5 mm outside. Each: the chamfer after its groove, no plan
// errors, on the heightmap of both toolpaths the kept wall bevelled, the other wall untouched,
// nothing gouged, no move meets more than its pass of uncut material (DF144 `deepCuts`); a golden
// and the virtual machine. Refusals: a bevel below the groove, a Line in Shape mode.
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import { chamferMill, endMill } from '../toolpath/testing/fixtures'
import { Heightmap } from '../toolpath/testing/oracles'
import { deepCuts } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { generated, PLATE, userTools } from './line-through.fixture'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const R = 6.22 / 2
const flatTool = endMill(6.22, 22)
const vTool = chamferMill(6.35, 90)

type Setup = Awaited<ReturnType<typeof planSetup>>

async function setup(): Promise<{ s: Setup; svc: object; flat: string; vbit: string }> {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: PLATE })
  const { flat, vbit } = await userTools(s)
  return { s, svc, flat, vbit }
}

/** Plans with the user's feeds (0.5 mm stepdown on the groove); returns the plan id. */
async function planned(s: Setup, groove: string): Promise<string> {
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  for (const op of opsOf(s.plan(planId)))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: {
        spindleSpeed: '18000',
        feedRate: '600',
        plungeRate: '150',
        ...(op.designOperationIds[0] === groove ? { stepdown: '0.5' } : {}),
      },
    })
  return planId
}

/**
 * The heightmap of the groove and the bevel: `expected(p)` the bevel's depth (≥ 0) on the kept
 * side, undefined on the other side or inside the groove; gouge / short / other-side cells.
 */
function tally(
  slot: Toolpath,
  bevel: Toolpath,
  classify: (p: readonly [number, number]) => 'groove' | 'other' | number,
): { gouge: number; short: number; other: number } {
  const hm = new Heightmap(100, 100, 0.05)
  hm.sweep(flatTool, slot, 0.1)
  hm.sweep(vTool, bevel, 0.05)
  const out = { gouge: 0, short: 0, other: 0 }
  for (let j = 0; j < hm.ny; j++)
    for (let i = 0; i < hm.nx; i++) {
      const p = hm.center(i, j)
      const z = hm.z[j * hm.nx + i]!
      const c = classify(p)
      if (c === 'groove') {
        if (z < -3 - 0.06) out.gouge++
      } else if (c === 'other') {
        if (z < -1e-6) out.other++
      } else {
        if (z < -c - 0.06) out.gouge++
        if (z > -c + 0.06) out.short++
      }
    }
  return out
}

async function checked(s: Setup, svc: object, planId: string, groove: string, golden: string) {
  const ops = opsOf(s.plan(planId))
  expect(ops.map((o) => o.designOperationIds[0])).toEqual([groove, 'chamfer1'])
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
  const slot = await generated(s, planId, groove)
  const bevel = await generated(s, planId, 'chamfer1')
  expect(
    deepCuts(
      bevel,
      vTool,
      { length: 100, width: 100 },
      { stepdown: 0.5, finishRadial: 0 },
      { before: [{ tool: flatTool, tp: slot }], cell: 0.1 },
    ),
  ).toEqual([])
  const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(`__golden__/${golden}`)
  const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
  const run = await streamProgram(e.lines, machine)
  expect(run.lines).toBe(e.lines.length)
  return { slot, bevel }
}

describe('one-sided chamfers along blind grooves (DF147 SL4 follow-up)', () => {
  it('a Line 3 mm deep across the plate, bevelled on its left', async () => {
    const { s, svc, flat, vbit } = await setup()
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ segment: { start: ['0', '50'], end: ['100', '50'] } }],
      depth: '3',
    })
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'line1',
      tool: { kind: 'specific', toolLibraryItemId: flat },
    })
    await s.run('design.chamfer.add', {
      partId: s.partId,
      edgeOf: 'line1',
      width: '0.5',
      angle: '90',
      edgeSide: 'left',
    })
    await s.run('project.apply', {})
    const planId = await planned(s, 'line1')
    const ops = opsOf(s.plan(planId))
    expect(s.plan(planId).snapshots.find((c) => c.id === ops[1]!.tool)!.libraryItemId).toBe(vbit)
    const { slot, bevel } = await checked(s, svc, planId, 'line1', 'line-groove-chamfer.nc')
    const wall = 50 + R
    expect(
      tally(slot, bevel, ([, y]) =>
        Math.abs(y - 50) < R - 0.05
          ? 'groove'
          : y > wall + 0.05
            ? Math.max(0, 0.5 - (y - wall))
            : y < 50 - R - 0.05
              ? 'other'
              : 'groove',
      ),
    ).toEqual({ gouge: 0, short: 0, other: 0 })
  })

  it('a profile on a rectangle 3 mm deep, bevelled outside (rounded corners)', async () => {
    const { s, svc, flat } = await setup()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '50'],
        length: '40',
        width: '30',
        cornerRadius: '0',
      },
      side: 'on',
      depth: '3',
      slotWidth: '6.22',
      tabs: { count: '0' },
    })
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'profile1',
      tool: { kind: 'specific', toolLibraryItemId: flat },
    })
    await s.run('design.chamfer.add', {
      partId: s.partId,
      edgeOf: 'profile1',
      width: '0.5',
      angle: '90',
      edgeSide: 'right',
    })
    await s.run('project.apply', {})
    const planId = await planned(s, 'profile1')
    const { slot, bevel } = await checked(s, svc, planId, 'profile1', 'profile-on-chamfer.nc')
    // distance to the rectangle's outline (30..70 × 35..65), inside or out
    expect(
      tally(slot, bevel, ([x, y]) => {
        const inside = x > 30 && x < 70 && y > 35 && y < 65
        const dx = Math.max(30 - x, 0, x - 70)
        const dy = Math.max(35 - y, 0, y - 65)
        const d = inside ? Math.min(x - 30, 70 - x, y - 35, 65 - y) : Math.hypot(dx, dy)
        if (d < R - 0.05) return 'groove'
        if (d <= R + 0.05) return 'groove'
        return inside ? 'other' : Math.max(0, 0.5 - (d - R))
      }),
    ).toEqual({ gouge: 0, short: 0, other: 0 })
  })

  it('refuses a bevel below the groove and a Line in Shape mode', async () => {
    const { s } = await setup()
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ segment: { start: ['0', '50'], end: ['100', '50'] } }],
      depth: '0.4',
    })
    const deep = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'line1', width: '0.5', angle: '90', edgeSide: 'left' },
      'model.invariant',
    )
    expect(deep.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'width',
      'chamferBelowGroove',
    ])
    await s.run('design.shape.convert', { partId: s.partId, operationId: 'line1' })
    const shape = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'line1', edgeSide: 'left' },
      'model.invariant',
    )
    expect(shape.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'edgeOf',
      'chamferEdge',
    ])
  })
})
