import { describe, expect, it } from 'vitest'
import type { Vec2, Vec3 } from '../geometry/model'
import {
  chainBounds,
  line,
  regionArea,
  regionLoops,
  reverseLoop,
  signedArea,
  type Loop,
  type Region,
} from '../geometry/2d/model'
import { circle, dumbbell, hole, rect, star } from '../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { maxOffsetError } from '../geometry/2d/testing/oracles'
import { aborted } from '../workers/steps'
import type { PocketStrategy, Toolpath, ToolpathTool } from './model'
import { segLength, segPoint, type Seg } from './path'
import { clipRing, restArea } from './region-rest'
import {
  clearingStep,
  generateRegionPocket,
  pruneCleared,
  restInside,
  stepoverClamped,
  type RegionPocketInput,
} from './region-pocket'
import {
  elementSeg,
  loopRing,
  ringClosest,
  ringFrom,
  ringTree,
  segmentHits,
  linkInside,
  walkTree,
  type RingNode,
} from './region-rings'
import { findRestMaterial } from '../geometry/2d/rest-material'
import { arcSweep } from './stats'
import { bullNose, cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'
import {
  airCut,
  heightDifference,
  placeLoops,
  pocketRapids,
  regionCoverage,
} from './testing/region-coverage'
import { steps as walk } from './testing/oracles'
import { cuttingLevels, stepsWithin, violations } from './testing/rules'

const port = nodeRegion2d()
const D6 = endMill(6)
const R = 3

const strategy = (over: Partial<PocketStrategy> = {}): PocketStrategy => ({
  entry: 'helix',
  helixDiameter: 0.8 * 6,
  rampAngle: 3,
  finishAllowance: 0.2,
  finishStepdown: 4,
  direction: 'climb',
  ...over,
})

function input(
  region: Region,
  opts: {
    tool?: ToolpathTool
    depth?: number
    stepover?: number
    stepdown?: number
    strategy?: Partial<PocketStrategy>
  } = {},
): RegionPocketInput {
  const tool = opts.tool ?? D6
  const depth = opts.depth ?? 4
  return {
    planOperationId: 'op-pocket',
    tool,
    cutting: cutting(tool, {
      ...(opts.stepover === undefined ? {} : { stepover: opts.stepover }),
      ...(opts.stepdown === undefined ? {} : { stepdown: opts.stepdown }),
    }),
    heights: HEIGHTS,
    stock: { length: 300, width: 300, thickness: 20 },
    operation: { region, onZ: 0, depth },
    strategy: strategy({ finishStepdown: depth, ...opts.strategy }),
    maxFeedRate: RATES,
  }
}

const norm = (loops: Loop[]): Region => port.normalise(loops).unwrap()
const placed = (loops: Loop[]) => {
  const p = placeLoops(loops)
  return { region: norm(p.loops), size: p.size }
}

/** Isosceles triangle with apex angle `deg` (S4's acute-corner case). */
function triangle(deg: number, base: number): Loop {
  const h = base / 2 / Math.tan((deg * Math.PI) / 360)
  const a: Vec2 = [0, 0]
  const b: Vec2 = [base, 0]
  const c: Vec2 = [base / 2, h]
  return { elements: [line(a, b), line(b, c), line(c, a)] }
}

/**
 * The cavity of `src/core/design/__fixtures__/enclosure-sections.svg` (X0) as a counter-clockwise
 * loop of lines, its cubic Béziers flattened to 24 lines each (the SVG importer arrives with I1).
 */
function enclosureCavity(): Loop {
  const proc = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process
  const svg = proc
    .getBuiltinModule('node:fs')
    .readFileSync(new URL('../design/__fixtures__/enclosure-sections.svg', import.meta.url), 'utf8')
  const d = /id="cavity"[^>]* d="([^"]+)"/.exec(svg)![1]!
  const tokens = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/g)!
  const pts: Vec2[] = []
  let cmd = ''
  let i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[MLCZ]/.test(tokens[i]!)) cmd = tokens[i++]!
    if (cmd === 'Z') break
    if (cmd === 'M' || cmd === 'L') pts.push([num(), num()])
    else {
      const p0 = pts.at(-1)!
      const c1: Vec2 = [num(), num()]
      const c2: Vec2 = [num(), num()]
      const p3: Vec2 = [num(), num()]
      for (let k = 1; k <= 24; k++) {
        const t = k / 24
        const u = 1 - t
        const f = (j: 0 | 1) =>
          u * u * u * p0[j] + 3 * u * u * t * c1[j] + 3 * u * t * t * c2[j] + t * t * t * p3[j]
        pts.push([f(0), f(1)])
      }
    }
  }
  const last = pts.at(-1)!
  if (Math.hypot(last[0] - pts[0]![0], last[1] - pts[0]![1]) < 1e-9) pts.pop()
  const elements = pts.map((p, k) => line(p, pts[(k + 1) % pts.length]!))
  const l: Loop = { elements }
  return signedArea(l) > 0 ? l : reverseLoop(l)
}

