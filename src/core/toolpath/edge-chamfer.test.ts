// The edge chamfer generator (edge-chamfers.md E1): one ring per loop of the edge's air region
// (the rim and each island), at the bevel's tip Z, swept over a heightmap with the cone tip and
// compared with the bevel (no gouge past it, nothing left on it); path rules, refusals, the
// request round trip and a golden file. Doc: docs/modes/edge-chamfers.md#implementation-e1
import { describe, expect, it } from 'vitest'
import { numberRegion } from '../geometry/2d/place'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { line, regionLoops, type Region } from '../geometry/2d/model'
import type { Vec2 } from '../geometry/model'
import { Ok } from '../../shared/result'
import { circleLoop, roundedRectLoop } from '../geometry/testing/shape-regions'
import type { Toolpath, ToolpathTool } from './model'
import {
  edgeChamferPasses,
  edgeChamferTipZ,
  generateEdgeChamfer,
  NearestStarts,
  type EdgeChamferInput,
  type EdgeChamferOperation,
} from './edge-chamfer'
import { generateRequest, GeneratorRequestSchema } from './request'
import { chamferMill, HEIGHTS, RATES } from './testing/fixtures'
import { Heightmap, render, samples, steps, surfaceOf } from './testing/oracles'
import { violations } from './testing/rules'

const port = nodeRegion2d()
const stock = { length: 60, width: 40, thickness: 10 }

/** A 40 × 24 R3 pocket at (10..50, 8..32) with a Ø 8 island at its centre. */
const AIR: Region = numberRegion({
  pieces: [{ outer: roundedRectLoop(10, 8, 50, 32, 3), holes: [circleLoop([30, 20], 4, false)] }],
})

const op = (over: Partial<EdgeChamferOperation> = {}): EdgeChamferOperation => ({
  kind: 'chamfer',
  id: 'chamfer1',
  onZ: 0,
  edgeOf: 'pocket1',
  edge: { shape: { center: [0, 0], contour: { kind: 'region', region: AIR } }, side: 'inside' },
  width: 1,
  angle: 90,
  ...over,
})

const input = (
  tool: ToolpathTool = chamferMill(6, 90, 0),
  over: Partial<EdgeChamferOperation> = {},
  direction: 'climb' | 'conventional' = 'climb',
): EdgeChamferInput => ({
  planOperationId: 'op-chamfer1',
  tool,
  cutting: { spindleSpeed: 16000, feedRate: 800, plungeRate: 200 },
  heights: HEIGHTS,
  stock,
  operation: op(over),
  strategy: { direction },
  maxFeedRate: RATES,
})

const edgeDistance = (p: Vec2): number => port.distance(regionLoops(AIR), p)!.distance

/** The heightmap after the toolpath vs the bevel: depth below the face = (w − d) / tan(α/2). */
function checkSurface(i: EdgeChamferInput, tol: number): void {
  const o = i.operation
  const tp = generateEdgeChamfer(i, port).unwrap()
  const tipR = (i.tool.tipDiameter ?? 0) / 2
  expect(
    violations(tp, {
      feedRate: i.cutting.feedRate,
      plungeRate: i.cutting.plungeRate,
      verticalAtMostPlunge: true,
      retractZ: o.onZ + i.heights.retractHeight,
      clearanceZ: i.heights.clearanceHeight,
      targetZ: edgeChamferTipZ(o),
      // the tip stays in the air, a tip radius from the edge
      contains: (p) =>
        p[2] > o.onZ ||
        (port.contains(AIR, [p[0], p[1]]) && edgeDistance([p[0], p[1]]) >= tipR - 1e-6),
    }),
  ).toEqual([])
  const map = new Heightmap(stock.length, stock.width, 0.08)
  map.z.fill(o.onZ)
  map.sweep(i.tool, tp, 0.04)
  const tan = Math.tan((o.angle * Math.PI) / 360)
  const wrong: string[] = []
  for (let a = 0; a < map.nx; a++)
    for (let b = 0; b < map.ny; b++) {
      const [x, y] = map.center(a, b)
      if (port.contains(AIR, [x, y])) continue
      const d = edgeDistance([x, y])
      const h = map.z[b * map.nx + a]!
      const bevel = d >= o.width ? o.onZ : o.onZ - (o.width - d) / tan
      if (h < bevel - 1e-6) wrong.push(`gouge at ${x},${y}: ${h} < ${bevel}`)
      if (h > bevel + tol) wrong.push(`left at ${x},${y}: ${h} > ${bevel}`)
    }
  expect(wrong.slice(0, 3)).toEqual([])
}

