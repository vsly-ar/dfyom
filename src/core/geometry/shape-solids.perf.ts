/**
 * Shape solid budgets (v0.3 G1, docs/architecture/shapes.md#performance and #implementation-g1):
 * warm evaluation of parts with general shapes against ≈ 3 000 chords per 50 ms, outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import { evaluatePart } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput } from './model'
import { numberRegion, translateRegion } from './2d/place'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { shapeChords } from './shape-solids'
import { nodeManifoldSource } from './testing/node-wasm'
import { islandsRegion, regionPocket, scallopLoop, starRegion } from './testing/shape-regions'

const region2d = nodeRegion2d()

async function measure(name: string, input: PartGeometryInput, runs = 30) {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const run = () => kernel.withSolids((s) => evaluatePart(input, s, undefined, region2d)).unwrap()
  const first = run()
  for (let i = 0; i < 5; i++) run()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    run()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(runs / 2)]!
  const chords = input.operations.reduce(
    (n, op) => n + (op.kind === 'pocket' || op.kind === 'profile' ? shapeChords(op) : 0),
    0,
  )
  console.log(
    `${name}: ${chords} chords, warm median ${median.toFixed(1)} ms ` +
      `(${((median / chords) * 3000).toFixed(1)} ms per 3 000 chords), ` +
      `${first.stats.triangles} triangles, ${first.pieces} piece(s)`,
  )
  expect(kernel.liveObjects()).toBe(0)
  return { median, chords }
}

const profile = (id: string, region = starRegion(500)): OperationGeometry => ({
  kind: 'profile',
  id,
  shape: { center: [0, 0], contour: { kind: 'region', region } },
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
})

it('three shape pockets of 500 elements in total within the budget (S3 case)', async () => {
  const input: PartGeometryInput = {
    stock: { length: 560, width: 200, thickness: 30 },
    operations: [
      regionPocket('pocket1', starRegion(170, [100, 100], 60), 5),
      regionPocket('pocket2', islandsRegion(170, 220, 30, 390, 170), 4),
      regionPocket('pocket3', starRegion(160, [480, 100], 50), 3, undefined, -4),
    ],
  }
  const { median } = await measure('3 pockets, 500 elements', input)
  expect(median).toBeLessThanOrEqual(50)
})

// Profiles cost ≈ 2–4× a pocket per chord (a through ring crossing both stock faces, tab
// booleans, the pieces check); guarded at twice the budget until that is closed
// (docs/architecture/shapes.md#implementation-g1, known issue)
it('two pockets and a profile with tabs, 500 elements in total', async () => {
  const input: PartGeometryInput = {
    stock: { length: 400, width: 200, thickness: 30 },
    operations: [
      regionPocket('pocket1', starRegion(170, [100, 100], 60), 5),
      regionPocket('pocket2', islandsRegion(170, 220, 30, 390, 170), 4),
      profile(
        'profile1',
        numberRegion({ pieces: [{ outer: scallopLoop([100, 100], 85, 80), holes: [] }] }),
      ),
    ],
  }
  const { median } = await measure('2 pockets + profile, 500 elements', input)
  expect(median).toBeLessThanOrEqual(100)
})

it('the exit part of enclosure-sections.svg', async () => {
  interface NodeProcess {
    getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
  }
  const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
  const shapes = importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')).unwrap().shapes
  const placed = (name: string) => {
    const s = shapes.find((x) => x.name === name)!
    const loops = s.items.map((i) => (i.kind === 'loop' ? i.loop : i.path))
    return numberRegion(translateRegion(region2d.normalise(loops).unwrap(), [2.5, 3.5]))
  }
  const input: PartGeometryInput = {
    stock: { length: 255, width: 185, thickness: 40 },
    operations: [
      { kind: 'facing', id: 'facing1', depth: 0.5 },
      regionPocket('pocket1', placed('cavity'), 34.8, undefined, -0.5),
      profile('profile1', placed('outline')),
    ],
  }
  const { median } = await measure('exit part', input)
  expect(median).toBeLessThanOrEqual(100)
})

it('a heavy part (documented, not budgeted): 2 000-element islands pocket', async () => {
  await measure(
    'islands 2000',
    {
      stock: { length: 200, width: 120, thickness: 30 },
      operations: [regionPocket('pocket1', islandsRegion(2000), 5)],
    },
    10,
  )
})
