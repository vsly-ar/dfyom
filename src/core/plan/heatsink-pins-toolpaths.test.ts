// Heatsink presets H2 exit, headless (docs/modes/pattern-presets.md#implementation-h2): pin fins on
// a 40 × 40 × 14 mm aluminium block filled by the pin steps' args through the real commands.
// Square pins 3 × 3, channel 2.5 (Ø 2 flat end mill, 12 mm flutes), 8 deep: 7 × 7 = 49 pins with
// a 2 mm open border, removed volume (1 600 − 49 × 9) × 8 = 9 272 mm³, every pin finished, no rest
// material, no plan error; exported for GRBL (a golden) and streamed through the virtual machine;
// the Q208 hint on the 3 mm pins with its 8 mm finishing level. The round and staggered variants
// plan with no error. `dfm.patternTallWeb` on 1.2 mm pins 10 high.
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { pinFins, pinFinsArgs, type PinKind } from '../design/pattern/heatsink'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { feed, len, libraryInput, num, rpm } from '../library/library.fixture'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Move, Toolpath } from '../toolpath/model'
import { endMill } from '../toolpath/testing/fixtures'
import { Heightmap } from '../toolpath/testing/oracles'
import { airCut, rapidClearance, type RapidMargins } from '../toolpath/testing/region-coverage'
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

/** A Ø 2 flat end mill, 2 flutes, 12 mm of flute, with a DF131 aluminium preset. */
const FLAT2 = {
  name: 'Flat 2 × 12',
  type: 'flatEndMill' as const,
  diameter: len('2'),
  fluteLength: len('12'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
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
}

/** The pocket's margins (DF136): entries 0.5 over the level above, links 2 + 1 radial. */
const MARGINS: RapidMargins = { retractZ: 2, vertical: 0.5, horizontal: 2, radial: 1 }
const D2 = endMill(2, 12)
/** Plunge entries into uncut material at a 2 mm stepdown: 48 leaves a level × 4 (before DF136 too). */
const PLUNGES = 192

/** A toolpath moved by (dx, dy): the heightmap oracles start at (0, 0). */
function shifted(tp: Toolpath, dx: number, dy: number): Toolpath {
  const move = (m: Move): Move => {
    if (m.kind === 'drill') return { ...m, at: [m.at[0] + dx, m.at[1] + dy] }
    const to: [number, number, number] = [m.to[0] + dx, m.to[1] + dy, m.to[2]]
    return m.kind === 'arc'
      ? { ...m, to, center: [m.center[0] + dx, m.center[1] + dy] }
      : { ...m, to }
  }
  return { ...tp, passes: tp.passes.map((p) => ({ ...p, moves: p.moves.map(move) })) }
}

const svcs = () => ({
  region2d,
  toolpaths: createToolpathCache(),
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
})

async function pins(
  kind: PinKind,
  opts: { pin?: number; height?: number; stepdown?: string } = {},
) {
  const svc = svcs()
  const s = await planSetup({ part: false, services: svc, stock: BLOCK })
  const tool = {
    ...FLAT2,
    presets: FLAT2.presets.map((p) => ({ ...p, stepdown: len(opts.stepdown ?? '0.16') })),
  }
  const { id: toolId } = (await s.run('library.tool.add', {
    values: libraryInput(tool),
  })) as { id: string }
  await s.run('design.pattern.add', { partId: s.partId, name: 'Pin fins' })
  const step = {
    kind,
    pin: opts.pin ?? 3,
    channel: 2.5,
    height: opts.height ?? 8,
    across: 40,
    along: 40,
    thickness: 14,
  }
  const layout = pinFins(step)!
  // the dialog's Apply: one update with the step's args, then the chosen tool (one gesture)
  const out = (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...pinFinsArgs(step, layout),
  })) as { cells: number; warnings: { code: string; severity: string; params?: object }[] }
  await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: 'pattern1_pocket',
    tool: { kind: 'specific', toolLibraryItemId: toolId },
  })
  await s.run('project.apply', {})
  const after = (
    s.query('design.warning.list', { partId: s.partId }) as {
      warnings: { code: string; severity: string; params?: object }[]
    }
  ).warnings
  return { s, svc, out, layout, after }
}

async function toolpathOf(s: Awaited<ReturnType<typeof pins>>['s']) {
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('pattern1_pocket'))!
  const tp = (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
  ).toolpath
  return { planId, warnings, tp, op }
}

