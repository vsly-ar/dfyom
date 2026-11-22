import { describe, expect, it } from 'vitest'
import type { Vec2, Vec3 } from '../geometry/model'
import { line, regionArea, type Loop, type Region } from '../geometry/2d/model'
import { chainLength, chainPointAt } from '../geometry/2d/measure'
import { tabCentres } from '../geometry/outline'
import { bulgeLoop, circle, dumbbell, rect } from '../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg'
import { aborted } from '../workers/steps'
import type { Toolpath, ToolpathTool } from './model'
import {
  generateRegionProfile,
  profileStep,
  profileStepClamped,
  zigzag,
  type RegionProfileInput,
  type RegionProfileOperation,
  type RegionProfileStrategy,
} from './region-profile'
import {
  diskHitsGeneralBands,
  generalTabBands,
  sliceChain,
  type GeneralTabBand,
} from '../geometry/tab-bands'
import { segsLength, segPoint, type Seg } from './path'
import { regionContains } from '../geometry/2d/measure'
import { arcSweep } from './stats'
import { cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'
import { placeLoops, regionCoverage } from './testing/region-coverage'
import { steps as walk, type Step } from './testing/oracles'
import { cuttingLevels, stepsWithin, violations } from './testing/rules'

const port = nodeRegion2d()
const D6 = endMill(6)
const R = 3
const Q = Math.tan(Math.PI / 8) // bulge of a 90° arc

/**
 * A bracket of lines and arcs, counter-clockwise from (0, 0): a convex corner arc (r 10 round
 * (50, 10)) and a concave notch arc (r 10 round (30, 40)).
 */
const bracket = (dx = 0, dy = 0): Loop =>
  bulgeLoop([
    [dx, dy, 0],
    [dx + 50, dy, Q],
    [dx + 60, dy + 10, 0],
    [dx + 60, dy + 40, 0],
    [dx + 40, dy + 40, -Q],
    [dx + 30, dy + 30, 0],
    [dx, dy + 30, 0],
  ])

/** An open path: a line, a quarter arc, a line (an S-free hook). */
const hook = (dx = 0, dy = 0): Loop =>
  bulgeLoop(
    [
      [dx, dy, 0],
      [dx + 30, dy, Q],
      [dx + 40, dy + 10, 0],
      [dx + 40, dy + 30, 0],
    ],
    false,
  )

const strategy = (over: Partial<RegionProfileStrategy> = {}): RegionProfileStrategy => ({
  entry: 'ramp',
  rampAngle: 3,
  breakthrough: 0.5,
  finishAllowance: 0.2,
  direction: 'climb',
  leadRadius: 3,
  ...over,
})

function input(
  chain: Loop,
  o: Partial<Omit<RegionProfileOperation, 'chain'>> & {
    tool?: ToolpathTool
    stepover?: number
    stepdown?: number
    strategy?: Partial<RegionProfileStrategy>
  } = {},
): RegionProfileInput {
  const tool = o.tool ?? D6
  return {
    planOperationId: 'op-profile',
    tool,
    cutting: cutting(tool, {
      ...(o.stepover === undefined ? {} : { stepover: o.stepover }),
      stepdown: o.stepdown ?? 2,
    }),
    heights: HEIGHTS,
    stock: { length: 300, width: 300, thickness: 6 },
    operation: {
      chain,
      closed: o.closed ?? true,
      side: o.side ?? 'outside',
      slotWidth: o.slotWidth ?? 6,
      onZ: o.onZ ?? 0,
      depth: o.depth ?? 6,
      through: o.through ?? true,
      tabs: o.tabs ?? { positions: [], width: 6, thickness: 2 },
    },
    strategy: strategy(o.strategy),
    maxFeedRate: RATES,
  }
}

const bottomOf = (inp: RegionProfileInput) =>
  inp.operation.onZ - inp.operation.depth - (inp.operation.through ? inp.strategy.breakthrough : 0)

/** Tool centres allowed in the slot (its tool-centre region, grown by `tol`). */
function centres(inp: RegionProfileInput, tol = 1e-4): Region {
  const { chain, closed, side, slotWidth: sw } = inp.operation
  const r = inp.tool.diameter / 2
  const edge = Math.max(0, sw / 2 - r)
  if (!closed) return port.offsetPath(chain, edge + tol).unwrap()
  const L = port.normalise([chain]).unwrap()
  const off = (d: number) => port.offset(L, d).unwrap()
  if (side === 'outside') return port.difference(off(-(sw - r + tol)), off(-(r - tol))).unwrap()
  if (side === 'inside') return port.difference(off(r - tol), off(sw - r + tol)).unwrap()
  return port.difference(off(-(edge + tol)), off(edge + tol)).unwrap()
}

function checkRules(inp: RegionProfileInput, tp: Toolpath): string[] {
  const c = centres(inp)
  const bottom = bottomOf(inp)
  return violations(tp, {
    feedRate: inp.cutting.feedRate,
    plungeRate: inp.cutting.plungeRate,
    rampAngle: inp.strategy.rampAngle,
    retractZ: inp.operation.onZ + inp.heights.retractHeight,
    clearanceZ: inp.heights.clearanceHeight,
    targetZ: bottom,
    contains: (p: Vec3) =>
      p[2] > inp.operation.onZ + 1e-9 || (p[2] >= bottom - 1e-9 && port.contains(c, [p[0], p[1]])),
  })
}

/** Horizontal feed moves at Z `z` of a pass kind. */
const atLevel = (tp: Toolpath, z: number, kind: 'rough' | 'finish' = 'rough') =>
  walk(tp).filter(
    (s) =>
      tp.passes[s.pass]!.kind === kind &&
      s.move.kind !== 'rapid' &&
      Math.abs(s.move.to[2] - z) < 1e-9 &&
      Math.abs(s.from[2] - z) < 1e-9 &&
      Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-9,
  )

/** Distance of a point to the chain. */
const distTo = (chain: Loop, p: Vec2) => port.distance([chain], p)!.distance

/** Samples (end points and arc middles) of a step's XY path. */
function xyPoints(s: Step): Vec2[] {
  const m = s.move
  if (m.kind !== 'arc') return [[m.to[0], m.to[1]]]
  const sw = arcSweep(s.from, m)
  const a0 = Math.atan2(s.from[1] - m.center[1], s.from[0] - m.center[0])
  const r = Math.hypot(s.from[0] - m.center[0], s.from[1] - m.center[1])
  return [0.5, 1].map((u) => [
    m.center[0] + r * Math.cos(a0 + sw * u),
    m.center[1] + r * Math.sin(a0 + sw * u),
  ])
}

/** Rapid lifts to the retract plane inside the rough passes (not the last one). */
function roughRetracts(tp: Toolpath, retractZ: number): number {
  let n = 0
  let z = Infinity
  const moves = tp.passes.filter((p) => p.kind === 'rough').flatMap((p) => p.moves)
  for (const m of moves) {
    if (m.kind === 'drill') continue
    if (m.kind === 'rapid' && m.to[2] >= retractZ - 1e-9 && z < retractZ) n++
    z = m.to[2]
  }
  return n
}

describe('pass spacing (T-G, T-H)', () => {
  it('is min(stepover, R), for a blind groove the flat radius', () => {
    expect(profileStep(D6, 2.4, false)).toBe(2.4)
    expect(profileStep(D6, 5, false)).toBe(3)
    expect(profileStepClamped(D6, 5, false)).toBe(true)
    expect(profileStepClamped(D6, 2.4, false)).toBe(false)
    expect(profileStep({ ...D6, cornerRadius: 1 }, 2.4, true)).toBe(2)
  })
})

describe('tab bands on general loops', () => {
  it('slices a loop by arc length, wrapping past its start', () => {
    const l = rect(0, 0, 10, 10)
    const s = sliceChain(l, 35, 45)
    expect(segsLengthOf(s)).toBeCloseTo(10)
    expect(s[0]!.a).toEqual([0, 5])
    expect(s.at(-1)!.b[0]).toBeCloseTo(5)
  })

  it('spans the slot across a line (width × slot) and lifts the tool over width + D', () => {
    const l = rect(0, 0, 40, 20)
    const [band] = generalTabBands(l, [20], 4, -6, 0)
    const area = band!.reduce(
      (a, pc) => a + regionArea({ pieces: [{ outer: pc.loop, holes: [] }] }),
      0,
    )
    expect(area).toBeCloseTo(24)
    expect(diskHitsGeneralBands([20, -3], R, [band!])).toBe(true)
    expect(diskHitsGeneralBands([24.9, -3], R, [band!])).toBe(true)
    expect(diskHitsGeneralBands([25.1, -3], R, [band!])).toBe(false)
    expect(diskHitsGeneralBands([20, 3.1], R, [band!])).toBe(false)
  })

  it('bends round a convex corner arc and adds the corner sector at sharp corners', () => {
    // a tab across the convex arc of the bracket, and one over a sharp corner of a rectangle
    const b = bracket()
    const arcMid = 50 + (10 * Math.PI) / 4
    const [onArc] = generalTabBands(b, [arcMid], 4, -6, 0)
    const p = chainPointAt(b, arcMid, true).unwrap().point
    // the band's outer edge lies 6 out along the arc normal (from the arc centre (50, 10))
    const u: Vec2 = [(p[0] - 50) / 10, (p[1] - 10) / 10]
    expect(inBand([onArc!], [p[0] + 5.9 * u[0], p[1] + 5.9 * u[1]])).toBe(true)
    expect(inBand([onArc!], [p[0] + 6.1 * u[0], p[1] + 6.1 * u[1]])).toBe(false)
    expect(inBand([onArc!], [p[0] - 0.1 * u[0], p[1] - 0.1 * u[1]])).toBe(false)
    const [corner] = generalTabBands(rect(0, 0, 40, 20), [40], 4, -6, 0)
    expect(inBand([corner!], [42, -2])).toBe(true) // the corner sector
    expect(inBand([corner!], [45, -5])).toBe(false) // beyond its radius
  })

  it('is one loop across a smooth join: an arc where the offsets part, trimmed where they overlap', () => {
    // two lines turning by θ < SMOOTH_TURN at (10, 0), the band on the right [−6, 0]
    const theta = 0.005
    const bent = (sign: number): Loop => {
      const end: Vec2 = [10 + 10 * Math.cos(theta), sign * 10 * Math.sin(theta)]
      return { elements: [line([0, 0], [10, 0]), line([10, 0], end), line(end, [0, 0])] }
    }
    const area = (band: GeneralTabBand) =>
      regionArea(port.normalise(band.map((p) => p.loop)).unwrap())
    // a left turn parts the right offsets (an arc of radius 6 round the vertex), a right turn
    // overlaps them (trimmed at their crossing)
    const [left] = generalTabBands(bent(1), [10], 8, -6, 0)
    const [right] = generalTabBands(bent(-1), [10], 8, -6, 0)
    expect(left).toHaveLength(1)
    expect(right).toHaveLength(1)
    expect(area(left!)).toBeCloseTo(8 * 6 + 18 * theta, 9)
    expect(area(right!)).toBeCloseTo(8 * 6 - 36 * Math.tan(theta / 2), 9)
  })

  it('on the enclosure outline (fitted arcs, joins of ≈ 1e-7 rad): one piece per tab that the port takes', () => {
    // the known issue's repro: tabs ≥ 2, or at 346.91, failed the port's union (`degenerate`)
    const { outline } = enclosure()
    const L = chainLength(outline)
    const cases = [2, 3, 4, 5, 6].map((count) => tabCentres(L, { count }))
    cases.push([346.91])
    for (const positions of cases)
      for (const [lo, hi] of [
        [-6, 0],
        [-7.001, 1.001],
      ] as const) {
        const bands = generalTabBands(outline, positions, 6, lo, hi)
        for (const [i, band] of bands.entries()) {
          expect(band, `${positions[i]}`).toHaveLength(1)
          const r = port.normalise(band.map((p) => p.loop)).unwrap()
          expect(r.pieces).toHaveLength(1)
          // ≈ width × across (the outline's arcs are gentle)
          expect(regionArea(r) / (6 * (hi - lo))).toBeGreaterThan(0.9)
          expect(regionArea(r) / (6 * (hi - lo))).toBeLessThan(1.1)
        }
      }
  })
})

function inBand(bands: readonly GeneralTabBand[], p: Vec2): boolean {
  return bands.some((b) =>
    b.some((pc) => regionContains({ pieces: [{ outer: pc.loop, holes: [] }] }, p)),
  )
}

function segsLengthOf(es: readonly { a: Vec2; b: Vec2 }[]): number {
  return es.reduce((s, e) => s + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 0)
}

describe('generateRegionProfile: outside and inside', () => {
  it('outside, slot = D: one pass per level on the tool-radius offset, no finishing', () => {
    const inp = input(bracket(), { stepdown: 2 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const levels = cuttingLevels(tp, 'rough')
    expect(levels).toEqual([-1.625, -3.25, -4.875, -6.5].map((z) => expect.closeTo(z, 9)))
    expect(stepsWithin(levels, 0, 2)).toBe(true)
    expect(tp.passes.map((p) => p.kind)).toEqual(['rough', 'rough', 'rough', 'rough'])
    for (const s of atLevel(tp, -6.5))
      for (const p of xyPoints(s)) expect(distTo(inp.operation.chain, p)).toBeCloseTo(R, 6)
  })

  it('outside, wide slot: passes by offset from the offcut side, then the finishing pass', () => {
    const inp = input(bracket(), { slotWidth: 14, stepdown: 7 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    // distances: rowPositions(3.2, 11, 2.4) reversed = 11, 9.05, 7.1, 5.15, 3.2
    const ds: number[] = []
    for (const s of atLevel(tp, -6.5)) {
      const d = distTo(inp.operation.chain, [s.move.to[0], s.move.to[1]])
      if (ds.length === 0 || Math.abs(ds.at(-1)! - d) > 0.01) ds.push(d)
    }
    const expected = [11, 9.05, 7.1, 5.15, 3.2]
    expect(ds.filter((d) => expected.some((e) => Math.abs(d - e) < 1e-6))).toEqual(
      expected.map((e) => expect.closeTo(e, 6)),
    )
    // finishing: the part-side pass at R, full depth
    const fin = atLevel(tp, -6.5, 'finish')
    expect(fin.length).toBeGreaterThan(0)
    const ring = fin.filter(
      (s) => Math.abs(distTo(inp.operation.chain, [s.move.to[0], s.move.to[1]]) - R) < 1e-6,
    )
    expect(ring.length).toBeGreaterThan(5)
  })

  it('inside: passes by shrinking; a pass that splits in a neck cuts every piece', () => {
    const chain = dumbbell(6) // neck 12 wide: the far passes of a 12 mm slot split
    const inp = input(chain, { side: 'inside', slotWidth: 12, stepdown: 7 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const far = atLevel(tp, -6.5).filter(
      (s) => Math.abs(distTo(chain, [s.move.to[0], s.move.to[1]]) - 9) < 1e-6,
    )
    // both lobes' far rings are cut
    expect(far.some((s) => s.move.to[0] < 25)).toBe(true)
    expect(far.some((s) => s.move.to[0] > 25)).toBe(true)
  })

  it('climb runs outside rings clockwise and inside rings counter-clockwise; conventional reverses', () => {
    const chain = rect(0, 0, 40, 30, 5)
    const cws = (inp: RegionProfileInput) =>
      atLevel(generateRegionProfile(inp, port).unwrap(), -6.5)
        .filter((s) => s.move.kind === 'arc')
        .map((s) => (s.move as { cw: boolean }).cw)
    const all = (xs: boolean[], v: boolean) => xs.length > 0 && xs.every((x) => x === v)
    expect(all(cws(input(chain)), true)).toBe(true)
    expect(all(cws(input(chain, { strategy: { direction: 'conventional' } })), false)).toBe(true)
    expect(all(cws(input(chain, { side: 'inside' })), false)).toBe(true)
    expect(
      all(cws(input(chain, { side: 'inside', strategy: { direction: 'conventional' } })), true),
    ).toBe(true)
    // a clockwise chain gives the same toolpath direction
    const cwChain: Loop = {
      elements: [...chain.elements]
        .reverse()
        .map((e) => (e.kind === 'line' ? line(e.b, e.a) : { ...e, a: e.b, b: e.a, ccw: !e.ccw })),
    }
    expect(all(cws(input(cwChain)), true)).toBe(true)
  })

  it('ramps along the first pass at the ramp angle, or plunges', () => {
    const inp = input(bracket())
    const tp = generateRegionProfile(inp, port).unwrap()
    const descents = walk(tp).filter(
      (s) => s.move.kind !== 'rapid' && s.move.to[2] < s.from[2] - 1e-9,
    )
    expect(
      descents.some((s) => Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1),
    ).toBe(true)
    const pl = generateRegionProfile(
      input(bracket(), { strategy: { entry: 'plunge' } }),
      port,
    ).unwrap()
    const pd = walk(pl).filter((s) => s.move.kind !== 'rapid' && s.move.to[2] < s.from[2] - 1e-9)
    expect(pd.every((s) => s.move.kind === 'line' && s.move.feed === 300)).toBe(true)
  })

  it('finishes with tangent lead-in and lead-out arcs of leadRadius on the offcut side', () => {
    const inp = input(bracket(), { slotWidth: 16, stepdown: 7 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const fin = walk(tp).filter(
      (s) => tp.passes[s.pass]!.kind === 'finish' && s.move.kind !== 'rapid',
    )
    const first = fin.find(
      (s) => Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-9,
    )!
    const last = [...fin]
      .reverse()
      .find((s) => Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-9)!
    for (const s of [first, last]) {
      expect(s.move.kind).toBe('arc')
      const m = s.move as Extract<typeof s.move, { kind: 'arc' }>
      expect(Math.hypot(s.from[0] - m.center[0], s.from[1] - m.center[1])).toBeCloseTo(3, 9)
      expect(Math.abs(arcSweep(s.from, m))).toBeCloseTo(Math.PI / 2, 9)
      // the lead centre lies on the offcut side, one radius from the part-side pass
      expect(distTo(inp.operation.chain, m.center)).toBeCloseTo(R + 3, 6)
    }
    // tangent: the move after the lead-in continues in its end direction
    const i = fin.indexOf(first)
    const m = first.move as Extract<typeof first.move, { kind: 'arc' }>
    const t = tangentOfArcEnd(m)
    const next = fin[i + 1]!
    const dir = startDir(next)
    expect(Math.abs(t[0] * dir[1] - t[1] * dir[0])).toBeLessThan(1e-6)
    expect(t[0] * dir[0] + t[1] * dir[1]).toBeGreaterThan(0)
  })

  it('falls back to straight leads when no arc fits, and to the lead radius 0', () => {
    // slot 6.6: free band 0.6 wide, allowance 0.2 → straight leads of 0.2
    const inp = input(bracket(), { slotWidth: 6.6, stepdown: 7 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const fin = walk(tp).filter(
      (s) => tp.passes[s.pass]!.kind === 'finish' && s.move.kind !== 'rapid',
    )
    const moved = fin.filter(
      (s) => Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-9,
    )
    for (const s of [moved[0]!, moved.at(-1)!]) {
      expect(s.move.kind).toBe('line')
      expect(Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1])).toBeCloseTo(0.2, 9)
    }
    const z = generateRegionProfile(
      input(bracket(), { slotWidth: 16, strategy: { leadRadius: 0 } }),
      port,
    ).unwrap()
    const zf = walk(z).filter((s) => z.passes[s.pass]!.kind === 'finish' && s.move.kind === 'line')
    expect(zf.length).toBeGreaterThan(0)
  })
})

function tangentOfArcEnd(m: { to: Vec3; center: Vec2; cw: boolean }): Vec2 {
  const rx = m.to[0] - m.center[0]
  const ry = m.to[1] - m.center[1]
  const l = Math.hypot(rx, ry)
  return m.cw ? [ry / l, -rx / l] : [-ry / l, rx / l]
}

function startDir(s: Step): Vec2 {
  const m = s.move
  if (m.kind === 'arc') {
    const rx = s.from[0] - m.center[0]
    const ry = s.from[1] - m.center[1]
    const l = Math.hypot(rx, ry)
    return m.cw ? [ry / l, -rx / l] : [-ry / l, rx / l]
  }
  const dx = m.to[0] - s.from[0]
  const dy = m.to[1] - s.from[1]
  const l = Math.hypot(dx, dy)
  return [dx / l, dy / l]
}

describe('generateRegionProfile: tabs', () => {
  it('lifts over tabs placed by arc length on lines and arcs, starting between them', () => {
    const chain = bracket()
    const arcMid = 50 + (10 * Math.PI) / 4
    const positions = [25, arcMid, 150]
    const inp = input(chain, { tabs: { positions, width: 6, thickness: 2 }, stepdown: 2 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const tabTop = -6 + 2
    // in the levels below the tab top the tool runs at the tab top over each tab
    const lifted = atLevel(tp, tabTop)
    expect(lifted.length).toBeGreaterThan(0)
    // each lifted run is centred on its tab: group by nearest tab centre
    for (const pos of positions) {
      const c = chainPointAt(chain, pos, true).unwrap().point
      const near = lifted.filter((s) => Math.hypot(s.move.to[0] - c[0], s.move.to[1] - c[1]) < 12)
      expect(near.length).toBeGreaterThan(0)
    }
    // on the straight tab the lift spans width + D = 12 mm along the pass
    const straight = lifted.filter((s) => s.move.to[1] < -2 && s.from[1] < -2)
    const xs = straight.flatMap((s) => [s.from[0], s.move.to[0]])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12, 1)
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(25, 1)
  })

  it('takes K3 evenly spaced tabs (tabCentres) and keeps them clear of the start point', () => {
    const chain = rect(0, 0, 40, 20, 4)
    const positions = tabCentres(chainLength(chain), { count: 4 })
    const inp = input(chain, { tabs: { positions, width: 6, thickness: 2 } })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    // first tab half a spacing after the start point: the pass starts at the start point
    const first = walk(tp).find((s) => s.move.kind !== 'rapid')!
    expect(first.from[0]).toBeCloseTo(4, 6)
    expect(first.from[1]).toBeCloseTo(-R, 6)
    for (const pos of positions) {
      const c = chainPointAt(chain, pos, true).unwrap().point
      expect(
        atLevel(tp, -4).some((s) => Math.hypot(s.move.to[0] - c[0], s.move.to[1] - c[1]) < 10),
      ).toBe(true)
    }
  })

  it(
    'generates on the enclosure outline with 2–6 tabs and a tab at 346.91 (known-issue repro)',
    { timeout: 60_000 },
    () => {
      const { outline } = enclosure()
      const L = chainLength(outline)
      const cases = [2, 3, 4, 5, 6].map((count) => tabCentres(L, { count }))
      cases.push([346.91])
      for (const positions of cases) {
        const inp = input(outline, { stepdown: 2, tabs: { positions, width: 6, thickness: 2 } })
        const tp = generateRegionProfile(inp, port).unwrap()
        expect(checkRules(inp, tp)).toEqual([])
        expect(atLevel(tp, -4).length).toBeGreaterThan(0)
      }
    },
  )

  it('starts mid-way to the next tab when a tab lies at the start point', () => {
    const chain = rect(0, 0, 40, 20)
    const inp = input(chain, { tabs: { positions: [0, 60], width: 4, thickness: 2 } })
    const tp = generateRegionProfile(inp, port).unwrap()
    const firstFeed = walk(tp).find((s) => s.move.kind !== 'rapid')!
    // the start of the first pass: closest to the loop point at 30 (between 0 and 60): (30, 0)
    expect(firstFeed.from[0]).toBeCloseTo(30, 6)
    expect(firstFeed.from[1]).toBeCloseTo(-R, 6)
  })
})

describe('generateRegionProfile: on', () => {
  it('on a closed loop, slot = D: the loop itself per level', () => {
    const chain = bracket()
    const inp = input(chain, { side: 'on' })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    for (const s of atLevel(tp, -6.5))
      for (const p of xyPoints(s)) expect(distTo(chain, p)).toBeLessThan(1e-6)
  })

  it('on a closed loop, wide slot: centre, pairs of passes, finishing at both walls', () => {
    const chain = rect(0, 0, 60, 40, 8)
    const inp = input(chain, { side: 'on', slotWidth: 12, stepdown: 7 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const L = port.normalise([chain]).unwrap()
    const signed = (p: Vec2) => (port.contains(L, p) ? 1 : -1) * distTo(chain, p)
    const fin = atLevel(tp, -6.5, 'finish').map((s) => signed([s.move.to[0], s.move.to[1]]))
    expect(fin.some((d) => Math.abs(d - 3) < 1e-6)).toBe(true)
    expect(fin.some((d) => Math.abs(d + 3) < 1e-6)).toBe(true)
    const rough = atLevel(tp, -6.5).map((s) => signed([s.move.to[0], s.move.to[1]]))
    expect(rough.some((d) => Math.abs(d) < 1e-6)).toBe(true)
    expect(Math.max(...rough)).toBeCloseTo(2.8, 6)
    expect(Math.min(...rough)).toBeCloseTo(-2.8, 6)
  })

  it('on an open path: zigzag by level without retracts, ramp along the path', () => {
    const path = hook()
    const inp = input(path, { closed: false, side: 'on', through: false, depth: 3, stepdown: 1 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    expect(roughRetracts(tp, 2)).toBe(1) // only the final lift
    // level k runs along the path, level k + 1 back
    const end = segPointOfPath(path)
    const startsAt = [-1, -2, -3].map((z) => {
      const flat = atLevel(tp, z)
      const last = flat.at(-1)!
      return [last.move.to[0], last.move.to[1]] as Vec2
    })
    const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6
    expect(near(startsAt[0]!, end)).toBe(true)
    expect(near(startsAt[1]!, [0, 0])).toBe(true)
    expect(near(startsAt[2]!, end)).toBe(true)
    // no full-width groove can be climb or conventional: the levels alternate direction
  })

  it('on a short open path: the ramp zigzags back and forth along it', () => {
    const path: Loop = { elements: [line([0, 0], [8, 0])] }
    const inp = input(path, { closed: false, side: 'on', through: false, depth: 1, stepdown: 1 })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    // the ramp needs 1 / tan 3° ≈ 19.1 mm: more than two lengths of 8 mm
    const turns = walk(tp).filter(
      (s) =>
        s.move.kind === 'line' &&
        s.move.to[2] < s.from[2] - 1e-9 &&
        Math.abs(s.move.to[0] - s.from[0]) > 1,
    )
    expect(turns.length).toBeGreaterThanOrEqual(3)
  })

  it('on an open path, wide slot: rings round the path and a finishing ring', () => {
    const path = hook()
    const inp = input(path, {
      closed: false,
      side: 'on',
      through: false,
      depth: 3,
      slotWidth: 12,
      stepdown: 3,
    })
    const tp = generateRegionProfile(inp, port).unwrap()
    expect(checkRules(inp, tp)).toEqual([])
    const fin = atLevel(tp, -3, 'finish').map((s) => distTo(path, [s.move.to[0], s.move.to[1]]))
    expect(fin.filter((d) => Math.abs(d - 3) < 1e-6).length).toBeGreaterThan(3)
  })

  it('zigzag walks: back from where the ramp ends to its start', () => {
    const fwd: Seg[] = [{ kind: 'line', from: [0, 0], to: [10, 0] }]
    const a = zigzag(fwd, 4)
    expect(segsLength(a.walked)).toBeCloseTo(4)
    expect(segsLength(a.back)).toBeCloseTo(4)
    const b = zigzag(fwd, 25) // 10 out, 10 back, 5 out
    expect(segsLength(b.walked)).toBeCloseTo(25)
    expect(segsLength(b.back)).toBeCloseTo(5)
    expect(segPoint(b.back.at(-1)!, 1)).toEqual([0, 0])
  })
})

function segPointOfPath(path: Loop): Vec2 {
  return path.elements.at(-1)!.b
}

describe('generateRegionProfile: errors and abort', () => {
  const rules = (inp: RegionProfileInput) => {
    const r = generateRegionProfile(inp, port)
    expect(r.isErr()).toBe(true)
    return { code: r.unwrapErr().code, rules: r.unwrapErr().issues.map((i) => i.rule) }
  }

  it('refuses invalid operations', () => {
    expect(rules(input(hook(), { closed: false }))).toEqual({
      code: 'model.invariant',
      rules: ['openNeedsOn'],
    })
    expect(rules(input(bracket(), { through: false })).rules).toContain('onlyOn')
    expect(
      rules(
        input(hook(), {
          closed: false,
          side: 'on',
          tabs: { positions: [5], width: 4, thickness: 2 },
        }),
      ).rules,
    ).toContain('tabsNotAllowed')
    expect(
      rules(input(bracket(), { tabs: { positions: [10, 12], width: 4, thickness: 2 } })).rules,
    ).toContain('tabsOverlap')
    expect(
      rules(input(bracket(), { tabs: { positions: [1000], width: 4, thickness: 2 } })).rules,
    ).toContain('tabOutside')
    expect(
      rules(input(bracket(), { tabs: { positions: [10], width: 4, thickness: 7 } })).rules,
    ).toContain('range')
    expect(
      rules(input({ elements: [line([0, 0], [10, 0]), line([10, 0], [0, 0])] })).rules,
    ).toContain('noArea')
    expect(rules(input(bracket(), { stepover: 7 })).rules).toContain('atMost')
    expect(rules(input(bracket(), { strategy: { leadRadius: -1 } })).rules).toContain('nonNegative')
  })

  it('refuses a tool wider than the slot or the opening', () => {
    expect(rules(input(bracket(), { slotWidth: 5 }))).toEqual({
      code: 'plan.check',
      rules: ['toolTooLarge'],
    })
    expect(rules(input(circle(0, 0, 2.9), { side: 'inside' }))).toEqual({
      code: 'plan.check',
      rules: ['toolTooLarge'],
    })
    // within TOOL_FIT_TOLERANCE is accepted
    expect(generateRegionProfile(input(circle(0, 0, 2.995), { side: 'inside' }), port).isOk()).toBe(
      true,
    )
  })

  it('aborts between passes', () => {
    const r = generateRegionProfile(input(bracket()), port, { step: () => aborted() })
    expect(r.isErr() && r.unwrapErr().code).toBe('op.aborted')
  })
})

// ---------------------------------------------------------------- coverage oracle

/** The slot as a region and its tool-centre region (a thin band when the slot is D wide). */
function slotRegions(inp: RegionProfileInput): { slot: Region; c0: Region } {
  const { chain, closed, side, slotWidth: sw } = inp.operation
  const c0 = centres(inp, 1e-3)
  if (!closed) return { slot: port.offsetPath(chain, sw / 2).unwrap(), c0 }
  const L = port.normalise([chain]).unwrap()
  const off = (d: number) => port.offset(L, d).unwrap()
  const slot =
    side === 'outside'
      ? port.difference(off(-sw), L).unwrap()
      : side === 'inside'
        ? port.difference(L, off(sw)).unwrap()
        : port.difference(off(-sw / 2), off(sw / 2)).unwrap()
  return { slot, c0 }
}

function cover(
  inp: RegionProfileInput,
  size: { length: number; width: number },
  cell: number,
  bands: GeneralTabBand[] = [],
) {
  const tp = generateRegionProfile(inp, port).unwrap()
  const { slot, c0 } = slotRegions(inp)
  const swept = port.offset(c0, -R).unwrap()
  const expectedRest = regionArea(port.difference(slot, swept).unwrap())
  const tabTop = inp.operation.onZ - inp.operation.depth + inp.operation.tabs.thickness
  const cov = regionCoverage(
    slot,
    c0,
    tp,
    inp.tool,
    size,
    bottomOf(inp),
    cell,
    0.01,
    bands.length === 0
      ? undefined
      : {
          inBand: (p) => inBand(bands, p),
          nearBand: (p) => diskHitsGeneralBands(p, 2 * R + cell, bands),
          top: tabTop,
        },
  )
  return { cov, expectedRest, rules: checkRules(inp, tp) }
}

function enclosure(): { outline: Loop; cavity: Loop } {
  const proc = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process
  const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
  const shapes = importSvg(svg).unwrap().shapes
  const loopOf = (name: string): Loop => {
    const item = shapes.find((s) => s.name === name)!.items[0]!
    if (item.kind !== 'loop') throw new Error('expected a loop')
    return item.loop
  }
  const placed = placeLoops([loopOf('outline'), loopOf('cavity')], 12)
  return { outline: placed.loops[0]!, cavity: placed.loops[1]! }
}

describe('coverage oracle (heightmap)', () => {
  it(
    'outside profile of the enclosure outline (X0) with tabs and finishing: no gouge, no leftover, tabs kept',
    { timeout: 60_000 },
    () => {
      const { outline } = enclosure()
      const positions = [40, 250, 480]
      const inp = input(outline, {
        slotWidth: 8,
        stepdown: 2,
        tabs: { positions, width: 8, thickness: 2 },
      })
      const bands = generalTabBands(outline, positions, 8, -8, 0)
      const { cov, rules } = cover(inp, { length: 274, width: 202 }, 0.25, bands)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.belowFloor).toBe(0)
      expect(cov.leftover).toBeLessThan(0.5)
      expect(cov.tabCut).toBe(0)
      expect(cov.tabKept).toBeGreaterThan(3 * 8 * 8 * 0.8)
    },
  )

  it(
    'outside profile of the enclosure outline, 6 tabs and one at 346.91 (known-issue repro): tabs kept, no gouge',
    { timeout: 60_000 },
    () => {
      const { outline } = enclosure()
      const positions = [...tabCentres(chainLength(outline), { count: 6 }), 346.91]
      const inp = input(outline, {
        slotWidth: 6,
        stepdown: 2,
        tabs: { positions, width: 6, thickness: 2 },
      })
      const bands = generalTabBands(outline, positions, 6, -6, 0)
      const { cov, rules } = cover(inp, { length: 274, width: 202 }, 0.25, bands)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.belowFloor).toBe(0)
      expect(cov.leftover).toBeLessThan(0.5)
      expect(cov.tabCut).toBe(0)
      expect(cov.tabKept).toBeGreaterThan(7 * 6 * 6 * 0.8)
    },
  )

  it(
    'inside profile of the enclosure cavity (X0): uncut = slot − swept within 1 %',
    { timeout: 60_000 },
    () => {
      const { cavity } = enclosure()
      const inp = input(cavity, { side: 'inside', slotWidth: 10, stepdown: 7 })
      const { cov, expectedRest, rules } = cover(inp, { length: 274, width: 202 }, 0.25)
      expect(rules).toEqual([])
      expect(cov.gouge).toBe(0)
      expect(cov.belowFloor).toBe(0)
      expect(cov.leftover).toBeLessThan(0.5)
      expect(Math.abs(cov.rest - expectedRest)).toBeLessThan(0.01 * expectedRest + 2)
    },
  )

  it('blind groove on an open path, wide slot: no gouge, no leftover', { timeout: 60_000 }, () => {
    const path = hook(15, 15)
    const inp = input(path, {
      closed: false,
      side: 'on',
      through: false,
      depth: 2,
      slotWidth: 11,
      stepdown: 1,
    })
    const { cov, expectedRest, rules } = cover(inp, { length: 75, width: 65 }, 0.1)
    expect(rules).toEqual([])
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(cov.leftover).toBeLessThan(0.05)
    expect(cov.rest).toBeLessThan(expectedRest + 0.5)
  })

  it(
    'bracket outside and on, wide slots, with tabs: no gouge, no leftover',
    { timeout: 60_000 },
    () => {
      const chain = bracket(20, 20)
      const positions = [25, 50 + (10 * Math.PI) / 4, 150]
      for (const side of ['outside', 'inside', 'on'] as const) {
        const sw = 11
        const inp = input(chain, {
          side,
          slotWidth: sw,
          stepdown: 3,
          tabs: { positions, width: 5, thickness: 2 },
        })
        const [lo, hi] = side === 'on' ? [-sw / 2, sw / 2] : side === 'outside' ? [-sw, 0] : [0, sw]
        const bands = generalTabBands(chain, positions, 5, lo, hi)
        const { cov, rules } = cover(inp, { length: 100, width: 80 }, 0.1, bands)
        expect(rules).toEqual([])
        expect(cov.gouge).toBe(0)
        expect(cov.belowFloor).toBe(0)
        expect(cov.leftover).toBeLessThan(0.05)
        expect(cov.tabCut).toBe(0)
        expect(cov.tabKept).toBeGreaterThan(0)
      }
    },
  )
})
