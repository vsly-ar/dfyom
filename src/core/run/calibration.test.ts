// v0.5 RV9 calibration cuts: programs (goldens), gouge-free and inside the footprint by the
// heightmap oracle, placement and the free spot, readings → suggestions.
// Doc: docs/modes/run-calibration.md
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { OPTS, programTool, testMachine } from '../post/post.fixture'
import { endMill, RATES } from '../toolpath/testing/fixtures'
import { Heightmap, samples, steps } from '../toolpath/testing/oracles'
import { fileSoftLimits } from './gcode-file'
import {
  calibrationExport,
  calibrationToolpaths,
  defaultDepth,
  dimensionSuggestions,
  findFreeSpot,
  footprintSize,
  ladderFactors,
  ladderSuggestion,
  placementProblems,
  toolpathReach,
  type CalibrationProgram,
  type CalibrationSpec,
  type CalibrationTooling,
  type Rect,
} from './calibration'

const tool = endMill(6)
const tooling: CalibrationTooling = {
  tool,
  cutting: {
    spindleSpeed: 18000,
    feedRate: 1000,
    plungeRate: 300,
    stepdown: 1.5,
    stepover: 2.4,
  },
  heights: { clearanceHeight: 10, retractHeight: 2 },
  maxFeedRate: RATES,
}
const STOCK = { length: 200, width: 120 }
const stockTop: Rect = { x: [0, STOCK.length], y: [0, STOCK.width] }

function program(spec: CalibrationSpec): CalibrationProgram {
  return expectOk(calibrationToolpaths(spec, tooling))
}

function gcode(p: CalibrationProgram): string {
  return expectOk(
    calibrationExport(p, {
      planName: 'Plan 1',
      machine: testMachine(),
      tool: programTool(tool),
      clearanceHeight: 10,
      stockThickness: 20,
      generator: OPTS.generator,
    }),
  ).text
}

/** Sweeps every feed move into a heightmap of the stock top; checks the rapids stay above it. */
function simulate(p: CalibrationProgram): Heightmap {
  const map = new Heightmap(STOCK.length, STOCK.width, 0.1)
  for (const { toolpath } of p.toolpaths) {
    // a rapid moves sideways only above the stock top (straight up out of a cut is fine)
    for (const s of steps(toolpath))
      if (
        s.move.kind === 'rapid' &&
        Math.hypot(s.move.to[0] - s.from[0], s.move.to[1] - s.from[1]) > 1e-9
      )
        for (const q of samples(s, 0.5)) expect(q[2]).toBeGreaterThanOrEqual(-1e-9)
    map.sweep(tool, toolpath, 0.05)
  }
  return map
}

/** Every lowered cell inside `rect`, none below `floor`. */
function expectInside(map: Heightmap, rect: Rect, floor: number): void {
  let lowered = 0
  for (let j = 0; j < map.ny; j++)
    for (let i = 0; i < map.nx; i++) {
      const z = map.z[j * map.nx + i]!
      if (z >= -1e-9) continue
      lowered++
      const [x, y] = map.center(i, j)
      expect(z).toBeGreaterThanOrEqual(floor - 1e-6)
      expect(x).toBeGreaterThanOrEqual(rect.x[0] - map.cell)
      expect(x).toBeLessThanOrEqual(rect.x[1] + map.cell)
      expect(y).toBeGreaterThanOrEqual(rect.y[0] - map.cell)
      expect(y).toBeLessThanOrEqual(rect.y[1] + map.cell)
    }
  expect(lowered).toBeGreaterThan(0)
}

const zAt = (map: Heightmap, x: number, y: number) =>
  map.z[Math.floor(y / map.cell) * map.nx + Math.floor(x / map.cell)]!

