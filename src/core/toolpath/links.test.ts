// Safe links (hardening DF64, L1): the in-process stock height field and `planLinks`.
// Doc: docs/modes/safe-links.md
import { describe, expect, it } from 'vitest'
import { generateDrilling } from './drilling'
import { generateFacing } from './facing'
import { planLinks, type LinkOperation, type LinkSettings } from './links'
import type { Move, Toolpath, ToolpathTool, Vec3 } from './model'
import { generatePocket } from './pocket'
import { generateProfile } from './profile'
import { StockHeights, toolSurface } from './stock-heights'
import { workholdingObstacles } from '../plan/workholding/obstacles'
import { moveEnd } from './stats'
import { turnToolpath } from './wcs'
import {
  bullNose,
  drill,
  drillingInput,
  endMill,
  facingInput,
  pocketInput,
  profileInput,
  RATES,
} from './testing/fixtures'
import { Heightmap, samples, steps } from './testing/oracles'

const STOCK = { length: 100, width: 60, thickness: 12 }
const D6 = endMill(6)

const facing = (tool = D6) =>
  generateFacing(
    facingInput(STOCK, tool, { operation: { kind: 'facing', id: 'f', depth: 1 } }),
  ).unwrap()

const pocket = (id: string, x: number, y: number, tool = D6, depth = 3) =>
  generatePocket(
    pocketInput(
      STOCK,
      {
        kind: 'pocket',
        id,
        onZ: 0,
        shape: { center: [x, y], contour: { kind: 'circle', radius: 8 } },
        depth,
        floorRadius: 0,
      },
      tool,
    ),
  ).unwrap()

const hole = (id: string, x: number, y: number, tool = drill(5)) =>
  generateDrilling(
    drillingInput(
      STOCK,
      {
        kind: 'drilling',
        id,
        onZ: 0,
        center: [x, y],
        diameter: tool.diameter,
        bottom: { kind: 'drillPoint', depth: 4, pointAngle: 118 },
      },
      tool,
      { cycle: 'simple', breakthrough: 0 },
    ),
  ).expect('hole')

const op = (toolpath: Toolpath, tool: ToolpathTool, pauseBefore = false): LinkOperation => ({
  toolpath,
  tool,
  pauseBefore,
})

const settings = (over: Partial<LinkSettings> = {}): LinkSettings => ({
  retraction: 'minimum',
  clearance: 10,
  margin: 2,
  stock: [STOCK.length, STOCK.width, STOCK.thickness],
  rates: [...RATES],
  ...over,
})

const allMoves = (tp: Toolpath): Move[] => tp.passes.flatMap((p) => p.moves)