const twoIslands = (): Loop[] => [
  rect(0, 0, 120, 80, 6),
  hole(circle(35, 40, 10)),
  hole(rect(70, 25, 30, 30, 4)),
]

/**
 * Generic rules with the tool centre inside the wall's tool-centre region below the top; rapids
 * below the retract plane (DF136 low entries and links) checked against the material instead.
 */
function checkRules(
  inp: RegionPocketInput,
  tp: Toolpath,
  before?: readonly { tool: ToolpathTool; tp: Toolpath }[],
): string[] {
  const wall = port.offset(inp.operation.region, inp.tool.diameter / 2 - 1e-4).unwrap()
  const floor = inp.operation.onZ - inp.operation.depth
  // a rest pocket's rapids need the roughing that ran before it
  const rapids =
    inp.operation.restAfter === undefined || before !== undefined
      ? pocketRapids(tp, inp, 0.2, before)
      : []
  return [
    ...rapids,
    ...violations(tp, {
      feedRate: inp.cutting.feedRate,
      plungeRate: inp.cutting.plungeRate,
      rampAngle: inp.strategy.rampAngle,
      retractZ: inp.operation.onZ + inp.heights.retractHeight,
      lowRapids: true,
      clearanceZ: inp.heights.clearanceHeight,
      targetZ: floor,
      contains: (p: Vec3) =>
        p[2] > inp.operation.onZ + 1e-9 ||
        (p[2] >= floor - 1e-9 && port.contains(wall, [p[0], p[1]])),
    }),
  ]
}

/** Lifts to the retract plane inside each rough pass, the level's final lift not counted. */
function retractsPerLevel(tp: Toolpath, retractZ: number): number[] {
  return tp.passes
    .filter((p) => p.kind === 'rough')
    .map((p) => {
      let n = 0
      let z = Infinity
      for (const m of p.moves) {
        if (m.kind !== 'drill' && m.kind === 'rapid' && m.to[2] >= retractZ - 1e-9 && z < retractZ)
          n++
        if (m.kind !== 'drill') z = m.to[2]
      }
      return n - 1
    })
}

const treeOf = (region: Region, stepover = 2.4, allowance = 0) =>
  ringTree(
    port,
    port.offset(region, R + allowance).unwrap(),
    R + allowance,
    clearingStep(D6, stepover),
  ).unwrap()

const leavesOf = (t: RingNode[]) => [...walkTree(t)].filter((n) => n.children.length === 0)

describe('clearing step (T-G, T-H)', () => {
  it('is min(stepover, flat radius), clamped above it', () => {
    expect(clearingStep(D6, 2.4)).toBe(2.4)
    expect(stepoverClamped(D6, 2.4)).toBe(false)
    expect(clearingStep(D6, 5.4)).toBe(3)
    expect(stepoverClamped(D6, 5.4)).toBe(true)
    expect(clearingStep(bullNose(6, 1), 2.4)).toBe(2)
  })
})

