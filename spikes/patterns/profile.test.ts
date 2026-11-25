/**
 * Spike S8: where the time goes for one case (S8P_N cells, default 500, hex lattice of rounded
 * hexagons, chamfer S8P_CHAMFER, default 0.5): the evaluation's steps by label, the loft build
 * alone, the toolpath generation and the export. Run with a CPU profile:
 * `npx vitest run -c spikes/patterns/vitest.config.mts spikes/patterns/profile.test.ts
 *  --silent=false --pool=forks --execArgv=--cpu-prof --execArgv=--cpu-prof-dir=<dir>`.
 */
import { it } from 'vitest'
import { Ok } from '../../src/shared/result'
import { expectOk } from '../../src/shared/testing/result'
import { createInProcessWorkers } from '../../src/core/commands/jobs'
import { uiSource } from '../../src/core/commands/testing'
import { partGeometryInput } from '../../src/core/design/load'
import { evaluatePart } from '../../src/core/geometry/evaluate'
import { loopChamferSolids } from '../../src/core/geometry/chamfer-solids'
import { loadManifold } from '../../src/core/geometry/manifold'
import { nodeRegion2d } from '../../src/core/geometry/2d/testing/node-wasm'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { deg, len, libraryInput, num } from '../../src/core/library/library.fixture'
import { exportPlan } from '../../src/core/post/plan-export'
import { planSetup } from '../../src/core/plan/plan.fixture'
import { createToolpathCache } from '../../src/core/toolpath/cache'
import { boundaryFor, hexCell } from './lattice'

const N = Number(process.env['S8P_N'] ?? 500)
const CHAMFER = process.env['S8P_CHAMFER'] ?? '0.5'
const now = () => performance.now()

it('S8 profile', async () => {
  const region2d = nodeRegion2d()
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const { size, centres } = boundaryFor('hex', hexCell, 2, 5, N)
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({
    part: false,
    services: svc,
    stock: {
      name: 'Board',
      shape: 'block' as const,
      length: String(size[0]),
      width: String(size[1]),
      thickness: '20',
      material: { name: 'Walnut', class: 'hardwood' as const },
    },
  })
  await s.run('library.tool.add', {
    values: libraryInput({
      name: 'Chamfer 6',
      type: 'chamferMill' as const,
      diameter: len('6'),
      angle: deg('90'),
      fluteLength: len('8'),
      overallLength: len('50'),
      fluteCount: num('2'),
      toolMaterial: 'carbide' as const,
      presets: [],
    }),
  })
  await s.run('design.shape.add', { partId: s.partId, items: centres.map((c) => hexCell.item(c)) })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'named', shapeId: 'shape1', center: [String(size[0] / 2), String(size[1] / 2)] },
    depth: '1.5',
  })
  if (CHAMFER !== 'none')
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: CHAMFER })
  await s.run('project.apply', {})
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))

  const ch = input.operations.find((o) => o.id === 'chamfer1')
  if (ch?.kind === 'chamfer' && ch.edge !== undefined) {
    const t = now()
    const built = kernel
      .withSolids((sol) =>
        loopChamferSolids(ch, { triangulate: (r) => sol.triangulate(r), region2d }).map((l) => {
          const m = l.removal[0]!.mesh
          return { meshes: l.removal.length, tris: m.triangles.length / 3 }
        }),
      )
      .unwrap()
    console.log(`loopChamferSolids: ${(now() - t).toFixed(0)} ms`, built)
  }

  for (let run = 0; run < 2; run++) {
    const steps: string[] = []
    let last = now()
    const t0 = last
    kernel
      .withSolids((sol) =>
        evaluatePart(
          input,
          sol,
          {
            step: (p) => {
              const t = now()
              steps.push(`${p?.label ?? '?'} ${(t - last).toFixed(0)}`)
              last = t
              return Ok(undefined)
            },
          },
          region2d,
        ),
      )
      .unwrap()
    console.log(`evaluate ${(now() - t0).toFixed(0)} ms; tail ${(now() - last).toFixed(0)} ms:`)
    console.log(steps.filter((x) => Number(x.split(' ').at(-1)) >= 5).join(' | '))
  }

  const planId = await s.create({ machineLibraryItemId: s.machineId })
  let t = now()
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  console.log(`generate ${(now() - t).toFixed(0)} ms`)
  t = now()
  const e = expectOk(await exportPlan(s.d.doc, planId, svc))
  console.log(`export ${(now() - t).toFixed(0)} ms, ${e.lines.length} lines`)
})