describe('StockHeights', () => {
  it('starts at Z0 inside the stock, without material outside', () => {
    const f = new StockHeights([10, 10], { minX: -5, minY: -5, maxX: 15, maxY: 15 })
    expect(f.height(f.cellAt(5, 5))).toBe(0)
    expect(f.height(f.cellAt(-3, 5))).toBe(-Infinity)
    expect(f.floor[f.cellAt(5, 5)]).toBe(Infinity)
  })

  it('lowers only the cells the tool covers wholly (conservative rasterisation)', () => {
    const f = new StockHeights([20, 20], { minX: 0, minY: 0, maxX: 20, maxY: 20 })
    const moves: Move[] = [
      { kind: 'rapid', to: [5, 10, 2] },
      { kind: 'line', to: [5, 10, -2], feed: 100 },
      { kind: 'line', to: [15, 10, -2], feed: 100 },
    ]
    f.cut(D6, undefined, moves, -12)
    expect(f.height(f.cellAt(10.2, 10.2))).toBe(-2)
    // the tool's edge runs along y = 13: the cell [12.5, 13] is covered, [13, 13.5] is not
    expect(f.height(f.cellAt(10.2, 12.7))).toBe(-2)
    expect(f.height(f.cellAt(10.2, 13.2))).toBe(0)
    // the corner cells at the line's ends are only partly covered
    expect(f.height(f.cellAt(2.2, 12.7))).toBe(0)
  })

  it('is an upper bound of the simulated cut for every tool shape', () => {
    // a ramp, a helix, a half circle, a level line and a drill cycle
    const moves: Move[] = [
      { kind: 'rapid', to: [20, 20, 2] },
      { kind: 'line', to: [40, 25, -1.3], feed: 300 },
      { kind: 'arc', to: [40, 25, -2.1], center: [44, 25], cw: false, feed: 300 },
      { kind: 'arc', to: [48, 25, -2.1], center: [44, 25], cw: true, feed: 300 },
      { kind: 'line', to: [70, 40, -2.1], feed: 300 },
      { kind: 'rapid', to: [70, 40, 2] },
      { kind: 'rapid', to: [80, 15, 2] },
      {
        kind: 'drill',
        at: [80, 15],
        top: 0,
        bottom: -4,
        cycle: 'peck',
        peck: 1.5,
        retract: 2,
        feed: 100,
      },
    ]
    const tp: Toolpath = {
      planOperationId: 'x',
      tool: 't',
      spindleSpeed: 1000,
      passes: [{ kind: 'rough', moves }],
      stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
    }
    const chamfer: ToolpathTool = { ...endMill(6), type: 'chamferMill', angle: 90, tipDiameter: 1 }
    for (const tool of [D6, bullNose(6, 3), bullNose(8, 1), drill(5), chamfer]) {
      const f = new StockHeights([100, 60], { minX: 0, minY: 0, maxX: 100, maxY: 60 })
      f.cut(tool, undefined, moves, -12)
      const hm = new Heightmap(100, 60, 0.1)
      for (const s of steps(tp))
        if (s.move.kind !== 'rapid') for (const p of samples(s, 0.05)) hm.stamp(tool, p)
      let lowered = 0
      const below: string[] = []
      for (let j = 0; j < hm.ny; j++)
        for (let i = 0; i < hm.nx; i++) {
          const [x, y] = hm.center(i, j)
          const h = f.height(f.cellAt(x, y))
          if (h < hm.z[j * hm.nx + i]! - 1e-6) below.push(`${tool.type} at ${x}, ${y}`)
          if (h < 0) lowered++
        }
      expect(below).toEqual([])
      // and it is not empty: most of the cut shows
      expect(lowered).toBeGreaterThan(1000)
    }
  })

  it('pins the kerf of a through cut at Z0', () => {
    const f = new StockHeights([20, 20], { minX: 0, minY: 0, maxX: 20, maxY: 20 })
    f.cut(
      D6,
      undefined,
      [
        { kind: 'rapid', to: [5, 10, 2] },
        { kind: 'line', to: [5, 10, -12.5], feed: 100 },
        { kind: 'line', to: [15, 10, -12.5], feed: 100 },
      ],
      -12,
    )
    expect(f.top[f.cellAt(10, 10)]).toBe(-12.5)
    expect(f.height(f.cellAt(10, 10))).toBe(0)
  })

  it('the tool surface is shared with the oracle', () => {
    expect(toolSurface(bullNose(6, 3), 3)).toBeCloseTo(3)
    expect(toolSurface(D6, 3.1)).toBe(Infinity)
  })
})