describe('dimension test', () => {
  const spec: CalibrationSpec = { test: 'dimension', at: [60, 40], size: 15 }
  const p = program(spec)

  it('matches its golden program', async () => {
    await expect(gcode(p)).toMatchFileSnapshot('__golden__/calibration-dimension.nc')
  })

  it('cuts only its footprint, to its depth, leaving the boss and walls of nominal size', () => {
    const depth = defaultDepth(6)
    expect(p.depth).toBe(depth)
    const map = simulate(p)
    expectInside(map, p.footprint, -depth)
    const [pocket, boss, slot] = p.features!
    if (pocket?.kind !== 'pocket' || boss?.kind !== 'boss' || slot?.kind !== 'slot')
      throw new Error('features')
    // the pocket is cleared to its depth inside and its walls stand at ± N/2
    const [px, py] = pocket.center
    expect(zAt(map, px, py)).toBeCloseTo(-depth, 6)
    expect(zAt(map, px + 7.4, py)).toBeCloseTo(-depth, 6)
    expect(zAt(map, px + 7.6, py)).toBe(0)
    // the boss's top is untouched, its groove cut, and the material beyond the groove stays
    const [bx, by] = boss.center
    expect(zAt(map, bx, by)).toBe(0)
    expect(zAt(map, bx + 7.4, by)).toBe(0)
    expect(zAt(map, bx + 7.6, by)).toBeCloseTo(-depth, 6)
    expect(zAt(map, bx + 7.5 + boss.groove - 0.1, by)).toBeCloseTo(-depth, 6)
    expect(zAt(map, bx + 7.5 + boss.groove + 0.1, by)).toBe(0)
    // the slot is one tool wide
    expect(zAt(map, slot.from[0] + 2.9, py)).toBeCloseTo(-depth, 6)
    expect(zAt(map, slot.from[0] - 3.1, py)).toBe(0)
  })

  it('stays inside the work area at a fitting work zero and is refused beyond it', () => {
    const lines = gcode(p).split('\n')
    const travel: [number, number, number] = [800, 800, 100]
    const workArea = { min: [-700, -700, -90], max: [-10, -10, -1] } as const
    const inside = fileSoftLimits(lines, {
      workZero: [-500, -500, -60],
      mpos: [-10, -10, -1],
      travel,
      workArea,
    })
    expect(inside).toEqual([])
    const outside = fileSoftLimits(lines, {
      workZero: [-95, -500, -60],
      mpos: [-10, -10, -1],
      travel,
      workArea,
    })
    expect(outside.map((f) => f.rule)).toContain('workArea')
  })

  it('refuses a size under twice the tool Ø, a tool other than a flat end mill and a deep depth', () => {
    const small = calibrationToolpaths({ ...spec, size: 10 }, tooling)
    expect(expectErrCode(small, 'input.malformed').issues[0]?.rule).toBe('toolTooLarge')
    const ball = { ...tooling, tool: { ...tool, type: 'ballEndMill' as const } }
    expectErrCode(calibrationToolpaths(spec, ball), 'plan.check')
    const deep = calibrationToolpaths({ ...spec, depth: 7 }, tooling)
    expect(expectErrCode(deep, 'input.malformed').issues[0]?.path).toEqual(['depth'])
  })
})

describe('feed ladder', () => {
  const spec: CalibrationSpec = { test: 'feedLadder', at: [60, 40], steps: 5, spread: 30 }

  it('matches its golden program', async () => {
    await expect(gcode(program(spec))).toMatchFileSnapshot('__golden__/calibration-ladder.nc')
  })

  it('steps the feed from −30 % to +30 %, each slot at its own feed and one level deep', () => {
    const p = program(spec)
    expect(ladderFactors(5, 30)).toEqual([0.7, 0.85, 1, 1.15, 1.3])
    expect(p.steps!.map((s) => s.feed)).toEqual([700, 850, 1000, 1150, 1300])
    expect(p.steps!.every((s) => s.stepdown === 1.5)).toBe(true)
    p.toolpaths.forEach(({ toolpath }, k) => {
      const flat = toolpath.passes
        .flatMap((x) => x.moves)
        .filter((m) => m.kind === 'line' && Math.abs(m.to[2] + 1.5) < 1e-9)
      expect(flat.at(-1)).toMatchObject({ feed: p.steps![k]!.feed })
    })
    const map = simulate(p)
    expectInside(map, p.footprint, -1.5)
    // never past the machine's X/Y max feed
    const slow = expectOk(
      calibrationToolpaths(spec, { ...tooling, maxFeedRate: [1100, 1200, 500] as const }),
    )
    expect(slow.steps!.map((s) => s.feed)).toEqual([700, 850, 1000, 1100, 1100])
  })

  it('steps the stepdown instead, capped at half the tool Ø for the base', () => {
    const p = program({ ...spec, vary: 'stepdown' })
    expect(p.steps!.map((s) => s.stepdown)).toEqual([1.05, 1.275, 1.5, 1.725, 1.95])
    expect(p.steps!.every((s) => s.feed === 1000)).toBe(true)
    expectInside(simulate(p), p.footprint, -1.95)
    expect(ladderSuggestion(p, 4)).toEqual({ vary: 'stepdown', step: 4, value: 1.725, percent: 15 })
  })
})