describe('generateEdgeChamfer', () => {
  it('a pointed 90° bit: the rim and the island, the bevel within a cell', () => {
    checkSurface(input(), 0.12)
  })

  it('a 60° bit with a 0.4 tip, conventional', () => {
    checkSurface(input(chamferMill(8, 60, 0.4), { angle: 60, width: 0.8 }, 'conventional'), 0.2)
  })

  it('one ring per loop, one finish pass, at tip Z = face − w / tan(α/2)', () => {
    const tp = generateEdgeChamfer(input(), port).unwrap()
    expect(tp.passes.map((p) => p.kind)).toEqual(['finish'])
    const moves = tp.passes[0]!.moves
    const plunges = moves.flatMap((m, k) =>
      m.kind === 'line' && moves[k - 1]?.kind === 'rapid' ? [m.to[2]] : [],
    )
    expect(plunges).toHaveLength(2)
    for (const z of plunges) expect(z).toBeCloseTo(-1, 9)
  })

  it('refuses a drill, a wrong angle and a tool without a cutting edge', () => {
    const rules = (i: EdgeChamferInput) =>
      generateEdgeChamfer(i, port)
        .unwrapErr()
        .issues.map((x) => x.rule)
    expect(rules(input({ ...chamferMill(6), type: 'drill' }))).toContain('toolType')
    expect(rules(input(chamferMill(6, 60)))).toContain('angle')
    // E4a: a bevel wider than the cutting edge is cut in levels; no cutting edge at all is refused
    expect(rules(input(chamferMill(6, 90, 6)))).toContain('slant')
    expect(generateEdgeChamfer(input(chamferMill(6, 90, 0), { width: 3.5 }), port).isOk()).toBe(
      true,
    )
  })

  it('goes through the request schema and the generator switch', () => {
    const request = GeneratorRequestSchema.parse({ kind: 'edgeChamfer', inputs: [input()] })
    expect(generateRequest(request, undefined, () => Ok(port)).unwrap().passes).toHaveLength(1)
  })

  it('golden: a pocket with an island, 1 × 45°', async () => {
    await expect(render(generateEdgeChamfer(input(), port).unwrap())).toMatchFileSnapshot(
      '__golden__/edge-chamfer-island.txt',
    )
  })
})

// ── E2: outside edges (docs/modes/edge-chamfers.md#implementation-e2) ─────────────────────────

/** A 30 × 20 R2 part at (15..45, 10..30), profiled outside. */
const PART: Region = numberRegion({
  pieces: [{ outer: roundedRectLoop(15, 10, 45, 30, 2), holes: [] }],
})

const outside = (
  over: Partial<EdgeChamferOperation['edge']> = {},
): Partial<EdgeChamferOperation> => ({
  edgeOf: 'profile1',
  edge: {
    shape: { center: [0, 0], contour: { kind: 'region', region: PART } },
    side: 'outside',
    ...over,
  },
})

const partDistance = (p: Vec2): number => port.distance(regionLoops(PART), p)!.distance

/** The cut points (feed moves) of a toolpath. */
const cutPoints = (i: EdgeChamferInput) =>
  generateEdgeChamfer(i, port)
    .unwrap()
    .passes.flatMap((p) => p.moves.filter((m) => m.kind === 'line' || m.kind === 'arc'))