describe('ring tree', () => {
  it('splits at a neck and restarts the steps per branch', () => {
    const t = treeOf(norm([dumbbell(5)]))
    expect(t).toHaveLength(1)
    const nodes = [...walkTree(t)]
    const split = nodes.find((n) => n.children.length === 2)
    expect(split).toBeDefined()
    expect(leavesOf(t)).toHaveLength(2)
    for (const n of nodes) for (const c of n.children) expect(c.offset).toBeCloseTo(n.offset + 2.4)
  })

  it('merges rings with islands; every child lies one step inside its node (offset oracle)', () => {
    const t = treeOf(norm(twoIslands()))
    const nodes = [...walkTree(t)]
    // S4 at 0.4 D without allowance: 14 nodes, 6 leaves, 21 rings
    expect(nodes.length).toBe(14)
    expect(leavesOf(t)).toHaveLength(6)
    expect(nodes.reduce((s, n) => s + 1 + n.piece.holes.length, 0)).toBe(21)
    for (const n of nodes)
      for (const c of n.children)
        expect(
          maxOffsetError(regionLoops(n.region), regionLoops(c.region), clearingStep(D6, 2.4)),
        ).toBeLessThan(1e-6)
  })

  it('caps the step at R for a large stepover', () => {
    const t = treeOf(norm(twoIslands()), 5.4)
    for (const n of walkTree(t)) for (const c of n.children) expect(c.offset - n.offset).toBe(3)
  })
})

describe('ring helpers', () => {
  it('keeps arcs exact and turns degenerate arcs into lines', () => {
    const s = elementSeg({ kind: 'arc', a: [1, 0], b: [0, 1], centre: [0, 0], ccw: true })!
    expect(s.kind).toBe('arc')
    const tiny = elementSeg({
      kind: 'arc',
      a: [0.004, 0],
      b: [0, 0.004],
      centre: [0, 0],
      ccw: true,
    })!
    expect(tiny.kind).toBe('line')
    const flatArc = elementSeg({
      kind: 'arc',
      a: [100, 0],
      b: [100 * Math.cos(5e-5), 100 * Math.sin(5e-5)],
      centre: [0, 0],
      ccw: true,
    })!
    expect(flatArc.kind).toBe('line')
  })

  it('restarts a ring at its closest point', () => {
    const ring = loopRing(rect(0, 0, 10, 10, 2))
    const p = ringClosest(ring, [5, -3])!
    expect(p.distance).toBeCloseTo(3)
    const r = ringFrom(ring, p.index, p.u)
    expect(segPoint(r[0]!, 0)[0]).toBeCloseTo(5)
    expect(segPoint(r.at(-1)!, 1)[0]).toBeCloseTo(5)
    const total = (x: Seg[]) => x.reduce((s, q) => s + segLength(q), 0)
    expect(total(r)).toBeCloseTo(total(ring))
  })

  it('finds where segments meet lines and arcs; links along a ring stay inside', () => {
    const l: Seg = { kind: 'line', from: [0, -1], to: [0, 1] }
    expect(segmentHits([-1, 0], [1, 0], l)).toEqual([0.5])
    expect(segmentHits([-1, 2], [1, 2], l)).toEqual([])
    expect(segmentHits([0, -2], [0, 2], l)).toEqual([0.25, 0.75]) // collinear overlap
    const arc: Seg = { kind: 'arc', center: [0, 0], radius: 1, start: 0, sweep: Math.PI }
    expect(segmentHits([0, 0], [0, 2], arc)).toEqual([0.5])
    expect(segmentHits([0, 0], [0, -2], arc)).toEqual([]) // the other half circle
    // a square with a square island: along the island's side is inside, across it is not
    const region = norm([rect(0, 0, 30, 30), hole(rect(10, 10, 10, 10))])
    const rings = regionLoops(region).map((x) => loopRing(x))
    expect(linkInside(port, region, rings, [10, 15], [10, 0])).toBe(true)
    expect(linkInside(port, region, rings, [5, 15], [25, 15])).toBe(false)
  })
})