describe('placement', () => {
  const size = footprintSize({ test: 'dimension', size: 15 }, 6)
  const reachOf = (spec: CalibrationSpec) => program(spec).footprint

  it('is refused off the stock, over an operation and over an earlier cut', () => {
    const fp = reachOf({ test: 'dimension', at: [20, 20], size: 15 })
    expect(placementProblems(fp, stockTop, []).map((p) => p.rule)).toEqual(['outsideStock'])
    const ok = reachOf({ test: 'dimension', at: [60, 40], size: 15 })
    expect(placementProblems(ok, stockTop, [])).toEqual([])
    const op = {
      rect: { x: [90, 150], y: [10, 30] } as Rect,
      kind: 'operation' as const,
      ref: 'op1',
      label: 'Pocket 1',
    }
    expect(placementProblems(ok, stockTop, [op])).toEqual([
      { rule: 'operation', ref: 'op1', message: 'it would cut where Pocket 1 cuts' },
    ])
    const earlier = { rect: ok, kind: 'earlierCut' as const, ref: '0', label: 'the cut of 1 Dec' }
    expect(placementProblems(ok, stockTop, [earlier]).map((p) => p.rule)).toEqual(['earlierCut'])
  })

  it('finds the free spot nearest the work zero, or none', () => {
    const keep = [
      {
        rect: { x: [0, 100], y: [0, 120] } as Rect,
        kind: 'operation' as const,
        ref: 'a',
        label: 'A',
      },
    ]
    const at = findFreeSpot(size, stockTop, keep)!
    expect(at).toBeDefined()
    const fp: Rect = {
      x: [at[0] - size[0] / 2, at[0] + size[0] / 2],
      y: [at[1] - size[1] / 2, at[1] + size[1] / 2],
    }
    expect(placementProblems(fp, stockTop, keep)).toEqual([])
    expect(fp.x[0]).toBeCloseTo(102, 0)
    expect(findFreeSpot(size, { x: [0, 40], y: [0, 40] }, [])).toBeUndefined()
  })

  it("measures a toolpath's reach with the tool radius and arc bulges", () => {
    const p = program({ test: 'dimension', at: [60, 40], size: 15 })
    const r = toolpathReach(p.toolpaths[0]!.toolpath, 3)!
    // the pocket: its walls at ± 7.5 from the centre
    const c = p.features![0]!
    if (c.kind !== 'pocket') throw new Error('pocket')
    expect(r.x[0]).toBeCloseTo(c.center[0] - 7.5, 6)
    expect(r.x[1]).toBeCloseTo(c.center[0] + 7.5, 6)
  })
})

describe('suggestions', () => {
  const nominal = { size: 15, depth: 2, diameter: 6 }

  it('reads a wider tool and a long X from the pocket and the boss', () => {
    // tool 0.06 wider; X 0.5 % long; Y exact
    const s = 1.005
    const r = {
      pocketX: 15 * s + 0.06,
      bossX: 15 * s - 0.06,
      pocketY: 15.06,
      bossY: 14.94,
      depth: 2.01,
    }
    expect(dimensionSuggestions(nominal, r, { x: 80, y: 80 })).toEqual([
      { kind: 'stepsPerMm', axis: 'x', setting: '$100', scale: 0.005, line: '$100=79.602' },
      { kind: 'toolDiameter', diameter: 6.06, delta: 0.06 },
    ])
  })

  it('takes the slot, hints backlash and depth, and says ok when all agree', () => {
    expect(dimensionSuggestions(nominal, { slot: 6.05 })).toEqual([
      { kind: 'toolDiameter', diameter: 6.05, delta: 0.05 },
    ])
    expect(
      dimensionSuggestions(nominal, { pocketX: 15.1, bossX: 14.9, pocketY: 15, bossY: 15 }),
    ).toEqual([
      { kind: 'toolDiameter', diameter: 6.05, delta: 0.05 },
      { kind: 'backlash', axis: 'x', difference: 0.1 },
    ])
    expect(dimensionSuggestions(nominal, { depth: 2.2 })).toEqual([{ kind: 'depth', error: 0.2 }])
    expect(dimensionSuggestions(nominal, { pocketX: 15.01, bossX: 14.99 })).toEqual([
      { kind: 'ok' },
    ])
    // no $100 line without the controller's value
    expect(dimensionSuggestions(nominal, { pocketX: 15.2, bossX: 15.2 })[0]).toEqual({
      kind: 'stepsPerMm',
      axis: 'x',
      setting: '$100',
      scale: 0.013333,
    })
  })
})
