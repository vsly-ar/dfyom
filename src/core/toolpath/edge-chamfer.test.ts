// The edge chamfer generator (edge-chamfers.md E1): one ring per loop of the edge's air region
// (the rim and each island), at the bevel's tip Z, swept over a heightmap with the cone tip and
// compared with the bevel (no gouge past it, nothing left on it); path rules, refusals, the
// request round trip and a golden file. Doc: docs/modes/edge-chamfers.md#implementation-e1
import { describe, expect, it } from 'vitest'
import { numberRegion } from '../geometry/2d/place'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { regionLoops, type Region } from '../geometry/2d/model'
import type { Vec2 } from '../geometry/model'
import { Ok } from '../../shared/result'
import { circleLoop, roundedRectLoop } from '../geometry/testing/shape-regions'
import type { ToolpathTool } from './model'
import {
  edgeChamferTipZ,
  generateEdgeChamfer,
  type EdgeChamferInput,
  type EdgeChamferOperation,
} from './edge-chamfer'
import { generateRequest, GeneratorRequestSchema } from './request'
import { chamferMill, HEIGHTS, RATES } from './testing/fixtures'
import { Heightmap, render } from './testing/oracles'
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

  it('refuses a drill, a wrong angle and a cutting edge shorter than the slant', () => {
    const rules = (i: EdgeChamferInput) =>
      generateEdgeChamfer(i, port)
        .unwrapErr()
        .issues.map((x) => x.rule)
    expect(rules(input({ ...chamferMill(6), type: 'drill' }))).toContain('toolType')
    expect(rules(input(chamferMill(6, 60)))).toContain('angle')
    expect(rules(input(chamferMill(6, 90, 0), { width: 3.5 }))).toContain('slant')
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
