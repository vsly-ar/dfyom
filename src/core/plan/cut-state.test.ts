// Cut state C1 (hardening DF135, docs/modes/cut-state.md#testing): the user's case (TG #442) of
// plan 2 cut for real, then a pocket in its pocket's floor, a chamfer on its rim and a hole: the
// continuing plan exports only the new operations, the new pocket starts at the cut floor, and the
// height map oracle finds no air pass over the cut pocket and the same finished part as one plan
// of everything. Plus the marks (setup, plan, roughing, locks, statuses, clear restores the
// program), `plan.cutSetupOrder`, `plan.zRefGone` and `plan.cutChanged` with "cut it again".
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { Move, Toolpath, ToolpathTool } from '../toolpath/model'
import { parseGcode } from '../toolpath/testing/gcode'
import { Heightmap, samples, steps } from '../toolpath/testing/oracles'
import { heightDifference } from '../toolpath/testing/region-coverage'
import { cuttingLevels } from '../toolpath/testing/rules'
import type { PlanWarning } from './checks'
import type { PlanDTO } from './plan.dto'
import { flat6, planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()

const BLOCK = {
  name: 'Block',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}
const SIZE = { length: 80, width: 50 }
/** Pocket 1 (the user's "Pocket 2"): 40 × 30 R3, 6 deep under the faced top (Z −0.5). */
const POCKET = { x0: 20, x1: 60, y0: 10, y1: 40, floor: -6.5 }

const chamferMill = () => ({
  name: 'Chamfer 6',
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
})

const all = (p: PlanDTO) => p.setups.flatMap((s) => s.operations)
const opOf = (p: PlanDTO, design: string) =>
  all(p).find((o) => o.designOperationIds.includes(design))!

async function setup() {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: BLOCK })
  await s.run('library.tool.add', { values: libraryInput(chamferMill()) })
  await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId: s.partId,
    on: 'facing1.floor',
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '40',
      width: '30',
      cornerRadius: '3',
    },
    depth: '6',
  })
  await s.run('project.apply', {})
  return { s, svc }
}

/** The design's new work on the cut part: a pocket in the floor, the rim chamfer, a hole. */
async function newWork(s: PlanSetup) {
  await s.run('design.pocket.add', {
    partId: s.partId,
    on: 'pocket1.floor',
    shape: {
      kind: 'rectangle',
      center: ['35', '25'],
      length: '20',
      width: '10',
      cornerRadius: '3',
    },
    depth: '3',
  })
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: '1' })
  await s.run('design.drilling.add', {
    partId: s.partId,
    on: 'pocket1.floor',
    center: ['52', '25'],
    diameter: '6',
  })
  await s.run('project.apply', {})
}

/** Feeds for the drill (no calculator data). */
async function drillFeeds(s: PlanSetup, planId: string) {
  await s.run('plan.operation.update', {
    planId,
    planOperationId: opOf(s.plan(planId), 'drill1').id,
    overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
  })
}

const errorsOf = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
    (w) => w.severity === 'error',
  )

/**
 * A program's moves per tool in stock coordinates (Z0 = the raw top): each tool's Z0 is on its
 * Z reference surface ("Z0 for tool 1: Facing 1 floor, 0.50 below the stock top"), so its moves
 * shift down by that much.
 */
function programCuts(text: string): { tool: ToolpathTool; tp: Toolpath }[] {
  const below = new Map<string, number>()
  for (const m of text.matchAll(/^\(Z0 for tool (\d+): .*?([\d.]+) below the stock top\)$/gm))
    below.set(`T${m[1]}`, Number(m[2]))
  return parseGcode(text).map((p) => {
    const dz = below.get(p.tool.id) ?? 0
    // parsed programs hold rapids, lines and arcs only
    const shift = (m: Move): Move =>
      m.kind === 'drill' ? m : { ...m, to: [m.to[0], m.to[1], m.to[2] - dz] }
    return {
      tool: p.tool,
      tp: {
        ...p.toolpath,
        passes: p.toolpath.passes.map((x) => ({ ...x, moves: x.moves.map(shift) })),
      },
    }
  })
}

/**
 * Horizontal feed length (mm) of `program` that cuts nothing over the cut pocket above its floor
 * (inside it by more than the largest tool radius: the rim chamfer works at the wall), after
 * `before` was cut: the air passes the user does not want.
 */
function airOverPocket(before: string, program: string): number {
  const hm = new Heightmap(SIZE.length, SIZE.width, 0.1)
  for (const p of programCuts(before)) hm.sweep(p.tool, p.tp, 0.1)
  let air = 0
  const inside = (x: number, y: number) =>
    x > POCKET.x0 + 3.5 && x < POCKET.x1 - 3.5 && y > POCKET.y0 + 3.5 && y < POCKET.y1 - 3.5
  for (const p of programCuts(program)) {
    const slim = { ...p.tool, diameter: p.tool.diameter - 0.04 }
    for (const st of steps(p.tp)) {
      if (st.move.kind === 'rapid') continue
      const pts = samples(st, 0.1)
      let most = 0
      for (const q of pts) {
        most = Math.max(most, hm.probe(slim, q))
        hm.stamp(p.tool, q)
      }
      const a = pts[0]!
      const b = pts.at(-1)!
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      const over =
        inside(a[0], a[1]) && inside(b[0], b[1]) && Math.min(a[2], b[2]) > POCKET.floor + 0.01
      if (length > 1e-6 && over && most <= 0.02) {
        air += length
      }
    }
  }
  return air
}

