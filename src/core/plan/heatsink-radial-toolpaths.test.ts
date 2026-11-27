// Heatsink presets H3 exit, headless (docs/modes/pattern-presets.md#implementation-h3): radial fins
// on a Ø 60 round part (an 80 × 80 × 12 aluminium plate, the part cut free by an outline profile)
// filled by the Radial fins step's args through the real commands. Hub Ø 24, slots 2 wide (a Ø 2
// flat end mill, 12 mm flutes), fins ≥ 1.5 mm at the hub, 8 deep: 21 slots from the step, fin(r)
// 1.59 mm at the hub, the web between the round inner ends 1.88 mm; every slot cut by the slot rule (once per level on its centre line, both ends
// closed: it runs one slot width past the rim, so the profile opens it); removed volume, no rest
// material, no plan error; exported for GRBL (a golden) and streamed through the virtual machine;
// the heightmap oracles (no rapid into material, no gouge into a fin, the slots open at the rim).
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { radialFins, radialFinsArgs, type RadialFinsStep } from '../design/pattern/heatsink'
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
import { endMill } from '../toolpath/testing/fixtures'
import { Heightmap } from '../toolpath/testing/oracles'
import { rapidClearance, type RapidMargins } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

const PLATE = {
  name: 'Round heatsink plate',
  shape: 'block' as const,
  length: '80',
  width: '80',
  thickness: '12',
  material: { name: '6061-T6', class: 'aluminum' as const },
}

const preset = (stepdown: string, stepover: string) => ({
  name: 'Alu',
  materialClass: 'aluminum' as const,
  spindleSpeed: rpm('18000'),
  feedRate: feed('400'),
  plungeRate: feed('100'),
  stepdown: len(stepdown),
  stepover: len(stepover),
})

/** The slot tool: Ø 2, 2 flutes, 12 mm of flute, a DF131 aluminium preset. */
const flat2 = (stepdown: string) => ({
  name: 'Flat 2 × 12',
  type: 'flatEndMill' as const,
  diameter: len('2'),
  fluteLength: len('12'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [preset(stepdown, '0.8')],
})

/** The profile's tool: Ø 6, 20 mm of flute. */
const flat6 = (stepdown: string) => ({
  name: 'Flat 6 × 20',
  type: 'flatEndMill' as const,
  diameter: len('6'),
  fluteLength: len('20'),
  overallLength: len('60'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [preset(stepdown, '2')],
})

/** The worked example's step: the Ø 60 part centred on the plate. */
const STEP: RadialFinsStep = {
  fin: 1.5,
  slot: 2,
  height: 8,
  hub: 24,
  outer: 60,
  centre: [40, 40],
  thickness: 12,
}

/** The pocket's margins (DF136): entries 0.5 over the level above, links 2 + 1 radial. */
const MARGINS: RapidMargins = { retractZ: 2, vertical: 0.5, horizontal: 2, radial: 1 }
const D2 = endMill(2, 12)

const svcs = () => ({
  region2d,
  toolpaths: createToolpathCache(),
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
})

/**
 * The plate: the radial fins (the step's args, the Ø 2 set as the dialog's Apply does), then the
 * Ø 60 outline profile (Ø 6, 4 tabs) that cuts the part free and opens the slots at the rim.
 */
async function radial(opts: { stepdown?: string; profile?: boolean } = {}) {
  const svc = svcs()
  const s = await planSetup({ part: false, services: svc, stock: PLATE })
  const stepdown = opts.stepdown ?? '0.16'
  const { id: toolId } = (await s.run('library.tool.add', {
    values: libraryInput(flat2(stepdown)),
  })) as { id: string }
  const { id: profileTool } = (await s.run('library.tool.add', {
    values: libraryInput(flat6(opts.stepdown ?? '1')),
  })) as { id: string }
  await s.run('design.pattern.add', { partId: s.partId, name: 'Radial fins' })
  const layout = radialFins(STEP)!
  const out = (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...radialFinsArgs(STEP, layout),
  })) as {
    cells: number
    narrowestWeb?: number
    warnings: { code: string; severity: string; params?: object }[]
  }
  await s.run('design.operation.tool.set', {
    partId: s.partId,
    operationId: 'pattern1_pocket',
    tool: { kind: 'specific', toolLibraryItemId: toolId },
  })
  if (opts.profile !== false) {
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['40', '40'], diameter: '60' },
      tabs: { count: '4', width: '6', thickness: '2' },
    })
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'profile1',
      tool: { kind: 'specific', toolLibraryItemId: profileTool },
    })
  }
  await s.run('project.apply', {})
  const after = (
    s.query('design.warning.list', { partId: s.partId }) as {
      warnings: { code: string; severity: string; params?: object }[]
    }
  ).warnings
  return { s, svc, out, layout, after }
}

async function plan(s: Awaited<ReturnType<typeof radial>>['s']) {
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  const toolpath = (designId: string) => {
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(designId))!
    return (
      s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
    ).toolpath
  }
  return { planId, warnings, tp: toolpath('pattern1_pocket'), toolpath }
}

