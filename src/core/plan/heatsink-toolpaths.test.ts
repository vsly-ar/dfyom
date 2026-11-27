// Heatsink presets H1 exit, headless (docs/modes/pattern-presets.md#implementation-h1): the user's
// straight-fin heatsink (40 × 40 × 14 mm aluminium, fins 1.5, slots 2, Ø 2 flat end mill with
// 12 mm flutes, 10 deep, wall 1.5) filled by the Straight fins step's args through the real
// commands: 11 slots, 12 fins, open ends, removed volume 8 800 mm³, every slot cut once per level
// along its centre line (the slot rule), exported for GRBL (a golden) and streamed through the
// virtual machine; a Ø 2 with 6 mm flutes gives `shankRub`, 1 mm fins `dfm.patternTallWeb`.
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { straightFins, straightFinsArgs } from '../design/pattern/heatsink'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { feed, len, libraryInput, num, rpm } from '../library/library.fixture'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

const BLOCK = {
  name: 'Heatsink block',
  shape: 'block' as const,
  length: '40',
  width: '40',
  thickness: '14',
  material: { name: '6061-T6', class: 'aluminum' as const },
}

/** A Ø 2 flat end mill, 2 flutes; `flutes` its flute length. */
const flat2 = (flutes: string) => ({
  name: `Flat 2 × ${flutes}`,
  type: 'flatEndMill' as const,
  diameter: len('2'),
  fluteLength: len(flutes),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  // DF131: no calculator data at ≤ 3 mm in metal; a preset at the metal stepdown (0.08 × D)
  presets: [
    {
      name: 'Alu slot',
      materialClass: 'aluminum' as const,
      spindleSpeed: rpm('18000'),
      feedRate: feed('400'),
      plungeRate: feed('100'),
      stepdown: len('0.16'),
      stepover: len('0.8'),
    },
  ],
})

const STEP = { fin: 1.5, slot: 2, height: 10, wall: 1.5, across: 40, along: 40, thickness: 14 }

async function heatsink(opts: { flutes?: string; fin?: number } = {}) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: BLOCK })
  const { id: toolId } = (await s.run('library.tool.add', {
    values: libraryInput(flat2(opts.flutes ?? '12')),
  })) as { id: string }
  await s.run('design.pattern.add', { partId: s.partId, name: 'Heatsink' })
  const step = { ...STEP, fin: opts.fin ?? STEP.fin }
  const layout = straightFins(step)!
  // the dialog's Apply: one update with the step's args, then the chosen tool (one gesture)
  const out = (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...straightFinsArgs(step, layout),
  })) as { cells: number; warnings: { code: string; severity: string; params?: object }[] }
  await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: 'pattern1_pocket',
    tool: { kind: 'specific', toolLibraryItemId: toolId },
  })
  await s.run('project.apply', {})
  // the part's findings with the tool set (the slot rule leaves no rest material)
  const after = (
    s.query('design.warning.list', { partId: s.partId }) as {
      warnings: { code: string; severity: string; params?: object }[]
    }
  ).warnings
  return { s, svc, out, layout, after }
}

describe('heatsink presets H1 exit', () => {
  it("the user's straight fins: 11 slots, open ends, 8 800 mm³, one pass per level, golden, machine", async () => {
    const { s, svc, out, layout, after } = await heatsink()
    expect(after).toEqual([])
    expect(layout).toMatchObject({ slots: 11, fins: 12, wall: 1.5, ratio: 6.7, base: 4 })
    expect(out.cells).toBe(11)
    expect(out.warnings.filter((w) => w.severity === 'warning')).toEqual([])

    // removed volume 11 × 2 × 40 × 10 = 8 800 mm³; the slots run out of both ends
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    for (const p of pocket.shape.contour.region.pieces) {
      const ys = p.outer.elements.map((e) => e.a[1])
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 9)
    }
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    expect(Math.abs(40 * 40 * 14 - solid.volume - 8800) / 8800).toBeLessThan(0.002)

    // planned with no error; every slot cut once per level along its centre line
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
      .warnings
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('pattern1_pocket'))!
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
    ).toolpath
    // no finishing ring; down to the 10 mm floor in levels of the preset's 0.16 mm (63 levels)
    expect(tp.passes.map((p) => p.kind)).not.toContain('finish')
    const moves = tp.passes.flatMap((p) => p.moves).flatMap((m) => (m.kind === 'drill' ? [] : [m]))
    const zs = moves.map((m) => m.to[2])
    expect(Math.min(...zs)).toBeCloseTo(-10, 9)
    // every feed below the top lies on a slot's centre line
    const centres = Array.from({ length: 11 }, (_, i) => 2.5 + i * 3.5)
    const slotOf = (x: number) => centres.findIndex((c) => Math.abs(x - c) < 1e-6)
    for (const m of moves)
      if (m.kind === 'line' && m.to[2] < -1e-9) expect(slotOf(m.to[0])).not.toBe(-1)
    // each slot once per level, from an open end past the stock to the other (no ramp)
    const past = Math.SQRT1_2 + 0.2 + 0.001
    const passes = new Map<string, number>()
    let prev = moves[0]!.to
    for (const m of moves) {
      if (m.kind === 'line' && m.to[2] < -1e-9 && Math.abs(m.to[1] - prev[1]) > 1) {
        expect(m.to[2]).toBeCloseTo(prev[2], 9)
        expect(Math.abs(m.to[1] - prev[1])).toBeCloseTo(40 + 2 * past, 3)
        const k = `${slotOf(m.to[0])}@${m.to[2].toFixed(4)}`
        passes.set(k, (passes.get(k) ?? 0) + 1)
      }
      prev = m.to
    }
    expect(passes.size).toBe(11 * 63)
    expect([...passes.values()].every((n) => n === 1)).toBe(true)
    // the plan's time (recorded in pattern-presets.md § Implementation (H1)): ≈ 87 min, 29.4 m
    expect(tp.stats.cutLength).toBeGreaterThan(11 * 63 * 40)
    expect(tp.stats.cutLength).toBeLessThan(11 * 63 * (40 + 2 * past + 2 * 0.66) + 1)

    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/heatsink-straight-fins.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
  it('a Ø 2 with 6 mm flutes rubs its shank (shankRub); 1 mm fins are tall (dfm.patternTallWeb)', async () => {
    const short = await heatsink({ flutes: '6' })
    const planId = await short.s.create({ machineLibraryItemId: short.s.machineId })
    const rules = (
      short.s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.map((w) => (w as { rule?: string }).rule)
    expect(rules).toContain('shankRub')

    const thin = await heatsink({ fin: 1 })
    expect(thin.layout).toMatchObject({ slots: 12, fins: 13, wall: 2.5, ratio: 10 })
    const tall = thin.out.warnings.find((w) => w.code === 'dfm.patternTallWeb')
    expect(tall?.params).toMatchObject({ web: 1, depth: 10, ratio: 10, limit: 8, island: false })
    expect(tall?.params).toMatchObject({ suggestedDepth: 8, gap: 1.25 })
  })
})
