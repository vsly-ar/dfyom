import { beforeAll, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { evaluatePart, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import { CHORD_TOLERANCE, type OperationGeometry, type PartGeometryInput } from './model'
import type { SolidKernel } from './solid-port'
import { signedVolume } from './testing/mesh-oracles'
import { nodeManifoldSource } from './testing/node-wasm'
import { TEST_PART_SURFACES, TEST_STOCK, testPart, testPartVolume } from './testing/test-part'

let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const evaluate = (input: PartGeometryInput): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart(input, s)))

/** Centroids of all triangles labelled `id`. */
function centroids(e: PartEvaluation, id: string): [number, number, number][] {
  const s = e.surfaces.indexOf(id)
  const out: [number, number, number][] = []
  for (let t = 0; t < e.triangleSurface.length; t++) {
    if (e.triangleSurface[t] !== s) continue
    const c: [number, number, number] = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      const v = e.indices[3 * t + k]!
      for (let a = 0; a < 3; a++) c[a]! += e.positions[3 * v + a]! / 3
    }
    out.push(c)
  }
  return out
}

describe('evaluatePart: test part', () => {
  it.each([4, 3])('evaluates with corner radius %d: every surface id, analytic volume', (r) => {
    const e = evaluate(testPart({ cornerRadius: r }))
    for (const id of TEST_PART_SURFACES) expect(e.surfaces, id).toContain(id)
    expect(e.surfaces).not.toContain('stock.top')
    const exact = testPartVolume({ cornerRadius: r })
    expect(e.volume).toBeGreaterThanOrEqual(exact)
    expect(e.volume).toBeLessThanOrEqual(exact * 1.0005)
    expect(
      signedVolume({ positions: Float64Array.from(e.positions), triangles: e.indices }),
    ).toBeCloseTo(e.volume, 1)
    expect(e.stats.triangles).toBe(e.indices.length / 3)
    expect(e.stats.triangles).toBeLessThanOrEqual(20_000)
    expect(kernel.liveObjects()).toBe(0)
  })

  it('puts triangles on their labelled analytic surfaces', () => {
    const e = evaluate(testPart())
    const planes: [string, number][] = [
      ['facing1.floor', -0.5],
      ['pocket1.floor', -8.5],
      ['drill2.bottom', -12.5],
      ['stock.bottom', -20],
      ...[0, 1, 2, 3].map((i): [string, number] => [`profile1.tab[${i}].top`, -17]),
    ]
    for (const [id, z] of planes)
      for (const c of centroids(e, id)) expect(c[2], id).toBeCloseTo(z, 4)
    // pocket wall[0] is the plane y = 30 − 12.5, wall[1] x = 50 + 20
    for (const c of centroids(e, 'pocket1.wall[0]')) expect(c[1]).toBeCloseTo(17.5, 4)
    for (const c of centroids(e, 'pocket1.wall[1]')) expect(c[0]).toBeCloseTo(70, 4)
    // corner[1] is the cylinder r = 4 around (66, 21.5), inscribed: within the chord tolerance
    for (const c of centroids(e, 'pocket1.corner[1]')) {
      const d = Math.hypot(c[0] - 66, c[1] - 21.5)
      expect(d).toBeLessThanOrEqual(4 + 1e-4)
      expect(d).toBeGreaterThanOrEqual(4 - CHORD_TOLERANCE)
    }
    // tab[0] sits on the middle of the front wall: x 46..54, in the slot y 2..8
    for (const c of centroids(e, 'profile1.tab[0].top')) {
      expect(c[0]).toBeGreaterThan(46 - 1e-4)
      expect(c[0]).toBeLessThan(54 + 1e-4)
      expect(c[1]).toBeGreaterThan(2 - 1e-4)
      expect(c[1]).toBeLessThan(8 + 1e-4)
    }
    for (const c of centroids(e, 'profile1.tab[0].end[0]')) expect(c[0]).toBeCloseTo(46, 4)
    for (const c of centroids(e, 'profile1.tab[0].end[1]')) expect(c[0]).toBeCloseTo(54, 4)
  })

  it('splits vertices at surface boundaries', () => {
    const e = evaluate(testPart())
    const surfaceOf = new Map<number, number>()
    for (let t = 0; t < e.triangleSurface.length; t++)
      for (let k = 0; k < 3; k++) {
        const v = e.indices[3 * t + k]!
        const s = surfaceOf.get(v)
        if (s !== undefined) expect(s).toBe(e.triangleSurface[t])
        surfaceOf.set(v, e.triangleSurface[t]!)
      }
  })

  it('frees every WASM object and keeps the heap flat over repeated evaluations', async () => {
    const hosted = expectOk(await loadManifold(nodeManifoldSource()))
    const run = () => expectOk(hosted.withSolids((s) => evaluatePart(testPart(), s)))
    for (let i = 0; i < 5; i++) run()
    const warm = hosted.heapBytes().unwrap()
    for (let i = 0; i < 30; i++) run()
    expect(hosted.liveObjects()).toBe(0)
    expect(hosted.heapBytes().unwrap() - warm).toBeLessThanOrEqual(10 * 2 ** 20)
  })
})

const withOp = (op: OperationGeometry): PartGeometryInput => ({
  stock: TEST_STOCK,
  operations: [op],
})