describe('generateRegionPocket', () => {
  it('pocket with two islands: generic rules, levels, links never cross islands', () => {
    const inp = input(norm(twoIslands()), { depth: 4, stepdown: 1.5 })
    const tp = generateRegionPocket(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const levels = cuttingLevels(tp, 'rough')
    expect(levels).toEqual([-4 / 3, -8 / 3, -4].map((z) => expect.closeTo(z, 9)))
    expect(stepsWithin(levels, 0, 1.5)).toBe(true)
    expect(tp.passes.map((p) => p.kind)).toEqual(['rough', 'rough', 'rough', 'finish'])
  })

  it('retracts once per leaf after the first plus once per blocked link', () => {
    const region = norm(twoIslands())
    const inp = input(region, { depth: 2, stepdown: 2, strategy: { finishAllowance: 0 } })
    const tp = generateRegionPocket(inp, port).unwrap()
    const leaves = leavesOf(treeOf(region)).length
    const [n] = retractsPerLevel(tp, 2)
    // S4: 6 leaves, 2 links blocked by an island
    expect(leaves).toBe(6)
    expect(n).toBe(leaves - 1 + 2)
    expect(tp.passes).toHaveLength(1)
  })

  it('a single branch needs no retract within a level (triangle, neck)', () => {
    for (const loops of [[triangle(30, 40)], [dumbbell(5)]]) {
      const tp = generateRegionPocket(input(norm(loops), { depth: 2 }), port).unwrap()
      const leaves = leavesOf(treeOf(norm(loops), 2.4, 0.2)).length
      expect(retractsPerLevel(tp, 2)[0]).toBe(leaves - 1)
    }
  })

  it('enters leaves by helix where it fits in the root, else ramps along the ring (8 mm slot)', () => {
    const helixArcs = (tp: Toolpath) =>
      walk(tp).filter((s) => s.move.kind === 'arc' && s.move.to[2] < s.from[2] - 1e-9).length
    const star3 = generateRegionPocket(input(norm(star(200)), { depth: 2 }), port).unwrap()
    expect(helixArcs(star3)).toBeGreaterThan(0)
    const slot = input(norm([rect(0, 0, 60, 8, 1)]), { depth: 2 })
    const tp = generateRegionPocket(slot, port).unwrap()
    expect(checkRules(slot, tp)).toEqual([])
    // no helix: descending moves follow the ring at the ramp angle
    const descents = walk(tp).filter(
      (s) => s.move.kind !== 'rapid' && s.move.to[2] < s.from[2] - 1e-9,
    )
    const ramped = descents.filter(
      (s) => Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-6,
    )
    expect(ramped.length).toBeGreaterThan(0)
    expect(descents.every((s) => s.move.kind !== 'arc' || s.from[1] > 0)).toBe(true)
  })

  it('plunges when asked to', () => {
    const inp = input(norm(twoIslands()), { depth: 2, strategy: { entry: 'plunge' } })
    const tp = generateRegionPocket(inp, port).unwrap()
    const descents = walk(tp).filter(
      (s) => s.move.kind !== 'rapid' && s.move.to[2] < s.from[2] - 1e-9,
    )
    expect(descents.every((s) => s.move.kind === 'line' && s.move.feed === 300)).toBe(true)
    expect(checkRules(inp, tp)).toEqual([])
  })

  it('finishes every loop with tangent lead-in and lead-out arcs from the cleared side', () => {
    const inp = input(norm(twoIslands()), { depth: 4 })
    const tp = generateRegionPocket(inp, port).unwrap()
    const finish = walk(tp).filter((s) => tp.passes[s.pass]!.kind === 'finish')
    const arcs = finish.filter((s) => s.move.kind === 'arc')
    // per loop: a lead-in arc, the ring, a lead-out arc (radius R where there is room)
    const leads = arcs.filter((s) => {
      const m = s.move as Extract<typeof s.move, { kind: 'arc' }>
      const r = Math.hypot(s.from[0] - m.center[0], s.from[1] - m.center[1])
      return Math.abs(r - R) < 1e-9 && Math.abs(Math.abs(arcSweep(s.from, m)) - Math.PI / 2) < 1e-9
    })
    expect(leads.length).toBeGreaterThanOrEqual(6)
    // tangent continuity: the move after each lead-in arc continues in its end direction
    for (let i = 0; i < finish.length - 1; i++) {
      const s = finish[i]!
      if (!leads.includes(s)) continue
      const m = s.move as Extract<typeof s.move, { kind: 'arc' }>
      const rx = m.to[0] - m.center[0]
      const ry = m.to[1] - m.center[1]
      const t = m.cw ? [ry, -rx] : [-ry, rx]
      const next = finish[i + 1]!
      if (next.move.kind !== 'line') continue
      const dx = next.move.to[0] - next.from[0]
      const dy = next.move.to[1] - next.from[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      expect(Math.abs(t[0]! * dy - t[1]! * dx) / (len * R)).toBeLessThan(1e-6)
    }
    expect(checkRules(inp, tp)).toEqual([])
  })

  it('conventional cuts every ring the other way', () => {
    const region = norm([rect(0, 0, 40, 30, 4)])
    const sweeps = (tp: Toolpath) =>
      walk(tp)
        .filter((s) => s.move.kind === 'arc' && Math.abs(s.move.to[2] - s.from[2]) < 1e-9)
        .map((s) => (s.move as { cw: boolean }).cw)
    const climb = sweeps(generateRegionPocket(input(region, { depth: 2 }), port).unwrap())
    const conv = sweeps(
      generateRegionPocket(
        input(region, { depth: 2, strategy: { direction: 'conventional' } }),
        port,
      ).unwrap(),
    )
    expect(climb.every((cw) => !cw)).toBe(true)
    expect(conv.every((cw) => cw)).toBe(true)
  })

  it('refuses a tool wider than the region and invalid inputs; aborts between steps', () => {
    const narrow = norm([rect(0, 0, 40, 5.9)])
    const e = generateRegionPocket(input(narrow), port)
    expect(e.isErr() && e.unwrapErr().code).toBe('plan.check')
    expect(e.unwrapErr().issues.map((i) => i.rule)).toContain('toolTooLarge')
    // up to TOOL_FIT_TOLERANCE wider is accepted
    expect(generateRegionPocket(input(norm([rect(0, 0, 40, 5.995)])), port).isOk()).toBe(true)
    const empty = generateRegionPocket(input({ pieces: [] }), port)
    expect(empty.isErr() && empty.unwrapErr().code).toBe('model.invariant')
    const big = generateRegionPocket(input(narrow, { stepover: 6 }), port)
    expect(big.isErr() && big.unwrapErr().code).toBe('model.invariant')
    const ab = generateRegionPocket(input(norm(twoIslands())), port, { step: () => aborted() })
    expect(ab.isErr() && ab.unwrapErr().code).toBe('op.aborted')
  })

  it('roughs a piece too narrow for the allowance at its wall, without finishing it', () => {
    // 6.3 wide: R + 0.2 leaves nothing, R leaves a line-thin ring
    const inp = input(norm([rect(0, 0, 40, 6.3)]), { depth: 2 })
    const tp = generateRegionPocket(inp, port).unwrap()
    expect(tp.passes.every((p) => p.kind === 'rough')).toBe(true)
    expect(checkRules(inp, tp)).toEqual([])
  })
})

describe('coverage oracle (heightmap)', () => {
  function cover(loops: Loop[], stepover: number, cell: number, allowance = 0.2) {
    const { region, size } = placed(loops)
    const inp = input(region, { depth: 2, stepover, strategy: { finishAllowance: allowance } })
    const tp = generateRegionPocket(inp, port).unwrap()
    const c0 = port.offset(region, R).unwrap()
    const opening = port.offset(c0, -R).unwrap()
    const expectedRest = regionArea(port.difference(region, opening).unwrap())
    return {
      cov: regionCoverage(region, c0, tp, D6, size, -2, cell),
      expectedRest,
      rules: checkRules(inp, tp),
    }
  }

  it(
    "clears the spike's star with 2 islands: no leftover, no gouge, uncut = region − opening",
    { timeout: 60_000 }, // ≈ 5 s alone (heightmap at 0.2 mm cells)
    () => {
      const { cov, expectedRest, rules } = cover(star(200), 2.4, 0.2)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.belowFloor).toBe(0)
      expect(cov.leftover).toBeLessThan(0.5)
      expect(Math.abs(cov.rest - expectedRest)).toBeLessThan(0.01 * expectedRest + 2)
    },
  )

  it(
    'clears the pocket with 2 islands at a clamped 0.9 D stepover',
    { timeout: 60_000 }, // ≈ 2 s alone
    () => {
      const { cov, rules } = cover(twoIslands(), 5.4, 0.1)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.leftover).toBeLessThan(0.05)
    },
  )

  it(
    'clears the enclosure cavity (X0 fixture, Béziers as lines)',
    { timeout: 60_000 }, // ≈ 8 s alone (heightmap at 0.25 mm cells over 245 × 167 mm)
    () => {
      const { cov, expectedRest, rules } = cover([enclosureCavity()], 2.4, 0.25)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.belowFloor).toBe(0)
      expect(cov.leftover).toBeLessThan(0.5)
      expect(Math.abs(cov.rest - expectedRest)).toBeLessThan(0.01 * expectedRest + 2)
    },
  )

  it(
    'leaves exactly the rest material in a 4 mm neck and 30° corners',
    { timeout: 60_000 }, // ≈ 1 s alone
    () => {
      for (const loops of [[dumbbell(2)], [triangle(30, 40)]]) {
        const { cov, expectedRest } = cover(loops, 2.4, 0.1)
        expect(cov.gouge).toBe(0)
        expect(cov.leftover).toBeLessThan(0.05)
        expect(Math.abs(cov.rest - expectedRest)).toBeLessThan(0.01 * expectedRest + 0.5)
      }
    },
  )
})