describe('generateEdgeChamfer (E2, outside edges)', () => {
  it('the bevel round the part, the tip in the air, within a cell of the heightmap', () => {
    const i = input(chamferMill(6, 90, 0.2), { ...outside(), width: 1.2 })
    const o = i.operation
    const tp = generateEdgeChamfer(i, port).unwrap()
    expect(
      violations(tp, {
        feedRate: i.cutting.feedRate,
        plungeRate: i.cutting.plungeRate,
        verticalAtMostPlunge: true,
        retractZ: o.onZ + i.heights.retractHeight,
        clearanceZ: i.heights.clearanceHeight,
        targetZ: edgeChamferTipZ(o),
        contains: (p) =>
          p[2] > o.onZ ||
          (!port.contains(PART, [p[0], p[1]]) && partDistance([p[0], p[1]]) >= 0.1 - 1e-6),
      }),
    ).toEqual([])
    const map = new Heightmap(stock.length, stock.width, 0.08)
    map.z.fill(o.onZ)
    map.sweep(i.tool, tp, 0.04)
    const wrong: string[] = []
    for (let a = 0; a < map.nx; a++)
      for (let b = 0; b < map.ny; b++) {
        const [x, y] = map.center(a, b)
        if (!port.contains(PART, [x, y])) continue
        const d = partDistance([x, y])
        const h = map.z[b * map.nx + a]!
        const bevel = d >= o.width ? o.onZ : o.onZ - (o.width - d)
        if (h < bevel - 1e-6) wrong.push(`gouge at ${x},${y}: ${h} < ${bevel}`)
        if (h > bevel + 0.12) wrong.push(`left at ${x},${y}: ${h} > ${bevel}`)
      }
    expect(wrong.slice(0, 3)).toEqual([])
  })

  it('climb runs clockwise round the part, conventional counter-clockwise', () => {
    const turn = (direction: 'climb' | 'conventional') => {
      const pts = cutPoints(input(undefined, outside(), direction))
        .slice(1)
        .map((m) => m.to)
      let a = 0
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]!
        const q = pts[(k + 1) % pts.length]!
        a += p[0] * q[1] - q[0] * p[1]
      }
      return Math.sign(a)
    }
    expect(turn('climb')).toBe(-1)
    expect(turn('conventional')).toBe(1)
  })

  it('a split piece (`within`): open runs along the real edges only, past the cell by the reach', () => {
    const i = input(chamferMill(6, 90, 0), outside({ within: { min: [0, 0], max: [30, 40] } }))
    const tp = generateEdgeChamfer(i, port).unwrap()
    const moves = tp.passes[0]!.moves
    // one open run: the front, the left edge and the back up to x = 30 + reach (one plunge)
    const plunges = moves.filter((m, k) => m.kind === 'line' && moves[k - 1]?.kind === 'rapid')
    expect(plunges).toHaveLength(1)
    const xs = moves.flatMap((m) => (m.kind === 'line' || m.kind === 'arc' ? [m.to[0]] : []))
    expect(Math.max(...xs)).toBeCloseTo(30 + 1, 6)
    // a pointed tip runs on the part's left edge itself
    expect(Math.min(...xs)).toBeCloseTo(15, 6)
  })

  it('golden: a part outline, 1 × 45°, climb', async () => {
    await expect(
      render(generateEdgeChamfer(input(undefined, outside()), port).unwrap()),
    ).toMatchFileSnapshot('__golden__/edge-chamfer-outside.txt')
  })
})

// ── E4a: several passes, corner lift, chosen loops (docs/modes/edge-chamfers.md#implementation-e4a)

/** A sharp 40 × 24 pocket at (10..50, 8..32) with a Ø 8 island at its centre. */
const SHARP: Region = numberRegion({
  pieces: [
    {
      outer: {
        elements: [
          line([10, 8], [50, 8]),
          line([50, 8], [50, 32]),
          line([50, 32], [10, 32]),
          line([10, 32], [10, 8]),
        ],
      },
      holes: [circleLoop([30, 20], 4, false)],
    },
  ],
})

const sharp = (
  over: Partial<EdgeChamferOperation['edge']> = {},
): Partial<EdgeChamferOperation> => ({
  edge: {
    shape: { center: [0, 0], contour: { kind: 'region', region: SHARP } },
    side: 'inside',
    ...over,
  },
})

/** Material beyond the rim: its distance outside the rectangle, Euclidean or (mitre) Chebyshev. */
function rimDistance(p: Vec2, mitre: boolean): number {
  const dx = Math.max(0, 10 - p[0], p[0] - 50)
  const dy = Math.max(0, 8 - p[1], p[1] - 32)
  return mitre ? Math.max(dx, dy) : Math.hypot(dx, dy)
}

/**
 * The heightmap after `tp` (tip and cone, no shank) against a bevel given by the material
 * distance `d` of a cell (undefined = air or not checked): gouges and material left over `tol`.
 * With `shank`, also every cell under the tool above its cutting edge (the shank would rub it).
 */