describe('heatsink presets H2 exit', () => {
  // heavy: a 47 000-line program streamed through the virtual machine and swept on a heightmap
  // (≈ 5 s idle)
  it(
    'square pins: 7 × 7 = 49, border 2, 9 272 mm³, every pin finished, machine',
    { timeout: 60_000 },
    async () => {
      const { s, svc, out, layout, after } = await pins('square')
      expect(layout).toMatchObject({ pins: 49, grid: [7, 7], border: 2, ratio: 2.7, base: 6 })
      expect(layout.origin).toBeUndefined()
      expect(out.cells).toBe(49)
      expect(after).toEqual([])

      // removed volume (1 600 − 49 × 9) × 8 = 9 272 mm³
      const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
      const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
      expect(Math.abs(40 * 40 * 14 - solid.volume - 9272) / 9272).toBeLessThan(0.002)

      const { planId, warnings, tp } = await toolpathOf(s)
      expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
      expect(warnings.filter((w) => w.code === 'plan.restMaterial')).toEqual([])
      // Q208: 3 mm pins finished in one 8 mm level: the hint, at Finish stepdown
      const hint = warnings.find((w) => w.code === 'plan.thinWallFinish')
      expect(hint).toMatchObject({ severity: 'info', field: 'strategy.finishStepdown' })
      expect(hint?.params).toMatchObject({ web: 3, finishStepdown: 8, suggested: 3 })

      // down to the 8 mm floor; a finishing ring round every pin
      const moves = tp.passes
        .flatMap((p) => p.moves)
        .flatMap((m) => (m.kind === 'drill' ? [] : [m]))
      expect(Math.min(...moves.map((m) => m.to[2]))).toBeCloseTo(-8, 9)
      const finish = tp.passes.filter((p) => p.kind === 'finish').flatMap((p) => p.moves)
      const centres = Array.from({ length: 7 }, (_, i) => 3.5 + i * 5.5)
      for (const u of centres)
        for (const v of centres) {
          // the tool centre runs round the pin at R from its sides
          const near = finish.filter(
            (m) =>
              m.kind !== 'drill' &&
              Math.abs(m.to[0] - u) <= 1.5 + 1 + 1e-6 &&
              Math.abs(m.to[1] - v) <= 1.5 + 1 + 1e-6 &&
              Math.max(Math.abs(m.to[0] - u), Math.abs(m.to[1] - v)) >= 1.5 + 1 - 1e-6,
          )
          expect(near.length, `pin at ${u}, ${v}`).toBeGreaterThanOrEqual(4)
        }

      const e = expectOk(await exportPlan(s.d.doc, planId, svc))
      const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      // the plan's time (recorded in pattern-presets.md § Implementation (H2)): ≈ 264 min, 79 m of
      // cut; 453 min and 100 m before DF136's low entries (every helix fed down from the retract plane)
      expect(tp.stats.estimatedSeconds / 60).toBeGreaterThan(240)
      expect(tp.stats.estimatedSeconds / 60).toBeLessThan(290)
      expect(tp.stats.cutLength).toBeGreaterThan(75_000)
      expect(tp.stats.cutLength).toBeLessThan(84_000)

      // DF136 safety on a heightmap of the 40 × 40 block (0.2 mm cells, its (0, 0) 5 mm out so the
      // open border fits): no rapid into material, every low entry ≥ 0.5 mm over the level above,
      // no gouge into a pin, nothing below the floor
      const hm = new Heightmap(50, 50, 0.2)
      expect(rapidClearance(tp, D2, hm, MARGINS, { origin: [-5, -5], heightmap: hm })).toEqual([])
      let gouge = 0
      let below = 0
      for (let j = 0; j < hm.ny; j++)
        for (let i = 0; i < hm.nx; i++) {
          const [x, y] = hm.center(i, j)
          const z = hm.z[j * hm.nx + i]!
          if (z < -8 - 1e-9) below++
          // a pin: 3 × 3 at 3.5 + 5.5 k (+ 5), less 0.02 mm (the cells along its sides)
          const pin =
            centres.some((u) => Math.abs(x - 5 - u) < 1.48) &&
            centres.some((v) => Math.abs(y - 5 - v) < 1.48)
          if (pin && z < -0.02) gouge++
        }
      expect(below).toBe(0)
      expect(gouge).toBe(0)
    },
  )

  it('golden: the same square pins at a 2 mm stepdown (4 levels keep the file small)', async () => {
    const { s, svc } = await pins('square', { stepdown: '2' })
    const { planId, warnings, tp } = await toolpathOf(s)
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    // DF136: plunges into uncut material are only the leaves too small for a helix or a ramp
    // (one level each), as many as before the low entries (0.1 mm cells, moved by 5 mm)
    expect(airCut(shifted(tp, 5, 5), D2, { length: 50, width: 50 }, [], 0.1).plunges).toBe(PLUNGES)
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/heatsink-pins-square.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })

  it('round and staggered pins plan with no error and no rest material', async () => {
    for (const [kind, count] of [
      ['round', 49],
      ['staggered', 46],
    ] as const) {
      // a coarser stepdown keeps the test quick; the levels do not change the layout
      const { s, layout, after, out } = await pins(kind, { stepdown: '2' })
      expect(layout.pins, kind).toBe(count)
      expect(out.cells, kind).toBe(count)
      expect(after, kind).toEqual([])
      const { warnings, tp } = await toolpathOf(s)
      expect(
        warnings.filter((w) => w.severity === 'error' || w.code === 'plan.restMaterial'),
        kind,
      ).toEqual([])
      expect(
        tp.passes.some((p) => p.kind === 'finish'),
        kind,
      ).toBe(true)
    }
  })

  it('1.2 mm pins 10 high are tall (dfm.patternTallWeb at Cell)', async () => {
    const { out } = await pins('square', { pin: 1.2, height: 10, stepdown: '2' })
    const tall = out.warnings.find((w) => w.code === 'dfm.patternTallWeb')
    expect(tall).toMatchObject({ severity: 'warning' })
    expect(tall?.params).toMatchObject({ web: 1.2, depth: 10, ratio: 8.3, island: true })
    expect(tall?.params).toMatchObject({ suggestedDepth: 9.6, gap: 1.25 })
  })
})