describe('planLinks', () => {
  it('links two pockets in a faced setup low, through the field', () => {
    const a = pocket('a', 25, 30)
    const b = pocket('b', 75, 30)
    const ops = [op(facing(), D6), op(a, D6), op(b, D6)]
    const r = planLinks(ops, settings())
    expect(r.collisions).toEqual([])
    expect(r.links).toHaveLength(2)
    // over the faced top at −1: −1 + 2 = 1, below the entry on the retract plane at 2
    const [fromFacing, between] = r.links
    expect(between).toMatchObject({ low: true, level: 2, floor: 1 })
    expect(between!.seconds).toBeLessThan(between!.fullSeconds)
    // the facing ends beyond the stock edge, outside the cleared footprint's margin: unknown clamps
    expect(fromFacing).toMatchObject({ low: false, level: 10 })
    expect(fromFacing!.withClampSeconds).toBeLessThan(fromFacing!.fullSeconds)
    expect(r.summary).toMatchObject({ count: 2, low: 1, atClearance: 1 })
    expect(r.summary.savedSeconds).toBeGreaterThan(0)
    // the cut moves stay, only the links change
    const cuts = (list: readonly Toolpath[]) =>
      list.flatMap((t) => allMoves(t).filter((m) => m.kind !== 'rapid'))
    expect(cuts(r.toolpaths)).toEqual(cuts(ops.map((o) => o.toolpath)))
    // pocket b starts on its retract plane: the link arrives there (no descent)
    expect(allMoves(r.toolpaths[2]!)[0]!.kind).not.toBe('rapid')
    expect(allMoves(r.toolpaths[1]!).at(-1)).toEqual({ kind: 'rapid', to: [75, 27.6, 2] })
  })

  it('keeps links over uncut stock at the clearance height without a clamp height', () => {
    const ops = [op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)]
    const r = planLinks(ops, settings())
    expect(r.links[0]).toMatchObject({ low: false, level: 10 })
    expect(r.toolpaths).toEqual(ops.map((o) => o.toolpath))
    expect(r.clampHeightUnknown?.links).toBe(1)
    expect(r.clampHeightUnknown?.savedSeconds).toBeGreaterThan(0)
    // a clamp height of 0: 2 mm over the stock top
    const zero = planLinks(ops, settings({ clampHeight: 0 }))
    expect(zero.links[0]).toMatchObject({ low: true, level: 2 })
    expect(zero.clampHeightUnknown).toBeUndefined()
    // 12 mm clamps under a 10 mm clearance: nothing to lower
    expect(planLinks(ops, settings({ clampHeight: 12 })).links[0]).toMatchObject({ low: false })
    const five = planLinks(ops, settings({ clampHeight: 5 }))
    expect(five.links[0]).toMatchObject({ low: true, level: 7 })
  })

  // workholding.md#obstacle-interface-for-df64s-link-pass: modelled items replace the clamp height
  it('keeps links above the workholding items, which supersede the clamp height', () => {
    const ops = [op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)]
    const block = (x0: number, x1: number, top: number) =>
      workholdingObstacles(
        [
          {
            itemId: 'b',
            footprint: {
              kind: 'polygon',
              points: [
                [x0, 20],
                [x1, 20],
                [x1, 40],
                [x0, 40],
              ],
            },
            zMin: -Infinity,
            zMax: top,
          },
        ],
        2,
      )
    // an item away from the link: the stock alone bounds it; the clamp height is ignored
    const far = planLinks(ops, settings({ clampHeight: 12, obstacles: block(140, 150, 30) }))
    expect(far.links[0]).toMatchObject({ low: true, level: 2 })
    expect(far.clampHeightUnknown).toBeUndefined()
    // an item between the pockets, top Z4 + 2 mm margin: the link crosses at Z6
    const near = planLinks(ops, settings({ obstacles: block(45, 55, 4) }))
    expect(near.links[0]).toMatchObject({ low: true, level: 6 })
    expect(near.collisions).toEqual([])
    const across = allMoves(near.toolpaths[0]!).at(-1)!
    expect(moveEnd(across)[2]).toBeGreaterThanOrEqual(
      block(45, 55, 4).floorAlong([25, 30], [75, 30], 3),
    )
    // a tall item: the link stays at the clearance height, with no clamp height to ask for
    const tall = planLinks(ops, settings({ obstacles: block(45, 55, 9) }))
    expect(tall.links[0]).toMatchObject({ low: false, level: 10 })
    expect(tall.clampHeightUnknown).toBeUndefined()
    expect(tall.toolpaths).toEqual(ops.map((o) => o.toolpath))
  })

  // alignment.md S12: a moved work zero shifts the toolpaths into the WCS; the stock field moves
  // with them (origin −zero) and the items are read at +zero, so every link stays the same
  it('gives the same links with a moved work zero (toolpaths in the WCS)', () => {
    const zero = [80, 50] as const
    const item = workholdingObstacles(
      [
        {
          itemId: 'b',
          footprint: {
            kind: 'polygon',
            points: [
              [45, 20],
              [55, 20],
              [55, 40],
              [45, 40],
            ],
          },
          zMin: -Infinity,
          zMax: 4,
        },
      ],
      2,
    )
    const shift = (o: LinkOperation): LinkOperation => ({
      ...o,
      toolpath: turnToolpath(o.toolpath, { rotation: 0, size: [0, 0], zero: [...zero] }),
    })
    const cases: [LinkOperation[], Partial<LinkSettings>][] = [
      [[op(facing(), D6), op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)], {}],
      [[op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)], {}],
      [[op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)], { clampHeight: 0 }],
      // known clamps, a margin above the retract plane: the uncut stock (the field) sets the level
      [
        [op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)],
        { obstacles: workholdingObstacles([], 2), margin: 3 },
      ],
      [[op(pocket('a', 25, 30), D6), op(pocket('b', 75, 30), D6)], { obstacles: item }],
    ]
    const shape = (r: ReturnType<typeof planLinks>) => ({
      links: r.links.map((l) => [l.low, l.level, Math.round(l.floor * 1e6) / 1e6]),
      unknown: r.clampHeightUnknown?.links,
      collisions: r.collisions.length,
    })
    for (const [ops, over] of cases) {
      const corner = planLinks(ops, settings(over))
      const moved = planLinks(ops.map(shift), settings({ ...over, zero }))
      expect(shape(moved)).toEqual(shape(corner))
    }
    // the case the field decides: over the stock top + 3
    expect(planLinks(cases[3]![0], settings(cases[3]![1])).links[0]).toMatchObject({ level: 3 })
  })

  it('never links across a pause, and full keeps every toolpath', () => {
    const ops = [op(facing(), D6), op(pocket('a', 25, 30), D6, true)]
    expect(planLinks(ops, settings()).links).toEqual([])
    const same = [op(facing(), D6), op(pocket('a', 25, 30), D6)]
    const full = planLinks(same, settings({ retraction: 'full' }))
    full.toolpaths.forEach((t, i) => expect(t).toBe(same[i]!.toolpath))
    expect(full.summary).toMatchObject({ count: 1, low: 0, atClearance: 1, savedSeconds: 0 })
  })

  it('lifts a link over the kerf of a through profile (the freed piece may move)', () => {
    const profile = generateProfile(
      profileInput(
        STOCK,
        {
          kind: 'profile',
          id: 'pr',
          shape: {
            center: [50, 30],
            contour: { kind: 'rectangle', length: 30, width: 20, cornerRadius: 0 },
          },
          side: 'inside',
          slotWidth: 6,
          tabs: { count: 0, width: 4, thickness: 2 },
        },
        D6,
      ),
    ).unwrap()
    const ops = [
      op(facing(), D6),
      op(profile, D6),
      op(pocket('a', 15, 30), D6),
      op(pocket('b', 85, 30), D6),
    ]
    const r = planLinks(ops, settings())
    expect(r.collisions).toEqual([])
    // the profile's exit is in its kerf (pinned at Z0): over the faced top elsewhere
    const fromKerf = r.links.find((l) => l.index === 2)!
    expect(fromKerf.level).toBeGreaterThanOrEqual(2)
    const across = r.links.find((l) => l.index === 3)!
    // pocket a → b passes over the kerf: Z0 + 2
    expect(across.level).toBe(2)
    expect(across.floor).toBeCloseTo(2)
  })

  it('drill to drill outside any cleared area stays high without a clamp height', () => {
    const d = drill(5)
    const ops = [op(hole('h1', 20, 20, d), d), op(hole('h2', 40, 20, d), d)]
    expect(planLinks(ops, settings()).links[0]!.low).toBe(false)
    expect(planLinks(ops, settings({ clampHeight: 0 })).links[0]!.low).toBe(true)
  })

  it('is deterministic and never slower', () => {
    const ops = [op(facing(), D6), op(pocket('a', 25, 30), D6), op(pocket('b', 75, 40), D6)]
    const a = planLinks(ops, settings())
    const b = planLinks(ops, settings())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    for (const l of a.links) expect(l.seconds).toBeLessThanOrEqual(l.fullSeconds)
  })

  it('a coarser field never lowers a link', () => {
    const ops = [op(facing(), D6), op(pocket('a', 25, 30), D6), op(pocket('b', 75, 40), D6)]
    const fine = planLinks(ops, settings({ clampHeight: 0 }))
    const coarse = planLinks(ops, settings({ clampHeight: 0, cell: 2 }))
    fine.links.forEach((l, i) => expect(coarse.links[i]!.level).toBeGreaterThanOrEqual(l.level))
  })
})

/** Positions after each move (for debugging failing cases). */
export function positions(tp: Toolpath): Vec3[] {
  return allMoves(tp).map((m) => (m.kind === 'drill' ? [m.at[0], m.at[1], m.retract] : m.to))
}