function bevelErrors(
  i: EdgeChamferInput,
  tp: Toolpath,
  d: (p: Vec2) => number | undefined,
  tol: number,
): string[] {
  const o = i.operation
  const map = new Heightmap(stock.length, stock.width, 0.08)
  map.z.fill(o.onZ)
  const tan = Math.tan((o.angle * Math.PI) / 360)
  const R = i.tool.diameter / 2
  const edge = (i.tool.diameter - (i.tool.tipDiameter ?? 0)) / 2 / tan
  const wrong: string[] = []
  // The shank check and the stamp in one pass over the cells under the tool, row by row and
  // without an array per cell: the same numbers as `map.center` and `map.stamp`
  // (this oracle was the whole test time; docs/conventions/testing.md#load-stable-tests).
  const { cell, nx, z } = map
  const shankReach = R - cell
  const surface = surfaceOf(i.tool)
  for (const s of steps(tp)) {
    if (s.move.kind === 'rapid') continue
    for (const p of samples(s, 0.04)) {
      const a0 = Math.max(0, Math.floor((p[0] - R) / cell))
      const a1 = Math.min(nx - 1, Math.ceil((p[0] + R) / cell))
      const b0 = Math.max(0, Math.floor((p[1] - R) / cell))
      const b1 = Math.min(map.ny - 1, Math.ceil((p[1] + R) / cell))
      const rub = p[2] + edge + 0.05
      for (let b = b0; b <= b1; b++) {
        const y = (b + 0.5) * cell
        const dy2 = (y - p[1]) ** 2
        const row = b * nx
        for (let a = a0; a <= a1; a++) {
          const x = (a + 0.5) * cell
          const rho = Math.sqrt((x - p[0]) ** 2 + dy2)
          // the shank: nothing above the cutting edge within DC (before this sample cuts)
          if (rho <= shankReach && z[row + a]! > rub && wrong.length < 3)
            wrong.push(`shank at ${x},${y} over ${p.join(',')}`)
          const h = p[2] + surface(rho)
          if (h < z[row + a]!) z[row + a] = h
        }
      }
    }
  }
  for (let a = 0; a < map.nx; a++)
    for (let b = 0; b < map.ny; b++) {
      const [x, y] = map.center(a, b)
      const dist = d([x, y])
      if (dist === undefined) continue
      const h = map.z[b * map.nx + a]!
      const bevel = dist >= o.width ? o.onZ : o.onZ - (o.width - dist) / tan
      if (h < bevel - 1e-6) wrong.push(`gouge at ${x},${y}: ${h} < ${bevel}`)
      if (h > bevel + tol) wrong.push(`left at ${x},${y}: ${h} > ${bevel}`)
    }
  return wrong.slice(0, 3)
}

