// The user's one-sided chamfer through the plan (DF147 SL4, engraved-patterns.md § One-sided chamfer
// along a line): the cut-off of line-through-plan.test.ts, then a 0.5 × 45° chamfer on the side that
// stays (left of the line: the 78 mm part) with the 1/4" 90° V-bit. Ordered after the cut-off (the
// edge dependency), no plan errors, the cut-off warning names the part and the offcut; on the
// heightmap of both toolpaths the part's wall is bevelled 0.5 mm, the offcut's wall is untouched,
// nothing is gouged, no move meets more than its pass of uncut material (DF144 `deepCuts`); a golden
// and the virtual machine.
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import { chamferMill, endMill } from '../toolpath/testing/fixtures'
import { Heightmap } from '../toolpath/testing/oracles'
import { deepCuts } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { cutOff, generated, planned, PLATE, userTools } from './line-through.fixture'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const R = 6.22 / 2
const WALL = 22 + R

describe("the user's one-sided chamfer (DF147 SL4)", () => {
  it('after the cut-off, the part side bevelled 0.5 mm, the offcut side untouched', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: PLATE })
    const { flat, vbit } = await userTools(s)
    await cutOff(s, flat)
    await s.run('design.chamfer.add', {
      partId: s.partId,
      edgeOf: 'line1',
      width: '0.5',
      angle: '90',
      edgeSide: 'left',
    })
    await s.run('project.apply', {})
    const planId = await planned(s)
    const ops = opsOf(s.plan(planId))
    expect(ops.map((o) => o.designOperationIds[0])).toEqual(['line1', 'chamfer1'])
    expect(s.plan(planId).snapshots.find((c) => c.id === ops[1]!.tool)!.libraryItemId).toBe(vbit)
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
      .warnings
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    const cut = warnings.find((w) => w.code === 'plan.workholding.cutOffLoose')!
    expect(cut.message).toMatch(/the part \(left of .*\) and the offcut \(right of /)

    const slot = await generated(s, planId, 'line1')
    const bevel = await generated(s, planId, 'chamfer1')
    const flatTool = endMill(6.22, 22)
    const vTool = chamferMill(6.35, 90)
    expect(
      deepCuts(
        bevel,
        vTool,
        { length: 100, width: 100 },
        { stepdown: 0.5, finishRadial: 0 },
        { before: [{ tool: flatTool, tp: slot }], cell: 0.1 },
      ),
    ).toEqual([])
    const hm = new Heightmap(100, 100, 0.05)
    hm.sweep(flatTool, slot, 0.1)
    hm.sweep(vTool, bevel, 0.05)
    let gouge = 0
    let offcut = 0
    let short = 0
    for (let j = 0; j < hm.ny; j++)
      for (let i = 0; i < hm.nx; i++) {
        const [, y] = hm.center(i, j)
        const z = hm.z[j * hm.nx + i]!
        if (y > WALL) {
          // the bevel: 0.5 deep at the wall, rising 45° to the face 0.5 mm out
          const expected = -Math.max(0, 0.5 - (y - WALL))
          if (z < expected - 0.06) gouge++
          if (z > expected + 0.06) short++
        } else if (y < 22 - R - 0.05 && z < -1e-6) offcut++
      }
    expect(gouge).toBe(0)
    expect(short).toBe(0)
    expect(offcut).toBe(0)

    const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/line-cut-off-chamfer.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })

  it('refuses a missing side, and a side on any other edge', async () => {
    const s = await planSetup({ part: false, stock: PLATE })
    const { flat } = await userTools(s)
    await cutOff(s, flat)
    const missing = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'line1' },
      'model.invariant',
    )
    expect(missing.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'edgeSide',
      'chamferSide',
    ])
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['50', '60'], length: '30', width: '20' },
      depth: '2',
    })
    const other = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'pocket1', edgeSide: 'left' },
      'model.invariant',
    )
    expect(other.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'edgeSide',
      'chamferSide',
    ])
  })
})
