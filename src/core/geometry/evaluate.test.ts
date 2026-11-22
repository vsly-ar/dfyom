import { beforeAll, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { evaluatePart, type PartEvaluation } from './evaluate'
import { localStock, type Direction } from './face'
import { loadManifold } from './manifold'
import { CHORD_TOLERANCE, type OperationGeometry, type PartGeometryInput } from './model'
import type { SolidKernel } from './solid-port'
import { pocketVolume } from './testing/analytic'
import { signedVolume } from './testing/mesh-oracles'
import { nodeManifoldSource } from './testing/node-wasm'
import {
  TEST_PART_SURFACES,
  TEST_STOCK,
  testPart,
  testPartChordBound,
  testPartVolume,
} from './testing/test-part'

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
    // within the chord-error bound (≈ 24 mm³): a missing drill-point cone (17 mm³) or one tab
    // 0.1 mm too tall (5 mm³ above the measured 20.7) fails
    expect(e.volume - exact).toBeLessThanOrEqual(testPartChordBound({ cornerRadius: r }))
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
    // drill-point cones reach their tip: 12.5 deep + 3 / tan(59°)
    const tip = -12.5 - 3 / Math.tan((59 * Math.PI) / 180)
    for (const id of ['drill3.bottom', 'drill4.bottom']) {
      const s = e.surfaces.indexOf(id)
      let lowest = Infinity
      for (let t = 0; t < e.triangleSurface.length; t++)
        if (e.triangleSurface[t] === s)
          for (let k = 0; k < 3; k++)
            lowest = Math.min(lowest, e.positions[3 * e.indices[3 * t + k]! + 2]!)
      expect(lowest, id).toBeCloseTo(tip, 4)
    }
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

  it('evaluates tabs over corners of every size on both profile sides', () => {
    for (const side of ['outside', 'inside'] as const)
      for (const cornerRadius of [0, 0.5, 2, 5, 9.5])
        for (const [count, width] of [
          [3, 5],
          [5, 5],
          [7, 5],
          [9, 5],
          [6, 2],
          [4, 9],
          [11, 3],
        ] as const) {
          const input = withOp({
            kind: 'profile',
            id: 'profile1',
            shape: {
              center: [50, 30],
              contour: { kind: 'rectangle', length: 40, width: 20, cornerRadius },
            },
            side,
            slotWidth: 4,
            tabs: { count, width, thickness: 2 },
          })
          const r = kernel.withSolids((s) => evaluatePart(input, s))
          expect(
            r.isOk(),
            JSON.stringify({
              side,
              cornerRadius,
              count,
              width,
              e: r.isErr() && r.unwrapErr().toJSON(),
            }),
          ).toBe(true)
        }
  })

  it('evaluates circles at and below the chord tolerance', () => {
    const profile = (side: 'outside' | 'inside', radius: number, slotWidth: number) =>
      withOp({
        kind: 'profile',
        id: 'profile1',
        shape: { center: [50, 30], contour: { kind: 'circle', radius } },
        side,
        slotWidth,
        tabs: { count: 1, width: Math.min(1, radius), thickness: 2 },
      })
    const inputs: PartGeometryInput[] = [
      withOp({
        kind: 'drilling',
        id: 'drill1',
        onZ: 0,
        center: [20, 20],
        diameter: 0.02,
        bottom: { kind: 'through' },
      }),
      profile('outside', 0.01, 3),
      profile('inside', 3, 2.995), // inset r 0.005 ≤ chord tolerance: the slot covers it
    ]
    for (const input of inputs) evaluate(input)
    expect(evaluate(inputs[0]!).surfaces).toContain('drill1.wall')
    expect(evaluate(inputs[1]!).surfaces).toContain('profile1.wall[0]')
    expect(evaluate(inputs[2]!).surfaces.some((s) => s.includes('tab'))).toBe(false)
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

/** Every centroid of `id` (at least one) passes `check`. */
function each(e: PartEvaluation, id: string, check: (c: [number, number, number]) => void): void {
  const cs = centroids(e, id)
  expect(cs.length, id).toBeGreaterThan(0)
  for (const c of cs) check(c)
}

describe('evaluatePart: non-top faces (built in the face frame, then placed)', () => {
  const T = TEST_STOCK
  const drill = (
    id: string,
    direction: Direction,
    center: readonly [number, number],
    diameter: number,
    bottom: Extract<OperationGeometry, { kind: 'drilling' }>['bottom'],
  ): OperationGeometry => ({ kind: 'drilling', id, direction, onZ: 0, center, diameter, bottom })

  it('drills through from the right face (+x): a hole along x over the whole length', () => {
    // +x frame: origin (L, 0, −T), u = +y, v = +z → centre (30, 10) is y = 30, z = −10
    const e = evaluate(withOp(drill('drill1', '+x', [30, 10], 6, { kind: 'through' })))
    expect(e.surfaces).toEqual(expect.arrayContaining(['drill1.wall', 'stock.side[1]']))
    expect(e.surfaces).not.toContain('drill1.bottom')
    each(e, 'drill1.wall', (c) => {
      const d = Math.hypot(c[1] - 30, c[2] + 10)
      expect(d).toBeLessThanOrEqual(3 + 1e-4)
      expect(d).toBeGreaterThanOrEqual(3 - CHORD_TOLERANCE)
      expect(c[0]).toBeGreaterThan(-1e-4)
      expect(c[0]).toBeLessThan(T.length + 1e-4)
    })
    const exact = T.length * T.width * T.thickness - Math.PI * 9 * T.length
    expect(e.volume).toBeGreaterThanOrEqual(exact)
    expect(e.volume - exact).toBeLessThan(2 * CHORD_TOLERANCE * 2 * Math.PI * 3 * T.length)
    expect(e.pieces).toBe(1)
  })

  it('drills a flat hole from the front face (−y) to its depth along y', () => {
    // −y frame: origin (0, 0, −T), u = +x, v = +z; depth 15 ends at y = 15
    const e = evaluate(withOp(drill('drill1', '-y', [40, 12], 5, { kind: 'flat', depth: 15 })))
    each(e, 'drill1.bottom', (c) => expect(c[1]).toBeCloseTo(15, 4))
    each(e, 'drill1.wall', (c) => {
      expect(Math.hypot(c[0] - 40, c[2] + 8)).toBeCloseTo(2.5, 1)
      expect(c[1]).toBeLessThan(15 + 1e-4)
    })
  })

  it('pockets the bottom face (−z): floor, walls and fillet in the bottom frame', () => {
    // −z frame: origin (0, W, −T), u = +x, v = −y → centre (50, 20) is x = 50, y = 40;
    // the floor (local z = −5) is z = −T + 5; wall[0] (lowest v) is the highest y
    const e = evaluate(
      withOp({
        kind: 'pocket',
        id: 'pocket1',
        direction: '-z',
        onZ: 0,
        shape: {
          center: [50, 20],
          contour: { kind: 'rectangle', length: 40, width: 16, cornerRadius: 4 },
        },
        depth: 5,
        floorRadius: 2,
      }),
    )
    for (const id of ['floor', 'floorFillet', 'wall[0]', 'wall[1]', 'corner[0]'])
      expect(e.surfaces).toContain(`pocket1.${id}`)
    expect(e.surfaces).toContain('stock.bottom')
    each(e, 'pocket1.floor', (c) => expect(c[2]).toBeCloseTo(-15, 4))
    each(e, 'pocket1.wall[0]', (c) => expect(c[1]).toBeCloseTo(48, 4))
    each(e, 'pocket1.wall[1]', (c) => expect(c[0]).toBeCloseTo(70, 4))
    each(e, 'pocket1.wall[2]', (c) => expect(c[1]).toBeCloseTo(32, 4))
    for (const id of ['pocket1.wall[0]', 'pocket1.floorFillet'])
      each(e, id, (c) => expect(c[2]).toBeLessThan(-15 + 2 + 3 + 1e-4))
    const exact = T.length * T.width * T.thickness - pocketVolume(40, 16, 4, 5, 2)
    expect(e.volume).toBeGreaterThanOrEqual(exact - 1e-6)
    expect(e.volume - exact).toBeLessThan(5)
  })

  it('pockets a side face (−x) on a level below the stock face', () => {
    // −x frame: origin (0, W, −T), u = −y, v = +z; on 1 mm in (onZ −1), depth 4 → floor x = 5
    const e = evaluate(
      withOp({
        kind: 'pocket',
        id: 'pocket1',
        direction: '-x',
        onZ: -1,
        shape: { center: [20, 10], contour: { kind: 'circle', radius: 5 } },
        depth: 4,
        floorRadius: 0,
      }),
    )
    each(e, 'pocket1.floor', (c) => {
      expect(c[0]).toBeCloseTo(5, 4)
      expect(Math.hypot(c[1] - 40, c[2] + 10)).toBeLessThan(5 + 1e-4)
    })
    expect(e.volume).toBeCloseTo(T.length * T.width * T.thickness - Math.PI * 25 * 5, -1)
  })

  it('faces the bottom and profiles a side face with tabs measured up from the opposite face', () => {
    const e = evaluate({
      stock: T,
      operations: [
        { kind: 'facing', id: 'facing1', direction: '-z', depth: 1.5 },
        {
          kind: 'profile',
          id: 'profile1',
          direction: '+y',
          shape: {
            center: [50, 10],
            contour: { kind: 'rectangle', length: 30, width: 10, cornerRadius: 2 },
          },
          side: 'inside',
          slotWidth: 3,
          tabs: { count: 2, width: 4, thickness: 6 },
        },
      ],
    })
    expect(e.surfaces).not.toContain('stock.bottom')
    each(e, 'facing1.floor', (c) => expect(c[2]).toBeCloseTo(-T.thickness + 1.5, 4))
    // +y frame: n = +y, the opposite face is y = 0, so a tab top is the plane y = 6
    for (const i of [0, 1]) each(e, `profile1.tab[${i}].top`, (c) => expect(c[1]).toBeCloseTo(6, 4))
    expect(e.surfaces).toContain('profile1.wall[0]')
    expect(e.pieces).toBe(1)
  })

  it('composes removals from four directions that overlap and meet on near-coincident planes', () => {
    // 12.7 thick: the side pocket's upper wall is −12.7 + 5 (≠ −7.7 in float64) against the
    // top pocket's floor at −7.7, so the two meet on almost the same plane (a sliver case)
    const stock = { length: 80, width: 50, thickness: 12.7 }
    const input: PartGeometryInput = {
      stock,
      operations: [
        {
          kind: 'pocket',
          id: 'top',
          onZ: 0,
          shape: {
            center: [40, 25],
            contour: { kind: 'rectangle', length: 30, width: 20, cornerRadius: 3 },
          },
          depth: 7.7,
          floorRadius: 0,
        },
        {
          kind: 'pocket',
          id: 'side',
          direction: '-y',
          onZ: 0,
          shape: {
            center: [40, 2.5],
            contour: { kind: 'rectangle', length: 20, width: 5, cornerRadius: 0 },
          },
          depth: 30,
          floorRadius: 0,
        },
        {
          kind: 'pocket',
          id: 'bottom',
          direction: '-z',
          onZ: 0,
          shape: { center: [40, 25], contour: { kind: 'circle', radius: 6 } },
          depth: 12.7 - 7.7,
          floorRadius: 0,
        },
        drill('cross', '+x', [25, 12.7 - 3.85], 4, { kind: 'through' }),
      ],
    }
    const e = evaluate(input)
    for (const id of ['top.wall[0]', 'side.wall[2]', 'bottom.wall[0]', 'cross.wall'])
      expect(e.surfaces, id).toContain(id)
    // the bottom pocket opens into the top one (coincident floors): its floor never survives
    expect(e.surfaces).toContain('top.floor')
    expect(e.surfaces).not.toContain('bottom.floor')
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
    expect(
      signedVolume({ positions: Float64Array.from(e.positions), triangles: e.indices }),
    ).toBeCloseTo(e.volume, 0)
    expect(kernel.liveObjects()).toBe(0)
  })

  it('runs the retainedRemoved boolean for removals of another direction', () => {
    const fillet: OperationGeometry = {
      kind: 'pocket',
      id: 'pocket1',
      onZ: 0,
      shape: {
        center: [50, 30],
        contour: { kind: 'rectangle', length: 40, width: 24, cornerRadius: 4 },
      },
      depth: 8,
      floorRadius: 3,
    }
    // +x frame: v = z + T, so v = 13.5 is z = −6.5, inside the fillet zone (z −8..−5)
    const through = evaluate({
      stock: T,
      operations: [fillet, drill('drill1', '+x', [30, 13.5], 2, { kind: 'through' })],
    })
    expect(through.warnings.map((w) => [w.code, w.operation, w.params['by']])).toEqual([
      ['dfm.retainedRemoved', 'pocket1', 'drill1'],
    ])
    // below the floor (z = −12): clear
    const below = evaluate({
      stock: T,
      operations: [fillet, drill('drill1', '+x', [30, 8], 2, { kind: 'through' })],
    })
    expect(below.warnings).toEqual([])
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

  it('evaluates 30 random mixed-direction parts without error, air triangles or slivers', () => {
    const rand = rng(20261121)
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand()
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const directions = ['+z', '-z', '-y', '+x', '+y', '-x'] as const
    // a non-dyadic stock, so face-frame origins are not exact in float32
    const stock = { length: 83.3, width: 47.1, thickness: 12.7 }
    for (let i = 0; i < 30; i++) {
      const operations: OperationGeometry[] = []
      for (let k = 0; k < 6; k++) {
        const direction = pick(directions)
        const local = localStock(direction, stock)
        const center = [between(0.2, 0.8) * local.length, between(0.2, 0.8) * local.width] as const
        const room = Math.min(local.length, local.width) * 0.3
        if (rand() < 0.5) {
          const length = between(2, room)
          const width = between(2, room)
          const cornerRadius = between(0, Math.min(length, width) / 2)
          const depth = between(0.5, local.thickness * 0.7)
          operations.push({
            kind: 'pocket',
            id: `pocket${k}`,
            direction,
            onZ: 0,
            shape: { center, contour: { kind: 'rectangle', length, width, cornerRadius } },
            depth,
            floorRadius: between(0, Math.min(depth, cornerRadius)),
          })
        } else
          operations.push({
            kind: 'drilling',
            id: `drill${k}`,
            direction,
            onZ: 0,
            center,
            diameter: between(1, room),
            bottom:
              rand() < 0.4
                ? { kind: 'through' }
                : { kind: 'flat', depth: between(1, local.thickness * 0.9) },
          })
      }
      const r = kernel.withSolids((s) => evaluatePart({ stock, operations }, s))
      const ctx = JSON.stringify({ i, operations, err: r.isErr() && r.unwrapErr().toJSON() })
      expect(r.isOk(), ctx).toBe(true)
      expect(r.unwrap().pieces, ctx).toBe(1)
    }
    expect(kernel.liveObjects()).toBe(0)
  })
})