describe('heatsink presets H3 exit', () => {
  // heavy: the 0.16 mm program streamed through the virtual machine and swept on a heightmap
  it(
    'Ø 60, hub Ø 24, slots 2: 21 slots by the slot rule, fin 1.59 at the hub, volume, machine',
    { timeout: 90_000 },
    async () => {
      const { s, svc, out, layout, after } = await radial()
      expect(layout).toMatchObject({ count: 21, hubFin: 1.59, web: 1.88, ratio: 5, base: 4 })
      expect(out.cells).toBe(21)
      // the web 1.88 mm (between the round inner ends): not thin, so no narrowest web
      expect(out.narrowestWeb).toBeUndefined()
      // only the generic 4:1 depth rule (closed 2 mm slots 8 deep; the tool's 12 mm of flute reach)
      expect(after.filter((w) => w.severity !== 'info').map((w) => w.code)).toEqual([
        'dfm.pocketDeepNarrow',
      ])

      // removed volume of the fins alone (no profile): 21 round-ended slots 20 × 2, 8 deep,
      // 21 × (36 + π) × 8 = 6 575.8 mm³
      const fins = (await radial({ profile: false, stepdown: '2' })).s
      const input = expectOk(partGeometryInput(fins.d.doc, fins.partId, region2d))
      const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
      const removed = 21 * (36 + Math.PI) * 8
      expect(Math.abs(80 * 80 * 12 - solid.volume - removed) / removed).toBeLessThan(0.002)

      const { planId, warnings, tp } = await plan(s)
      expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
      expect(warnings.filter((w) => w.code === 'plan.restMaterial')).toEqual([])
      // the slot rule: no finishing ring; each slot once per level along its centre line
      expect(tp.passes.filter((p) => p.kind === 'finish')).toEqual([])
      const moves = tp.passes
        .flatMap((p) => p.moves)
        .flatMap((m) => (m.kind === 'drill' ? [] : [m]))
      expect(Math.min(...moves.map((m) => m.to[2]))).toBeCloseTo(-8, 9)
      // every cutting move at or below the top runs on a slot's centre line, from r 13 to r 31
      const off: [number, number][] = []
      for (const m of moves) {
        if (m.kind === 'rapid' || m.to[2] > -1e-9) continue
        const [x, y] = [m.to[0] - 40, m.to[1] - 40]
        const r = Math.hypot(x, y)
        const k = Math.round(((Math.atan2(y, x) * 180) / Math.PI - 90) / (360 / 21))
        const t = ((90 + k * (360 / 21)) * Math.PI) / 180
        const across = Math.abs(-Math.sin(t) * x + Math.cos(t) * y)
        if (across > 1e-6 || r < 13 - 1e-6 || r > 31 + 1e-6) off.push([m.to[0], m.to[1]])
      }
      expect(off).toEqual([])

      const e = expectOk(await exportPlan(s.d.doc, planId, svc))
      const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      // the plan's time and cut length (pattern-presets.md § Implementation (H3): 82 min, 25.8 m)
      expect(tp.stats.estimatedSeconds / 60).toBeGreaterThan(70)
      expect(tp.stats.estimatedSeconds / 60).toBeLessThan(95)
      expect(tp.stats.cutLength).toBeCloseTo(25_841, -2)

      // on a heightmap of the plate (0.1 mm cells): no rapid into material, every low entry
      // ≥ 0.5 mm over the material, nothing below the floor, no gouge into a fin, and every slot
      // cut to its floor out to the rim
      const hm = new Heightmap(80, 80, 0.1)
      expect(rapidClearance(tp, D2, hm, MARGINS, { heightmap: hm })).toEqual([])
      let gouge = 0
      let below = 0
      let rimUncut = 0
      for (let j = 0; j < hm.ny; j++)
        for (let i = 0; i < hm.nx; i++) {
          const [x, y] = hm.center(i, j)
          const z = hm.z[j * hm.nx + i]!
          if (z < -8 - 1e-9) below++
          const [u, v] = [x - 40, y - 40]
          const r = Math.hypot(u, v)
          const k = Math.round(((Math.atan2(v, u) * 180) / Math.PI - 90) / (360 / 21))
          const t = ((90 + k * (360 / 21)) * Math.PI) / 180
          const across = Math.abs(-Math.sin(t) * u + Math.cos(t) * v)
          const along = Math.cos(t) * u + Math.sin(t) * v
          // a fin: outside every slot (less 0.02 mm, the cells along its sides)
          if (across > 1.02 && r > 12 && r < 30 && z < -0.02) gouge++
          // inside a slot from r 28 across the rim to r 31 (where its round end starts): cut to
          // the floor, so the profile (cutting r 30–36) opens it at full width
          if (across < 0.9 && along > 28 && along < 31 && z > -8 + 1e-6) rimUncut++
        }
      expect(below).toBe(0)
      expect(gouge).toBe(0)
      expect(rimUncut).toBe(0)
    },
  )

  it('golden: the same part at a 2 mm stepdown (4 levels keep the file small)', async () => {
    const { s, svc } = await radial({ stepdown: '2' })
    const { planId, warnings } = await plan(s)
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/heatsink-radial-fins.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
})
