// Cut state C4 (hardening DF135): an operation a run marked already cut and that was edited since
// (`plan.cutChanged`) is cut again for the difference only – its as-cut version is a hidden earlier
// removal. Heightmap oracle: plan 2's program, then the new one, against one program of the edited
// design from the raw stock: nothing cut that the design keeps (gouge), nothing left over, no
// rapid into material, no feed pass over the old pocket above its floor beyond links.
// Doc: docs/modes/cut-state.md#cutting-only-the-difference-c4
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { finishedUnits, runMarkUpdate } from '../run/cut-marks'
import { createToolpathCache } from '../toolpath/cache'
import type { Move, Toolpath, ToolpathTool } from '../toolpath/model'
import { parseGcode } from '../toolpath/testing/gcode'
import { Heightmap, samples, steps } from '../toolpath/testing/oracles'
import { cuttingLevels } from '../toolpath/testing/rules'
import { cutChangedUnits, recutUnits } from '../design/already-cut'
import type { PlanWarning } from './checks'
import { cutTest } from './cut'
import type { PlanDTO } from './plan.dto'
import { planSetup, type PlanSetup } from './plan.fixture'

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
/** Pocket 1 as the run cut it: 40 × 30 R3, 6 deep under the faced top (Z −0.5). */
const POCKET = { x0: 20, x1: 60, y0: 10, y1: 40, floor: -6.5 }

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

/** A program's moves per tool in stock coordinates (Z0 = the raw top, see cut-state.test.ts). */
function programCuts(text: string): { tool: ToolpathTool; tp: Toolpath }[] {
  const below = new Map<string, number>()
  for (const m of text.matchAll(/^\(Z0 for tool (\d+): .*?([\d.]+) below the stock top\)$/gm))
    below.set(`T${m[1]}`, Number(m[2]))
  return parseGcode(text).map((p) => {
    const dz = below.get(p.tool.id) ?? 0
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

interface Oracle {
  /** Area (mm²) cut deeper than the one-program reference (gouge). */
  readonly gouge: number
  /** Area (mm²) left higher than the reference (material left over). */
  readonly left: number
  /** Rapid moves that would remove material. */
  readonly rapidsInMaterial: number
  /** Horizontal feed length (mm) over the old pocket's inside, at or above its floor, removing nothing. */
  readonly airOverOld: number
}

/** `before` then `after` against `reference` (one program of the edited design, raw stock). */
function oracle(before: string, after: string, reference: string, inset = 3.5): Oracle {
  const cell = 0.1
  const hm = new Heightmap(SIZE.length, SIZE.width, cell)
  for (const p of programCuts(before)) hm.sweep(p.tool, p.tp, cell)
  const inside = (x: number, y: number) =>
    x > POCKET.x0 + inset && x < POCKET.x1 - inset && y > POCKET.y0 + inset && y < POCKET.y1 - inset
  let rapidsInMaterial = 0
  let airOverOld = 0
  for (const p of programCuts(after)) {
    const slim = { ...p.tool, diameter: p.tool.diameter - 0.04 }
    for (const st of steps(p.tp)) {
      const pts = samples(st, cell)
      if (st.move.kind === 'rapid') {
        if (pts.some((q) => hm.probe(slim, q) > 0.02)) rapidsInMaterial++
        continue
      }
      let most = 0
      for (const q of pts) {
        most = Math.max(most, hm.probe(slim, q))
        hm.stamp(p.tool, q)
      }
      const a = pts[0]!
      const b = pts.at(-1)!
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      const over =
        inside(a[0], a[1]) && inside(b[0], b[1]) && Math.min(a[2], b[2]) > POCKET.floor - 0.01
      if (length > 1e-6 && over && most <= 0.02) airOverOld += length
    }
  }
  const ref = new Heightmap(SIZE.length, SIZE.width, cell)
  for (const p of programCuts(reference)) ref.sweep(p.tool, p.tp, cell)
  let gouge = 0
  let left = 0
  for (let i = 0; i < hm.z.length; i++) {
    if (hm.z[i]! < ref.z[i]! - 0.02) gouge++
    if (hm.z[i]! > ref.z[i]! + 0.02) left++
  }
  return { gouge: gouge * cell * cell, left: left * cell * cell, rapidsInMaterial, airOverOld }
}

const cutChanged = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
    (w) => w.code === 'plan.cutChanged',
  )

/** Plan 2 cut by a real run to the end: the run marks the facing and the pocket (C2). */
async function runMarks(s: PlanSetup, planId: string, ids = ['facing1', 'pocket1']) {
  await s.run('design.part.update', { partId: s.partId, alreadyCut: ids, cutByRun: planId })
  await s.run('project.apply', {})
}

/** One program of the edited design from the raw stock, nothing marked (the oracle's reference). */
async function reference(edit: (s: PlanSetup) => Promise<void>): Promise<string> {
  const { s, svc } = await setup()
  await edit(s)
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  return expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
}

const deepen = (depth: string) => async (s: PlanSetup) => {
  await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth })
}