describe('generateEdgeChamfer (E4a)', () => {
  it('edgeChamferPasses: one ring when the cutting edge covers the bevel, else levels', () => {
    const r3 = (x: number) => Math.round(x * 1e9) / 1e9 + 0
    const view = (ls: ReturnType<typeof edgeChamferPasses>) =>
      ls.map((l) => l.map((r) => [r3(r.offset), r3(r.depth), r.bevel]))
    expect(view(edgeChamferPasses({ width: 3, angle: 90 }, { diameter: 6 }))).toEqual([
      [[0, 3, true]],
    ])
    // c = 2, cusp 1, Δ = 1: three levels, each from the edge out to the bevel ring
    expect(view(edgeChamferPasses({ width: 3, angle: 90 }, { diameter: 4 }))).toEqual([
      [
        [0, 1, false],
        [-2, 1, true],
      ],
      [
        [0, 2, false],
        [-1, 2, true],
      ],
      [[0, 3, true]],
    ])
    // a tip: the edge ring dt/2 in the air, the last level the E1 ring
    const tipped = edgeChamferPasses({ width: 2, angle: 90 }, { diameter: 3, tipDiameter: 0.4 })
    expect(view([tipped.at(-1)!])).toEqual([[[0.2, 2, true]]])
    for (const l of tipped) {
      expect(l[0]!.offset).toBe(0.2)
      for (let j = 1; j < l.length; j++)
        expect(l[j - 1]!.offset - l[j]!.offset).toBeLessThanOrEqual(1.3 + 1e-9)
    }
    expect(edgeChamferPasses({ width: 1, angle: 90 }, { diameter: 2, tipDiameter: 2 })).toEqual([])
  })

  it('a 3 mm bevel with a Ø 4 V-bit: three levels, rough and finish, the bevel exact, no shank rub', () => {
    const i = input(chamferMill(4, 90, 0), { width: 3 })
    const tp = generateEdgeChamfer(i, port).unwrap()
    // per level the edge ring (rough), then the bevel ring (finish); the last level one ring
    expect(tp.passes.map((p) => p.kind)).toEqual(['rough', 'finish', 'rough', 'finish'])
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-3, 9)
    const d = (p: Vec2) => (port.contains(AIR, p) ? undefined : edgeDistance(p))
    expect(bevelErrors(i, tp, d, 0.15)).toEqual([])
  })

  it('a tipped 60° bit in levels, conventional: the bevel exact, no shank rub', () => {
    const i = input(chamferMill(3, 60, 0.4), { angle: 60, width: 1.6 }, 'conventional')
    const tp = generateEdgeChamfer(i, port).unwrap()
    const d = (p: Vec2) => (port.contains(AIR, p) ? undefined : edgeDistance(p))
    expect(bevelErrors(i, tp, d, 0.2)).toEqual([])
  })

  it('corner lift: the sharp corners meet in a mitre; without it the cone stays', () => {
    const rim = (p: Vec2) =>
      Math.hypot(p[0] - 30, p[1] - 20) < 4 + 1.2 || port.contains(SHARP, p)
        ? undefined
        : rimDistance(p, true)
    const lifted = input(chamferMill(6, 90, 0), { ...sharp(), cornerLift: true })
    const tp = generateEdgeChamfer(lifted, port).unwrap()
    expect(bevelErrors(lifted, tp, rim, 0.12)).toEqual([])
    // four lifts up to the face on the rim, none round the island
    const tops = tp.passes.flatMap((p) =>
      p.moves.flatMap((m) => (m.kind === 'line' && m.to[2] === 0 ? [m] : [])),
    )
    expect(tops).toHaveLength(4)
    expect(tops.map((m) => m.to.slice(0, 2))).toContainEqual([9, 7])
    const plain = input(chamferMill(6, 90, 0), sharp())
    const left = bevelErrors(plain, generateEdgeChamfer(plain, port).unwrap(), rim, 0.12)
    expect(left.some((e) => e.startsWith('left'))).toBe(true)
  })

  it('corner lift in levels with a tip: the mitre exact, no shank rub', () => {
    const i = input(chamferMill(3, 90, 0.4), { ...sharp(), width: 2, cornerLift: true })
    const tp = generateEdgeChamfer(i, port).unwrap()
    const rim = (p: Vec2) =>
      Math.hypot(p[0] - 30, p[1] - 20) < 4 + 2.5 || port.contains(SHARP, p)
        ? undefined
        : rimDistance(p, true)
    expect(bevelErrors(i, tp, rim, 0.15)).toEqual([])
  })

  it('chosen loops: the rim only leaves the island sharp, the island only the rim', () => {
    const island = (p: Vec2) => Math.hypot(p[0] - 30, p[1] - 20) <= 4
    const rimOnly = input(chamferMill(6, 90, 0), sharp({ loops: [0] }))
    const tp = generateEdgeChamfer(rimOnly, port).unwrap()
    const map = new Heightmap(stock.length, stock.width, 0.08)
    map.sweep(rimOnly.tool, tp, 0.04)
    let islandCut = 0
    for (let a = 0; a < map.nx; a++)
      for (let b = 0; b < map.ny; b++)
        if (island(map.center(a, b)) && map.z[b * map.nx + a]! < -1e-9) islandCut++
    expect(islandCut).toBe(0)
    expect(
      bevelErrors(
        rimOnly,
        tp,
        (p) => (port.contains(SHARP, p) || island(p) ? undefined : rimDistance(p, false)),
        0.12,
      ),
    ).toEqual([])
    const islandOnly = generateEdgeChamfer(
      input(chamferMill(6, 90, 0), sharp({ loops: [1] })),
      port,
    )
    const xs = islandOnly
      .unwrap()
      .passes.flatMap((p) => p.moves.flatMap((m) => (m.kind === 'drill' ? [] : [m.to[0]])))
    expect(Math.min(...xs)).toBeGreaterThan(25)
    expect(Math.max(...xs)).toBeLessThan(35)
  })

  it('golden: several passes, corner lift, the rim of a pocket with an island', async () => {
    const i = input(chamferMill(4, 90, 0), { ...sharp({ loops: [0] }), width: 3, cornerLift: true })
    await expect(render(generateEdgeChamfer(i, port).unwrap())).toMatchFileSnapshot(
      '__golden__/edge-chamfer-passes.txt',
    )
  })
})