describe('rest material (plan.restMaterial finding)', () => {
  it('reports a neck narrower than the tool, not corners', () => {
    const neck = findRestMaterial(port, norm([dumbbell(2)]), R).unwrap()
    expect(neck).toHaveLength(1)
    expect(neck[0]!.area).toBeGreaterThan(60)
    expect(neck[0]!.area).toBeLessThan(80)
    expect(port.contains(norm([dumbbell(2)]), neck[0]!.at)).toBe(true)
    expect(findRestMaterial(port, norm([triangle(30, 40)]), R).unwrap()).toEqual([])
    expect(findRestMaterial(port, norm(star(200)), R).unwrap()).toEqual([])
    expect(findRestMaterial(port, norm(twoIslands()), R).unwrap()).toEqual([])
    expect(findRestMaterial(port, norm([dumbbell(5)]), R).unwrap()).toEqual([])
  })
})

describe('roughing and rest machining (DF108)', () => {
  // a 30 × 20 cell with R 1 corners and a 4 × 4 one the Ø 6 cannot enter, 2 mm deep
  const loops = () => placeLoops([rect(0, 0, 30, 20, 1), rect(36, 0, 4, 4, 1)])
  const D2 = endMill(2)
  const rough = { radius: 3, cornerRadius: 0, wall: 0.2, floorDepth: 2 }
  const pocket = (tool: ToolpathTool, extra: object) => {
    const { loops: ls, size } = loops()
    const region = norm(ls)
    const inp = input(region, { tool, depth: 2 })
    return {
      region,
      size,
      inp: { ...inp, operation: { ...inp.operation, ...extra } } as RegionPocketInput,
    }
  }

  it('the roughing pass: rough levels only, none in the cell its tool cannot enter', () => {
    const { inp } = pocket(D6, { roughing: true })
    const tp = generateRegionPocket(inp, port).unwrap()
    expect(tp.passes.length).toBeGreaterThan(0)
    expect(tp.passes.every((p) => p.kind === 'rough')).toBe(true)
    // nothing past x = 5 + 30 (the small cell starts at 41)
    for (const p of tp.passes)
      for (const m of p.moves)
        if (m.kind !== 'drill' && m.to[2] < 0) expect(m.to[0]).toBeLessThan(36)
  })

  it('rest machining skips what the roughing cleared and leaves nothing reachable uncut', () => {
    const r = pocket(D6, { roughing: true })
    const roughTp = generateRegionPocket(r.inp, port).unwrap()
    const plain = generateRegionPocket(pocket(D2, {}).inp, port).unwrap()
    const restIn = pocket(D2, { restAfter: rough })
    const rest = generateRegionPocket(restIn.inp, port).unwrap()
    expect(rest.stats.cutLength).toBeLessThan(0.7 * plain.stats.cutLength)
    // the finishing ring stays: the walls get the small tool's finish
    expect(rest.passes.some((p) => p.kind === 'finish')).toBe(true)
    expect(checkRules(restIn.inp, rest, [{ tool: D6, tp: roughTp }])).toEqual([])
    // both passes together: nothing the Ø 2 reaches is left above the floor, no gouge
    const c0 = port.offset(r.region, 1).unwrap()
    const cov = regionCoverage(r.region, c0, rest, D2, r.size, -2, 0.1, 0.01, undefined, [
      { tool: D6, tp: roughTp },
    ])
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(cov.leftover).toBeLessThan(0.05)
  })

  it('DF122 floor margin: below the roughing floor the rest cuts every node, nothing is left', () => {
    // the roughing stops 1 mm above the 2 mm floor
    const r = pocket(D6, { roughing: true })
    const roughTp = generateRegionPocket(
      { ...r.inp, operation: { ...r.inp.operation, depth: 1 } },
      port,
    ).unwrap()
    const full = generateRegionPocket(pocket(D2, { restAfter: rough }).inp, port).unwrap()
    const restIn = pocket(D2, { restAfter: { ...rough, floorDepth: 1 } })
    const rest = generateRegionPocket(restIn.inp, port).unwrap()
    // more to cut than with the roughing down to the floor, still less than the Ø 2 alone
    const plain = generateRegionPocket(pocket(D2, {}).inp, port).unwrap()
    expect(rest.stats.cutLength).toBeGreaterThan(full.stats.cutLength)
    expect(rest.stats.cutLength).toBeLessThan(plain.stats.cutLength)
    expect(checkRules(restIn.inp, rest, [{ tool: D6, tp: roughTp }])).toEqual([])
    const c0 = port.offset(r.region, 1).unwrap()
    const cov = regionCoverage(r.region, c0, rest, D2, r.size, -2, 0.1, 0.01, undefined, [
      { tool: D6, tp: roughTp },
    ])
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(cov.leftover).toBeLessThan(0.05)
  })

  it('pruneCleared keeps every node of a cell the roughing never entered', () => {
    const { region } = pocket(D2, {})
    const inside = restInside(port, region, rough, 1).unwrap()
    // only the big cell has a roughed inside
    expect(inside.pieces).toHaveLength(1)
    // the Ø 2's tool-centre region (R + allowance in), rings 0.8 apart
    const tree = ringTree(port, port.offset(region, 1.2).unwrap(), 1.2, 0.8).unwrap()
    const pruned = pruneCleared(port, tree, inside).unwrap()
    const count = (ns: readonly RingNode[]): number =>
      ns.reduce((n, x) => n + 1 + count(x.children), 0)
    expect(count(pruned)).toBeLessThan(count(tree))
    // the small cell's piece (x > 36) keeps all its nodes
    const small = (ns: readonly RingNode[]): number =>
      ns.reduce(
        (n, x) =>
          n +
          (chainBounds(x.region.pieces[0]!.outer.elements)!.min[0] > 36 ? 1 : 0) +
          small(x.children),
        0,
      )
    expect(small(pruned)).toBe(small(tree))
    expect(small(tree)).toBeGreaterThan(0)
  })
})