const enlarge = async (s: PlanSetup) => {
  await s.run('design.pocket.update', {
    partId: s.partId,
    operationId: 'pocket1',
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '50',
      width: '40',
      cornerRadius: '3',
    },
  })
}

describe('cut state C4: cut only the difference', () => {
  it('Pocket 1 deepened 6 → 8 mm after the run: the program cuts only 6–8 mm', async () => {
    const { s, svc } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const before = expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
    await runMarks(s, planId)
    await deepen('8')(s)
    await s.run('project.apply', {})
    const plan = s.plan(planId)
    const pocket = opOf(plan, 'pocket1').id
    expect(cutChanged(s, planId)).toMatchObject([
      {
        planOperationId: pocket,
        message: expect.stringMatching(
          /changed since the run cut it: the plan cuts only the difference$/,
        ),
      },
    ])
    const after = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    // the pocket is in the program again, the facing is not
    expect(after.operationLines.map((l) => l.planOperationId)).toEqual([pocket])
    expect(after.text).not.toContain('(Facing 1)')
    // the Z touch-off is on Facing 1's floor where it still exists: not in the old pocket
    const spot = /\(Touch off Z here, X([\d.]+) Y([\d.]+)/.exec(after.text)!
    const [x, y] = [Number(spot[1]), Number(spot[2])]
    expect(x > POCKET.x0 - 3 && x < POCKET.x1 + 3 && y > POCKET.y0 - 3 && y < POCKET.y1 + 3).toBe(
      false,
    )
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: pocket }) as {
        toolpath: Toolpath
      }
    ).toolpath
    const levels = cuttingLevels(tp)
    expect(levels[0]!).toBeLessThan(POCKET.floor - 1e-6)
    expect(levels.at(-1)!).toBeCloseTo(POCKET.floor - 2, 6)
    const ref = await reference(deepen('8'))
    const o = oracle(before, after.text, ref)
    expect(o.gouge).toBe(0)
    expect(o.left).toBeLessThan(1)
    expect(o.rapidsInMaterial).toBe(0)
    expect(o.airOverOld).toBeLessThan(1)
    // the whole pocket again (nothing marked) re-cuts the old pocket in the air
    expect(oracle(before, ref, ref).airOverOld).toBeGreaterThan(100)
    // golden: the deepened pocket's program
    await expect(after.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/cut-deepened-pocket.nc',
    )
  }, 120_000)

  it('Pocket 1 enlarged by 5 mm per side: the added ring only, no floor pass over the old pocket', async () => {
    const { s, svc } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const before = expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
    await runMarks(s, planId)
    await enlarge(s)
    await s.run('project.apply', {})
    const after = expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
    const ref = await reference(enlarge)
    const o = oracle(before, after, ref)
    expect(o.gouge).toBe(0)
    expect(o.left).toBeLessThan(1)
    expect(o.rapidsInMaterial).toBe(0)
    // the tool works along the old wall at most: nothing deeper inside the old pocket
    expect(oracle(before, after, ref, 6.5).airOverOld).toBeLessThan(1)
    expect(oracle(before, ref, ref, 6.5).airOverOld).toBeGreaterThan(100)
  }, 120_000)

  it('a deepened blind hole starts its cycle at the depth the run drilled', async () => {
    const { s, svc } = await setup()
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'facing1.floor',
      center: ['10', '10'],
      diameter: '6',
      bottom: 'drillPoint',
      depth: '5',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const drill = () => opOf(s.plan(planId), 'drill1').id
    await s.run('plan.operation.update', {
      planId,
      planOperationId: drill(),
      overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
    })
    await runMarks(s, planId, ['facing1', 'pocket1', 'drill1'])
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill1',
      bottom: 'drillPoint',
      depth: '9',
    })
    await s.run('project.apply', {})
    const after = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    expect(after.operationLines.map((l) => l.planOperationId)).toEqual([drill()])
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: drill() }) as {
        toolpath: Toolpath
      }
    ).toolpath
    const cycle = tp.passes.flatMap((p) => p.moves).find((m) => m.kind === 'drill')
    // the old hole had its full Ø 5 mm under the faced top (Z −0.5)
    expect(cycle).toMatchObject({ kind: 'drill', top: -5.5 })
  }, 120_000)

  it('the next run cuts the difference and marks it anew; hand and pre-C4 marks are not recut', async () => {
    const { s, svc } = await setup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await runMarks(s, planId)
    await deepen('8')(s)
    await s.run('project.apply', {})
    const program = expectOk(await exportPlan(s.d.doc, planId, svc as never))
    expect(program.operationLines).toHaveLength(1)
    // the run of the difference finishes the pocket: Run marks it anew (recut)
    const live = () => s.d.doc.parts[s.partId]!
    const units = finishedUnits(s.plan(planId), [opOf(s.plan(planId), 'pocket1').id], live())
    expect(units).toEqual(['pocket1'])
    const update = runMarkUpdate(live(), units)
    expect(update).toEqual({ alreadyCut: ['facing1', 'pocket1'], recut: ['pocket1'] })
    await s.run('design.part.update', { partId: s.partId, ...update, cutByRun: planId })
    await s.run('project.apply', {})
    expect(cutChanged(s, planId)).toEqual([])
    expect(live().alreadyCutMarks?.['pocket1']?.asCut?.[0]).toMatchObject({ id: 'pocket1' })
    // everything is cut again: no program
    expect((await exportPlan(s.d.doc, planId, svc as never)).isErr()).toBe(true)

    // a pre-C4 run mark (fingerprint only) stays cut and warns as in C2
    await deepen('9')(s)
    await s.run('project.apply', {})
    const mark = live().alreadyCutMarks!['pocket1']!
    const legacy = {
      ...live(),
      alreadyCutMarks: {
        ...live().alreadyCutMarks,
        pocket1: { by: 'run' as const, at: mark.at, fingerprint: mark.fingerprint! },
      },
    }
    expect([...recutUnits(live())]).toEqual(['pocket1'])
    expect([...recutUnits(legacy)]).toEqual([])
    expect([...cutChangedUnits(legacy)]).toEqual(['pocket1'])
    expect(cutTest(legacy)(opOf(s.plan(planId), 'pocket1'))).toBe(true)
    expect(cutTest(live())(opOf(s.plan(planId), 'pocket1'))).toBe(false)
    // a hand mark re-describes the stock (Q198): nothing to cut
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['facing1'] })
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['facing1', 'pocket1'] })
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '10' })
    await s.run('project.apply', {})
    expect(cutChanged(s, planId)).toEqual([])
    expect((await exportPlan(s.d.doc, planId, svc as never)).isErr()).toBe(true)
  }, 120_000)
})