// ── E4b: bottom edges, the step-in (docs/modes/edge-chamfers.md#implementation-e4b) ───────────

describe('generateEdgeChamfer (E4b)', () => {
  /** Plunges: feed moves straight down from a rapid. */
  const plunges = (tp: Toolpath) =>
    tp.passes.flatMap((p) =>
      p.moves.flatMap((m, k) => {
        const prev = p.moves[k - 1]
        if (m.kind !== 'line' || prev?.kind !== 'rapid') return []
        return m.to[0] === prev.to[0] && m.to[1] === prev.to[1] ? [m] : []
      }),
    )

  it('levels: every ring is entered by a plunge in the air, then a step in at depth', () => {
    for (const i of [
      input(chamferMill(4, 90, 0), { width: 3 }),
      input(chamferMill(3, 90, 0.4), { ...sharp(), width: 2, cornerLift: true }),
    ]) {
      const tp = generateEdgeChamfer(i, port).unwrap()
      const air = (i.operation.edge.shape.contour as { region: Region }).region
      const r0 = (i.tool.tipDiameter ?? 0) / 2
      const ps = plunges(tp)
      expect(ps.length).toBeGreaterThan(2)
      for (const m of ps) {
        const p: Vec2 = [m.to[0], m.to[1]]
        expect(port.contains(air, p), p.join(',')).toBe(true)
        expect(port.distance(regionLoops(air), p)!.distance).toBeGreaterThan(r0 - 1e-6)
      }
    }
  })

  it('tabs: the rings lift over each tab, open runs plunged beside it', () => {
    const tabs = [
      { at: [30, 10] as const, width: 6 },
      { at: [30, 30] as const, width: 6 },
    ]
    const i = input(chamferMill(6, 90, 0.2), { ...outside({ tabs }), width: 1 })
    const tp = generateEdgeChamfer(i, port).unwrap()
    const gap = 3 + 1 + 0.1 + 1
    const cuts = tp.passes.flatMap((p) =>
      p.moves.filter((m) => m.kind === 'line' || m.kind === 'arc').map((m) => m.to),
    )
    // along the front and back walls nothing within the gap of a tab centre
    for (const p of cuts.filter((q) => q[2] < -1e-9 && q[0] > 17 && q[0] < 43))
      for (const t of tabs)
        if (Math.abs(p[1] - t.at[1]) < 1)
          expect(Math.abs(p[0] - t.at[0]), p.join(',')).toBeGreaterThan(gap - 1e-6)
    // two runs, the right half and the left half, each plunged beside a tab
    const ps = plunges(tp)
    expect(ps).toHaveLength(2)
    for (const m of ps) expect(Math.abs(Math.abs(m.to[0] - 30) - gap)).toBeLessThan(1e-6)
  })
})

describe('NearestStarts (patterns P3)', () => {
  it('takes the same nearest-neighbour order as a linear scan', () => {
    // a jittered lattice, from a tool far outside it; ties to the lower index
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    const points: Vec2[] = []
    for (let i = 0; i < 30; i++)
      for (let j = 0; j < 20; j++) points.push([i * 4 + rnd() * 0.5, j * 3.5 + rnd() * 0.5])
    points.push([8, 7], [8, 7])
    const index = new NearestStarts(points)
    const left = points.map((_, i) => i)
    const d = (k: number, p: Vec2) => Math.hypot(points[k]![0] - p[0], points[k]![1] - p[1])
    let here: Vec2 = [-50, 200]
    for (let n = 0; n < points.length; n++) {
      let best = 0
      left.forEach((k, i) => {
        if (d(k, here) < d(left[best]!, here)) best = i
      })
      const want = left.splice(best, 1)[0]!
      expect(index.take(here)).toBe(want)
      here = points[want]!
    }
    expect(index.take(here)).toBe(-1)
  })
})