// heightmap checks per shape; slow under the check-under-load criterion
describe('rest clipping (DF122 R3)', { timeout: 60_000 }, () => {
  // S4's corpus with a Ø 3 owner after a Ø 8 roughing (wall 0.2, to the floor)
  const D3 = endMill(3)
  const D8 = endMill(8)
  const reach = (depth: number) => ({ radius: 4, cornerRadius: 0, wall: 0.2, floorDepth: depth })
  function rest(loops: Loop[], depth = 2, cell = 0.1) {
    const { region, size } = placed(loops)
    const at = (tool: ToolpathTool, extra: object): RegionPocketInput => {
      const inp = input(region, { tool, depth })
      return { ...inp, operation: { ...inp.operation, ...extra } }
    }
    const roughIn = at(D8, { roughing: true })
    const restIn = at(D3, { restAfter: reach(depth) })
    const plainIn = at(D3, {})
    const rough = generateRegionPocket(roughIn, port).unwrap()
    const tp = generateRegionPocket(restIn, port).unwrap()
    const plain = generateRegionPocket(plainIn, port).unwrap()
    const before = [{ tool: D8, tp: rough }]
    const c0 = port.offset(region, 1.5).unwrap()
    return {
      tp,
      plain,
      rules: checkRules(restIn, tp, before),
      cov: regionCoverage(region, c0, tp, D3, size, -depth, cell, 0.01, undefined, before),
      diff: heightDifference(size, [...before, { tool: D3, tp }], [{ tool: D3, tp: plain }], cell),
      air: airCut(tp, D3, size, before, cell),
      plainAir: airCut(plain, D3, size, before, cell),
    }
  }
  /**
   * The oracles: path rules; nothing the Ø 3 reaches left, no gouge; roughing + rest leaves the
   * same heights as the Ø 3 alone (within 0.02 mm); no plunge into material; the rest cuts at
   * most `airShare` of the air the Ø 3 alone would cut after the roughing (what is left: links
   * between runs, short bridges, overlaps of its own rings in narrow spots); less time.
   */
  const expectClean = (r: ReturnType<typeof rest>, airShare = 0.15) => {
    expect(r.rules).toEqual([])
    expect(r.cov.gouge).toBe(0)
    expect(r.cov.belowFloor).toBe(0)
    expect(r.cov.leftover).toBeLessThan(0.05)
    expect(r.diff).toBeLessThan(0.05)
    expect(r.air.plunges).toBe(0)
    expect(r.air.air).toBeLessThanOrEqual(airShare * r.plainAir.air)
    expect(r.tp.stats.estimatedSeconds).toBeLessThan(0.25 * r.plain.stats.estimatedSeconds)
  }

  it('corners: a rounded rectangle and an acute triangle keep only their corner runs', () => {
    for (const loops of [[rect(0, 0, 60, 40, 1.5)], [triangle(40, 40)]]) {
      const r = rest(loops)
      expectClean(r)
      // every rest level cuts runs only: nothing but the corners and links (≈ 10 % of the Ø 3)
      expect(r.tp.stats.cutLength).toBeLessThan(0.2 * r.plain.stats.cutLength)
    }
  }, 60_000) // two shapes with heightmap checks; slow under the check-under-load criterion

  it('a neck the Ø 8 cannot pass: the Ø 3 clears it whole, entering as without roughing', () => {
    const r = rest([dumbbell(3)])
    expectClean(r)
    // the neck's rings cut material all along: almost no air
    expect(r.air.air).toBeLessThan(0.2 * r.air.cutting)
  })

  it('islands: a gap the Ø 8 cannot pass; a pocket it roughs wholly leaves only the finish', () => {
    expectClean(
      rest([rect(0, 0, 60, 40, 1.5), hole(rect(15, 10, 15, 15, 1)), hole(circle(48, 30, 5))]),
    )
    // S4's two islands: every corner within the Ø 8's reach, so no rest level at all
    const all = rest(twoIslands(), 2, 0.2)
    expectClean(all)
    expect(all.tp.passes.map((p) => p.kind)).toEqual(['finish'])
  })

  it('clipRing: runs start where the ring leaves the roughed area, short gaps are bridged', () => {
    const area = restArea(norm([circle(10, 0, 5)]))
    const square = loopRing(norm([rect(0, 0, 20, 20)]).pieces[0]!.outer)
    const c = clipRing(port, square, area, 1)
    expect(c.kind).toBe('runs')
    const runs = c.kind === 'runs' ? c.runs : []
    expect(runs).toHaveLength(1)
    const s = segPoint(runs[0]!.segs[0]!, 0)
    expect(s[0]).toBeCloseTo(15, 9)
    expect(s[1]).toBeCloseTo(0, 9)
    // an arc ring through two roughed discs: two runs, joined when the gap is shorter than 8
    const ring = loopRing(norm([circle(0, 0, 10)]).pieces[0]!.outer)
    const two = restArea(norm([circle(10, 0, 2), circle(-10, 0, 2)]))
    const split = clipRing(port, ring, two, 1)
    expect(split.kind === 'runs' && split.runs.length).toBe(2)
    expect(clipRing(port, ring, restArea(norm([circle(30, 0, 2)])), 1).kind).toBe('whole')
    expect(clipRing(port, ring, restArea(norm([circle(0, 0, 20)])), 1)).toEqual({
      kind: 'runs',
      runs: [],
    })
    // every run point lies outside the roughed area
    for (const run of split.kind === 'runs' ? split.runs : [])
      for (const sg of run.segs) expect(port.contains(two.region, segPoint(sg, 0.5))).toBe(false)
    // a bridge longer than the gaps (≈ 4 mm each) joins the two runs into one
    const joined = clipRing(port, ring, two, 8)
    expect(joined.kind === 'runs' && joined.runs.length).toBe(1)
  })
})