const pocket = (
  contour: Extract<OperationGeometry, { kind: 'pocket' }>['shape']['contour'],
  depth: number,
  floorRadius: number,
): OperationGeometry => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: { center: [50, 30], contour },
  depth,
  floorRadius,
})

describe('evaluatePart: edge cases', () => {
  it.each([
    [
      'floorRadius = cornerRadius',
      { kind: 'rectangle', length: 40, width: 25, cornerRadius: 4 },
      8,
      4,
    ],
    ['cornerRadius = 0', { kind: 'rectangle', length: 40, width: 25, cornerRadius: 0 }, 8, 0],
    [
      'cornerRadius = width / 2',
      { kind: 'rectangle', length: 40, width: 25, cornerRadius: 12.5 },
      8,
      3,
    ],
    ['floorRadius = depth', { kind: 'rectangle', length: 40, width: 25, cornerRadius: 6 }, 5, 5],
    ['circle', { kind: 'circle', radius: 10 }, 8, 2],
  ] as const)('pocket with %s', (_name, contour, depth, f) => {
    const e = evaluate(withOp(pocket(contour, depth, f)))
    expect(e.surfaces).toContain('pocket1.floor')
    if (contour.kind === 'rectangle' && contour.cornerRadius === 0)
      expect(e.surfaces.some((s) => s.includes('corner'))).toBe(false)
    if (f > 0) expect(e.surfaces).toContain('pocket1.floorFillet')
  })

  it('drills with a 180° point have a flat bottom', () => {
    const e = evaluate(
      withOp({
        kind: 'drilling',
        id: 'drill1',
        onZ: 0,
        center: [20, 20],
        diameter: 8,
        bottom: { kind: 'drillPoint', depth: 10, pointAngle: 180 },
      }),
    )
    for (const c of centroids(e, 'drill1.bottom')) expect(c[2]).toBeCloseTo(-10, 4)
  })

  it.each(['outside', 'inside'] as const)('profiles %s with tabs on a circle', (side) => {
    const e = evaluate(
      withOp({
        kind: 'profile',
        id: 'profile1',
        shape: { center: [50, 30], contour: { kind: 'circle', radius: 15 } },
        side,
        slotWidth: 6,
        tabs: { count: 3, width: 6, thickness: 2 },
      }),
    )
    for (const id of ['profile1.wall[0]', 'profile1.tab[2].top', 'profile1.tab[0].end[1]'])
      expect(e.surfaces).toContain(id)
  })

  it('profiles inside where the slot covers the whole opening (no offcut, no tabs)', () => {
    const e = evaluate(
      withOp({
        kind: 'profile',
        id: 'profile1',
        shape: {
          center: [50, 30],
          contour: { kind: 'rectangle', length: 20, width: 10, cornerRadius: 3 },
        },
        side: 'inside',
        slotWidth: 6,
        tabs: { count: 4, width: 4, thickness: 2 },
      }),
    )
    expect(e.surfaces.some((s) => s.includes('tab'))).toBe(false)
    expect(e.volume).toBeCloseTo(100 * 60 * 20 - (200 - (4 - Math.PI) * 9) * 20, -1)
  })

  it('fails with loftInvalid when floorRadius exceeds cornerRadius (a bug upstream)', () => {
    const e = kernel.withSolids((s) =>
      evaluatePart(
        withOp(pocket({ kind: 'rectangle', length: 40, width: 25, cornerRadius: 1 }, 8, 2)),
        s,
      ),
    )
    expect(expectErrCode(e, 'geometry.evaluation').issues[0]?.rule).toBe('loftInvalid')
    expect(kernel.liveObjects()).toBe(0)
  })
})

describe('evaluatePart: seeded random valid parameters', () => {
  /** mulberry32 */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('evaluates 40 random parts without error or air triangles', () => {
    const rand = rng(20261117)
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand()
    for (let i = 0; i < 40; i++) {
      const length = between(5, 40)
      const width = between(5, 25)
      const cornerRadius = rand() < 0.2 ? 0 : between(0, Math.min(length, width) / 2)
      const depth = between(0.5, 15)
      const floorRadius = between(0, Math.min(depth, cornerRadius))
      const angle = between(60, 180)
      const slot = between(1, 6)
      const input: PartGeometryInput = {
        stock: TEST_STOCK,
        operations: [
          { kind: 'facing', id: 'facing1', depth: between(0.1, 2) },
          pocket({ kind: 'rectangle', length, width, cornerRadius }, depth, floorRadius),
          {
            kind: 'drilling',
            id: 'drill1',
            onZ: 0,
            center: [between(5, 20), between(5, 55)],
            diameter: between(1, 8),
            bottom: { kind: 'drillPoint', depth: between(1, 15), pointAngle: angle },
          },
          {
            kind: 'profile',
            id: 'profile1',
            shape: {
              center: [50, 30],
              contour: { kind: 'rectangle', length: 70, width: 40, cornerRadius: between(0, 10) },
            },
            side: rand() < 0.5 ? 'outside' : 'inside',
            slotWidth: slot,
            tabs: {
              count: Math.floor(between(0, 6)),
              width: between(2, 8),
              thickness: between(1, 5),
            },
          },
        ],
      }
      const r = kernel.withSolids((s) => evaluatePart(input, s))
      expect(r.isOk(), JSON.stringify({ i, input, err: r.isErr() && r.unwrapErr().toJSON() })).toBe(
        true,
      )
    }
    expect(kernel.liveObjects()).toBe(0)
  })
})
