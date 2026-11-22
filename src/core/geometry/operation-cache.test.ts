// Evaluation perf paths (v0.3 G1 perf): subtraction layers and the operation cache give the same
// part as before. Doc: docs/architecture/shapes.md#implementation-g1,
// docs/architecture/geometry.md#building-the-solids
import { beforeAll, describe, expect, it } from 'vitest'
import { fail, Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import type { Box } from './checks'
import { evaluatePart, subtractionLayers, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput } from './model'
import { OperationCache, operationKey } from './operation-cache'
import type { OperationSolids } from './operations'
import type { SolidKernel } from './solid-port'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { regionPocket, scallopLoop, starRegion } from './testing/shape-regions'
import { numberRegion } from './2d/place'

let kernel: SolidKernel
const region2d = nodeRegion2d()

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const box = (x0: number, x1: number): { box: Box; name: string } => ({
  box: { min: [x0, 0, -1], max: [x1, 1, 1] },
  name: `${x0}`,
})

describe('subtractionLayers', () => {
  it('puts tools with disjoint bounds in one layer and overlapping ones in later layers', () => {
    const tools = [box(0, 10), box(20, 30), box(5, 25), box(40, 50), box(8, 9)]
    const names = subtractionLayers(tools).map((l) => l.map((t) => t.name))
    expect(names).toEqual([['0', '20', '40'], ['5'], ['8']])
  })

  it('counts touching bounds as disjoint and caps a layer at the chunk size', () => {
    const tools = [box(0, 10), box(10, 20), box(20, 30), box(30, 40), box(40, 50)]
    expect(subtractionLayers(tools).map((l) => l.length)).toEqual([5])
    expect(subtractionLayers(tools, 2).map((l) => l.length)).toEqual([2, 2, 1])
  })
})

const exitLike = (depth = 5): PartGeometryInput => ({
  stock: { length: 200, width: 200, thickness: 30 },
  operations: [
    { kind: 'facing', id: 'facing1', depth: 0.5 },
    regionPocket('pocket1', starRegion(60, [100, 100], 40), depth, undefined, -0.5),
    {
      kind: 'profile',
      id: 'profile1',
      shape: {
        center: [0, 0],
        contour: {
          kind: 'region',
          region: numberRegion({ pieces: [{ outer: scallopLoop([100, 100], 85, 24), holes: [] }] }),
        },
      },
      side: 'outside',
      slotWidth: 6,
      tabs: { count: 4, width: 8, thickness: 3 },
    },
  ],
})

const run = (input: PartGeometryInput, cache?: OperationCache): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart(input, s, undefined, region2d, cache)))

const same = (a: PartEvaluation, b: PartEvaluation) => {
  expect(b.surfaces).toEqual(a.surfaces)
  expect(b.volume).toBe(a.volume)
  expect(b.pieces).toBe(a.pieces)
  expect(b.warnings).toEqual(a.warnings)
  // the same labelled triangles; their order follows the solids' original ids, which kept
  // solids keep from the evaluation that made them
  expect(triangles(b)).toEqual(triangles(a))
}

/** Each triangle as its surface and corners (rotated to the smallest first), sorted. */
function triangles(e: PartEvaluation): string[] {
  const out: string[] = []
  for (let t = 0; t < e.triangleSurface.length; t++) {
    const corners = [0, 1, 2].map((k) => {
      const v = e.indices[3 * t + k]!
      return `${e.positions[3 * v]},${e.positions[3 * v + 1]},${e.positions[3 * v + 2]}`
    })
    const first = corners.indexOf([...corners].sort()[0]!)
    const turned = [0, 1, 2].map((k) => corners[(first + k) % 3]!)
    out.push(`${e.surfaces[e.triangleSurface[t]!]} ${turned.join(' ')}`)
  }
  return out.sort()
}

describe('OperationCache', () => {
  it.each([0, 1e6])(
    'reuses unchanged operations (kept solids: %d triangles): the same part, cached or not',
    (keep) => {
      kernel.keepSolids(keep)
      try {
        const cache = new OperationCache()
        const plain = run(exitLike())
        same(plain, run(exitLike(), cache))
        expect(cache.size).toBe(3)
        // the stock and every operation's solid
        expect(kernel.keptObjects()).toBe(keep > 0 ? 4 : 0)
        same(plain, run(exitLike(), cache))
        expect(cache.size).toBe(3)
        // an edit rebuilds only the edited pocket
        const edited = run(exitLike(7), cache)
        expect(cache.size).toBe(4)
        expect(kernel.keptObjects()).toBe(keep > 0 ? 5 : 0)
        same(run(exitLike(7)), edited)
        same(plain, run(exitLike(), cache))
        expect(kernel.liveObjects()).toBe(0)
      } finally {
        kernel.keepSolids(0)
      }
      expect(kernel.keptObjects()).toBe(0)
    },
  )

  it('evicts kept solids past the capacity when the arena closes', () => {
    kernel.keepSolids(1)
    try {
      const cache = new OperationCache()
      same(run(exitLike()), run(exitLike(), cache))
      expect(kernel.keptObjects()).toBe(0)
      expect(kernel.liveObjects()).toBe(0)
    } finally {
      kernel.keepSolids(0)
    }
  })

  it('keys on the stock too and evicts the least recently used past its capacity', () => {
    // synthetic solids of 9 numbers each (3 positions + 2 × 3 triangle indices)
    const solids = (id: string): OperationSolids =>
      ({
        id,
        removal: [{ mesh: { positions: new Float64Array(3), triangles: new Uint32Array(3) } }],
        cut: [],
        retained: [],
        nominal: [],
      }) as unknown as OperationSolids
    const op = (id: string): OperationGeometry => ({ kind: 'facing', id, depth: 1 })
    const stock = { length: 10, width: 10, thickness: 10 }
    let builds = 0
    const get = (cache: OperationCache, id: string, s = stock) =>
      cache.solids(operationKey(op(id), s), () => {
        builds++
        return Ok(solids(id))
      })
    const cache = new OperationCache(18) // two entries of 9
    get(cache, 'a')
    get(cache, 'b')
    get(cache, 'a') // hit: `a` is now the most recently used
    expect(builds).toBe(2)
    get(cache, 'c') // evicts `b`
    expect(cache.size).toBe(2)
    get(cache, 'a')
    expect(builds).toBe(3)
    get(cache, 'b')
    expect(builds).toBe(4)
    get(cache, 'b', { ...stock, thickness: 11 })
    expect(builds).toBe(5)
    // failed builds are not kept; too large ones neither
    expect(
      cache
        .solids(operationKey(op('d'), stock), () =>
          fail('internal.unexpected', 'no', { where: 'test' }),
        )
        .isErr(),
    ).toBe(true)
    expect(
      new OperationCache(8).solids(operationKey(op('e'), stock), () => Ok(solids('e'))).isOk(),
    ).toBe(true)
    const tiny = new OperationCache(8)
    tiny.solids(operationKey(op('e'), stock), () => Ok(solids('e')))
    expect(tiny.size).toBe(0)
  })
})
