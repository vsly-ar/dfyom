/**
 * Shape solid budgets (v0.3 G1, docs/architecture/shapes.md#performance and #implementation-g1):
 * warm evaluation of parts with general shapes against ≈ 3 000 chords per 50 ms, outside
 * `npm run check` because timings are flaky in CI. Run: `npm run perf`.
 *
 * Each case is measured three ways, interleaved in one process: `fresh` (no cache: every
 * operation built and made a solid), `edited` (the worker's caches, the last operation changed
 * every run – an edit) and `unchanged` (the caches, the same input – a re-evaluation). Guards
 * leave room for a machine loaded by parallel runs (medians swing ≈ 2× there); the budget
 * itself is for an idle reference machine.
 */
import { expect, it } from 'vitest'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import { KEPT_TRIANGLES } from '../workers/tasks'
import { evaluatePart } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput } from './model'
import { OperationCache } from './operation-cache'
import { numberRegion, translateRegion } from './2d/place'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { shapeChords } from './shape-solids'
import { nodeManifoldSource } from './testing/node-wasm'
import { islandsRegion, regionPocket, scallopLoop, starRegion } from './testing/shape-regions'

const region2d = nodeRegion2d()

type Way = 'fresh' | 'edited' | 'unchanged'

async function measure(name: string, input: PartGeometryInput, runs = 30) {
  const ways: Way[] = ['fresh', 'edited', 'unchanged']
  // one kernel per way, so kept solids of one never serve another
  const kernels = await Promise.all(
    ways.map(async () => (await loadManifold(nodeManifoldSource())).unwrap()),
  )
  const caches = ways.map((w) => (w === 'fresh' ? undefined : new OperationCache()))
  kernels.forEach((k, i) => k.keepSolids(ways[i] === 'fresh' ? 0 : KEPT_TRIANGLES))
  const last = input.operations.length - 1
  const edit = (r: number): PartGeometryInput => ({
    ...input,
    operations: input.operations.map((op, i) => (i === last ? { ...op, id: `${op.id}e${r}` } : op)),
  })
  const run = (w: number, r: number) =>
    kernels[w]!.withSolids((s) =>
      evaluatePart(ways[w] === 'edited' ? edit(r) : input, s, undefined, region2d, caches[w]),
    ).unwrap()
  const first = run(0, 0)
  const times: number[][] = ways.map(() => [])
  for (let r = 0; r < runs + 5; r++)
    for (let w = 0; w < ways.length; w++) {
      const t = performance.now()
      run(w, r)
      if (r >= 5) times[w]!.push(performance.now() - t)
    }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const [fresh, edited, unchanged] = times.map(median) as [number, number, number]
  const chords = input.operations.reduce(
    (n, op) => n + (op.kind === 'pocket' || op.kind === 'profile' ? shapeChords(op) : 0),
    0,
  )
  console.log(
    `${name}: ${chords} chords, warm median fresh ${fresh.toFixed(1)} ms ` +
      `(${((fresh / chords) * 3000).toFixed(1)} ms per 3 000 chords), edited ` +
      `${edited.toFixed(1)} ms, unchanged ${unchanged.toFixed(1)} ms; ` +
      `${first.stats.triangles} triangles, ${first.pieces} piece(s)`,
  )
  for (const k of kernels) {
    expect(k.liveObjects()).toBe(0)
    k.keepSolids(0)
    expect(k.keptObjects()).toBe(0)
  }
  return { fresh, edited, unchanged, chords }
}

/** Guards on a loaded machine (idle: ≈ 0.6× these, docs/architecture/shapes.md#performance). */
const GUARD_FRESH = 75
const GUARD_PROFILE = 120

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
  const { fresh, edited } = await measure('3 pockets, 500 elements', input)
  expect(fresh).toBeLessThanOrEqual(GUARD_FRESH)
  expect(edited).toBeLessThanOrEqual(50)
})

// Profiles cost ≈ 2–3× a pocket per chord (a through ring of two loops crossing both stock
// faces, the tab subtraction); guarded above the budget (docs/architecture/shapes.md#performance)
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
  const { fresh, edited } = await measure('2 pockets + profile, 500 elements', input)
  expect(fresh).toBeLessThanOrEqual(GUARD_PROFILE)
  expect(edited).toBeLessThanOrEqual(GUARD_PROFILE)
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
  const { fresh, edited } = await measure('exit part', input)
  expect(fresh).toBeLessThanOrEqual(50)
  expect(edited).toBeLessThanOrEqual(50)
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
