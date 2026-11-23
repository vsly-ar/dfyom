/**
 * Clones at scale (hardening P4, docs/research/s6-clone-budgets.md#follow-up-p4): parts with 100
 * and 400 clone instances of a counterbored M3 hole (one and four Clones features of a 10 × 10
 * grid; the v0.4 limit is 100 per feature), through the real commands: `plan.create`, the plan's
 * generator inputs, G-code export (toolpaths generated, then all cached), fresh evaluation and
 * its longest clone layer step. Outside `npm run check` (timings are flaky in CI): `npm run perf`.
 */
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectOk } from '../../../shared/testing/result'
import { inProcessWorkers } from '../../commands/jobs'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../geometry/evaluate'
import { loadManifold } from '../../geometry/manifold'
import { nodeManifoldSource } from '../../geometry/testing/node-wasm'
import { len, libraryInput, machineValues } from '../../library/library.fixture'
import { planOperationInputs } from '../../plan/inputs'
import { drill6, drillPreset, flat6 } from '../../plan/plan.fixture'
import { exportPlan } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { Steps } from '../../workers/steps'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'

const region2d = nodeRegion2d()

/**
 * The lowest of three medians of `n` runs each, after a warm-up (as design-command.perf.ts): a
 * burst of load from parallel runs inflates one round's median, a slower path every round.
 */
async function median(n: number, fn: () => unknown): Promise<number> {
  await fn()
  const rounds: number[] = []
  for (let k = 0; k < 3; k++) {
    const times: number[] = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      await fn()
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    rounds.push(times[Math.floor(n / 2)]!)
  }
  return Math.min(...rounds)
}

/**
 * `grids` counterbored M3 holes, each the source of a 10 × 10 Clones grid at a 10 mm pitch
 * (100 instances, 200 operations per grid), on a 6 mm aluminium board; Apply made the tool
 * choice.
 */
async function clonesPart(grids: 1 | 4): Promise<{ s: DesignSetup; machineId: string }> {
  const size = (wide: boolean) => `${wide ? 230 : 120}`
  const s = await designSetup({
    stock: {
      name: 'Board',
      shape: 'block',
      length: size(grids > 1),
      width: size(grids > 2),
      thickness: '6',
      material: { name: '6061-T6', class: 'aluminum' },
    },
    services: { region2d },
  })
  const add = async (kind: string, values: object) =>
    ((await s.run(`library.${kind}.add`, { values: libraryInput(values) })) as { id: string }).id
  const f6 = flat6()
  await add('tool', f6)
  await add('tool', {
    ...f6,
    name: 'Flat 3',
    diameter: len('3'),
    fluteLength: len('12'),
    presets: f6.presets.map((p) => ({ ...p, stepdown: len('1'), stepover: len('1.2') })),
  })
  await add('tool', {
    ...drill6(),
    name: 'Drill 3.4',
    diameter: len('3.4'),
    presets: [drillPreset()],
  })
  const { kind: _, ...m } = machineValues()
  const machineId = await add('machine', m)
  for (let g = 0; g < grids; g++) {
    const hole = (await s.run('design.hole.add', {
      partId: s.partId,
      center: [`${10 + (g % 2) * 110}`, `${10 + Math.floor(g / 2) * 110}`],
      type: 'counterbore',
      fastener: 'M3',
    })) as { featureId: string }
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureId: hole.featureId },
      rows: [{ kind: 'grid', cols: 10, rows: 10, du: '10', dv: '10' }],
    })
  }
  await s.run('project.apply', {})
  return { s, machineId }
}

/**
 * Guards (docs/research/s6-clone-budgets.md#follow-up-p4), ms: about twice the medians measured
 * under load (load average 8–10), so a return of the per-operation work P4 removed (plan
 * creation and export quadratic in operations: 3.3–5.8 s at 400 instances, 0.2–0.3 s at 100)
 * fails. Evaluation is the boolean kernel's (unchanged by P4); its guards catch a return of the
 * S6 layers-of-25 growth. `step`: the median over runs of each run's longest subtraction step.
 */
const GUARD = {
  100: { create: 100, inputs: 25, generate: 150, cached: 50, evaluate: 350, step: 200 },
  400: { create: 400, inputs: 100, generate: 450, cached: 250, evaluate: 1_600, step: 280 },
} as const

const ms = (v: number) => `${v.toFixed(1)} ms`

describe('Clones at scale (P4)', () => {
  for (const grids of [1, 4] as const) {
    const n = grids === 1 ? 100 : 400
    it(`${n} instances: plan creation and export linear, fresh evaluation`, async () => {
      const { s, machineId } = await clonesPart(grids)
      expect(s.part().operations.length).toBe(grids * 200)
      const create = () =>
        s.run('plan.create', { partId: s.partId, machineLibraryItemId: machineId }) as Promise<{
          planId: string
        }>
      const createMs = await median(3, create)
      const { planId } = await create()
      const inputsMs = await median(3, () =>
        expectOk(planOperationInputs(s.d.doc, planId, undefined, region2d)),
      )
      const services = () => ({
        workers: inProcessWorkers,
        toolpaths: createToolpathCache(512 * 2 ** 20),
        region2d,
      })
      const generateMs = await median(3, async () =>
        expectOk(await exportPlan(s.d.doc, planId, services())),
      )
      const warm = services()
      const program = expectOk(await exportPlan(s.d.doc, planId, warm))
      const cachedMs = await median(3, async () =>
        expectOk(await exportPlan(s.d.doc, planId, warm)),
      )

      // fresh evaluation (no caches) and its longest subtraction step
      const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
      const kernel = expectOk(await loadManifold(nodeManifoldSource()))
      const longest: number[] = []
      const evaluate = () => {
        let last = performance.now()
        let max = 0
        const steps: Steps = {
          step: (p) => {
            const now = performance.now()
            if (p?.label?.startsWith('subtract') === true) max = Math.max(max, now - last)
            last = now
            return Ok(undefined)
          },
        }
        const e = expectOk(
          kernel.withSolids((solids) => evaluatePart(input, solids, steps, region2d)),
        )
        longest.push(max)
        return e
      }
      const triangles = evaluate().stats.triangles
      const evaluateMs = await median(3, evaluate)
      longest.sort((a, b) => a - b)
      const stepMs = longest[Math.floor(longest.length / 2)]!

      console.log(
        `${n} instances (${grids * 200} operations, ${program.lines.length} program lines, ` +
          `${triangles} triangles): plan.create ${ms(createMs)}, planOperationInputs ` +
          `${ms(inputsMs)}, generate + export ${ms(generateMs)}, export cached ${ms(cachedMs)}, ` +
          `fresh evaluation ${ms(evaluateMs)} (longest step ${ms(stepMs)})`,
      )
      const g = GUARD[n]
      expect(createMs).toBeLessThanOrEqual(g.create)
      expect(inputsMs).toBeLessThanOrEqual(g.inputs)
      expect(generateMs).toBeLessThanOrEqual(g.generate)
      expect(cachedMs).toBeLessThanOrEqual(g.cached)
      expect(evaluateMs).toBeLessThanOrEqual(g.evaluate)
      expect(stepMs).toBeLessThanOrEqual(g.step)
    })
  }
})