/** Marks design items already cut (replaces the list) and applies, as Design does. */
async function alreadyCut(s: PlanSetup, ids: string[]) {
  await s.run('design.part.update', { partId: s.partId, alreadyCut: ids })
  await s.run('project.apply', {})
}

describe('cut state C1: the user case (TG #442, TG #447)', () => {
  it('Pocket 2 already cut in Design: only the new pocket, chamfer and hole, no air over it', async () => {
    const { s, svc } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    expect(s.plan(planId).status).toBe('draft')
    expect(errorsOf(s, planId)).toEqual([])
    // plan 2 was cut for real
    const before = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    // Design: the facing and the pocket are already cut in the stock
    await alreadyCut(s, ['facing1', 'pocket1'])
    expect(s.d.doc.parts[s.partId]!.alreadyCut).toEqual(['facing1', 'pocket1'])
    // the whole setup is cut: no program ("Top is cut")
    const none = expectErrCode(await exportPlan(s.d.doc, planId, svc as never), 'plan.check')
    expect(none.issues.map((i) => i.rule)).toEqual(['allCut'])

    // then in Design the new work; the draft plan follows
    await newWork(s)
    await drillFeeds(s, planId)
    const plan = s.plan(planId)
    expect(plan.setups).toHaveLength(1)
    const order = plan.setups[0]!.operations.map((o) => o.designOperationIds.join('+'))
    // the cut operations first, in their order; the new work after them
    expect(order.slice(0, 2)).toEqual(['facing1', 'pocket1'])
    expect(new Set(order.slice(2))).toEqual(new Set(['pocket2', 'chamfer1', 'drill1']))
    expect(errorsOf(s, planId)).toEqual([])

    const after = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    // only the new operations are in the program
    const exported = after.operationLines.map((l) => l.planOperationId)
    expect(exported).toEqual(plan.setups[0]!.operations.slice(2).map((o) => o.id))
    expect(after.text).not.toContain('(Facing 1)')
    expect(after.text).not.toContain('(Pocket 1)')
    // no tool run of cut operations alone
    const toolLines = after.lines.filter((l) => /^\(Tool \d+:/.test(l))
    expect(toolLines.length).toBeLessThanOrEqual(3)
    // the new pocket starts at the cut floor
    const pocket2 = (
      s.query('plan.toolpath.get', {
        planId,
        planOperationId: opOf(plan, 'pocket2').id,
      }) as { toolpath: Toolpath }
    ).toolpath
    const levels = cuttingLevels(pocket2)
    expect(levels[0]!).toBeLessThan(POCKET.floor - 1e-6)
    expect(levels.at(-1)!).toBeCloseTo(POCKET.floor - 3, 6)

    // the oracle: after plan 2's program, no air pass over the cut pocket
    expect(airOverPocket(before.text, after.text)).toBeLessThan(1)
    // ... where the same work with nothing marked re-cuts the pocket in the air
    await alreadyCut(s, [])
    const whole = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    expect(airOverPocket(before.text, whole.text)).toBeGreaterThan(100)
    // the finished part equals one program of everything (no material left, no overcut)
    expect(
      heightDifference(
        SIZE,
        [...programCuts(before.text), ...programCuts(after.text)],
        programCuts(whole.text),
      ),
    ).toBeLessThan(1)
  }, 120_000)
})

describe('cut state C1: marks', () => {
  it('locks already-cut plan operations; clearing the mark restores the program', async () => {
    const { s, svc } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const original = expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
    const facing = opOf(s.plan(planId), 'facing1').id
    const pocket = opOf(s.plan(planId), 'pocket1').id
    await alreadyCut(s, ['facing1'])
    const partly = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    expect(partly.operationLines.map((l) => l.planOperationId)).toEqual([pocket])
    // locked: tool, feeds, order
    for (const [name, args] of [
      ['plan.operation.update', { planOperationId: facing, overrides: { feedRate: '500' } }],
      ['plan.tool.assign', { planOperationId: facing, toolLibraryItemId: s.tools.flat4 }],
      ['plan.operation.move', { planOperationId: facing, toIndex: 1 }],
      ['plan.operation.move', { planOperationId: pocket, toIndex: 0 }],
    ] as const) {
      const e = await s.failWith(name, { planId, ...args }, 'plan.status')
      expect(e.issues[0]).toMatchObject({ rule: 'cut' })
      expect(e.message).toContain('Facing 1 is already cut')
    }
    // Q198: editing an already-cut operation re-describes the stock, no finding
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '0.6' })
    await s.run('project.apply', {})
    expect(errorsOf(s, planId)).toEqual([])
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '0.5' })
    await alreadyCut(s, [])
    expect(expectOk(await exportPlan(s.d.doc, planId, svc as never)).text).toBe(original)
  })

  it('checks the list: unknown ids are refused, removed items leave it', async () => {
    const { s } = await setup()
    await s.failWith(
      'design.part.update',
      { partId: s.partId, alreadyCut: ['nope'] },
      'input.malformed',
    )
    await alreadyCut(s, ['pocket1', 'facing1'])
    // design order
    expect(s.d.doc.parts[s.partId]!.alreadyCut).toEqual(['facing1', 'pocket1'])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'pocket1' })
    expect(s.d.doc.parts[s.partId]!.alreadyCut).toEqual(['facing1'])
  })

  it('a roughing pass is cut with its owner', async () => {
    const { s, svc } = await setup()
    await s.run('library.tool.add', {
      values: libraryInput({ ...flat6(), name: 'Flat 10', diameter: len('10') }),
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'facing1.floor',
      shape: { kind: 'circle', center: ['70', '40'], diameter: '14' },
      depth: '3',
      roughing: true,
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const rough = opOf(s.plan(planId), 'pocket2_roughing')
    expect(rough).toBeDefined()
    await alreadyCut(s, ['pocket2'])
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opOf(s.plan(planId), 'pocket1').id,
      overrides: { feedRate: '600' },
    })
    const e = await s.failWith(
      'plan.operation.update',
      { planId, planOperationId: rough.id, overrides: { feedRate: '600' } },
      'plan.status',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'cut' })
    const out = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    expect(out.operationLines.map((l) => l.planOperationId)).not.toContain(rough.id)
  })

  it('plan.cutSetupOrder: new bottom work after a cut top goes into a new setup at the end', async () => {
    const { s } = await setup()
    await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const names = () => s.plan(planId).setups.map((x) => x.name)
    expect(names()).toEqual(['Bottom', 'Top'])
    const orderFindings = () =>
      (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
        (w) => w.code === 'plan.cutSetupOrder',
      )
    // only the top is cut: the bottom's facing would need the part flipped back
    await alreadyCut(s, ['facing1', 'pocket1'])
    expect(orderFindings()).toHaveLength(1)
    expect(orderFindings()[0]!.message).toContain('on Bottom is not cut, but Top is')
    // both cut, then a new bottom pocket: "Bottom 2" at the end
    await alreadyCut(s, ['facing1', 'pocket1', 'facing2'])
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'facing2.floor',
      shape: { kind: 'circle', center: ['40', '25'], diameter: '10' },
      depth: '2',
    })
    await s.run('project.apply', {})
    const setups = s.plan(planId).setups
    expect(setups.map((x) => x.name)).toEqual(['Bottom', 'Top', 'Bottom 2'])
    expect(setups[2]!.operations.map((o) => o.designOperationIds)).toEqual([['pocket2']])
    expect(orderFindings()).toEqual([])
  })

  it('plan.zRefGone: the raw top a cut facing removed is no Z reference', async () => {
    const { s } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await alreadyCut(s, ['facing1'])
    const pocket = opOf(s.plan(planId), 'pocket1').id
    // the pocket starts the program's first tool run now: by default on the faced top
    const zRefs = (
      s.query('plan.warning.list', { planId }) as {
        zRefs: { planOperationId: string; zRef: { surface: string } | null }[]
      }
    ).zRefs
    expect(zRefs.map((r) => [r.planOperationId, r.zRef?.surface])).toEqual([
      [pocket, 'facing1.floor'],
    ])
    await s.run('plan.operation.update', {
      planId,
      planOperationId: pocket,
      zRef: { surface: 'stock.top' },
    })
    const gone = errorsOf(s, planId).filter((w) => w.code === 'plan.zRefGone')
    expect(gone.map((w) => [w.planOperationId, w.rule])).toEqual([[pocket, 'zRefGone']])
  })

  it('every plan sees the mark: a settled plan goes stale, a new one starts with it', async () => {
    const { s, svc } = await setup()
    const first = await s.create({ machineLibraryItemId: s.machineId })
    await s.toStatus(first, 'settledDesign')
    await alreadyCut(s, ['pocket1'])
    // a snapshot: the settled plan keeps cutting the pocket until rebuilt
    expect(expectOk(await exportPlan(s.d.doc, first, svc as never)).operationLines).toHaveLength(2)
    const second = await s.create({ machineLibraryItemId: s.machineId })
    expect(
      expectOk(await exportPlan(s.d.doc, second, svc as never)).operationLines.map(
        (l) => l.planOperationId,
      ),
    ).toEqual([opOf(s.plan(second), 'facing1').id])
  })
})
