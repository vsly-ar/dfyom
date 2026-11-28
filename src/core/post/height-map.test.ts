/**
 * Surface maps (v0.5 RV10): interpolation, filling, the compensation's properties (segment length,
 * arcs linearised, rapids above the clearance untouched, dz = 0 at the touch-off spot), the
 * refusals, and a golden of a followed engraving. Doc: docs/modes/run-surface.md
 */
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { endMill } from '../toolpath/testing/fixtures'
import type { Move, Toolpath, Vec3 } from '../toolpath/model'
import { exportGrbl } from './export'
import {
  applyHeightMap,
  filledHeights,
  mapHeight,
  mapProgress,
  mapRange,
  maxSegmentOf,
  type HeightMap,
} from './height-map'
import { exportInput, operation, OPTS } from './post.fixture'
import type { Block, MachiningProgram, ProgramZRef } from './program'

/** A tilted plane with a twist (bilinear-exact): h = 0.004 x − 0.002 y + 0.00002 x y. */
const surf = (x: number, y: number) => 0.004 * x - 0.002 * y + 0.00002 * x * y

function gridMap(
  cols = 4,
  rows = 3,
  spacing: readonly [number, number] = [20, 20],
  f = surf,
  over: Partial<HeightMap> = {},
): HeightMap {
  const z: number[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) z.push(f(c * spacing[0], r * spacing[1]))
  return { origin: [0, 0], spacing, cols, rows, z, workZero: [-400, -300], ...over }
}

const SPOT: ProgramZRef = { label: 'the top face', level: 0, at: [5, 5], top: true }
const TOOL = { name: '3 mm flat end mill', diameter: 3, type: 'flatEndMill' as const }

/** An engraving: a rectangle with a round end at Z −0.3, clearance 10, retract 2. */
function engraving(): Block[] {
  return [
    { kind: 'toolChange', number: 1, tool: TOOL, zRef: SPOT },
    { kind: 'spindle', rpm: 18000 },
    { kind: 'rapid', to: [10, 10, 10] },
    { kind: 'rapid', to: [10, 10, 2] },
    { kind: 'feed', to: [10, 10, -0.3], feed: 300 },
    { kind: 'feed', to: [60, 10, -0.3], feed: 1000 },
    { kind: 'arc', to: [60, 30, -0.3], i: 0, j: 10, cw: false, feed: 1000 },
    { kind: 'feed', to: [10, 30, -0.3], feed: 1000 },
    { kind: 'feed', to: [10, 10, -0.3], feed: 1000 },
    { kind: 'rapid', to: [10, 10, 10] },
    { kind: 'rapid', to: [40, 20, 10] },
  ]
}

function program(blocks: Block[] = engraving()): MachiningProgram {
  return {
    name: 'Plan 1',
    setupName: 'Setup 1',
    units: 'mm',
    spindleControl: 'gcode',
    clearanceZ: 10,
    blocks,
  }
}

/** The motion blocks' end points in order, with the position they start from. */
function motions(blocks: readonly Block[]): { from: Vec3 | undefined; b: Block }[] {
  const out: { from: Vec3 | undefined; b: Block }[] = []
  let pos: Vec3 | undefined
  for (const b of blocks) {
    if (b.kind === 'toolChange') pos = undefined
    if (b.kind !== 'rapid' && b.kind !== 'feed' && b.kind !== 'arc') continue
    out.push({ from: pos, b })
    pos = b.to
  }
  return out
}

describe('the map', () => {
  it('interpolates bilinearly and extrapolates one cell beyond the grid', () => {
    const map = gridMap()
    const h = mapHeight(map, expectOk(filledHeights(map)))
    for (const [x, y] of [
      [0, 0],
      [60, 40],
      [13.7, 29.1],
      [-20, -20],
      [80, 60],
      [70, 5],
    ] as const)
      expect(h(x, y)).toBeCloseTo(surf(x, y), 9)
    expect(h(-20.1, 0)).toBeUndefined()
    expect(h(0, 60.1)).toBeUndefined()
  })

  it('fills skipped points from their measured neighbours', () => {
    const base = gridMap(3, 3, [10, 10], () => 0)
    const z = [1, 2, 3, 4, null, 6, 7, 8, null]
    const map = { ...base, z, skipped: [4, 8] }
    expect(mapProgress(map)).toEqual({ measured: 7, needed: 7 })
    const f = expectOk(filledHeights(map))
    // both in the first ring: the mean of their measured neighbours (the centre's 7, the corner's 2)
    expect(f[4]).toBeCloseTo((1 + 2 + 3 + 4 + 6 + 7 + 8) / 7, 12)
    expect(f[8]).toBeCloseTo((6 + 8) / 2, 12)
    // a point with no measured neighbour waits for the next ring
    const ring = expectOk(
      filledHeights({
        ...gridMap(4, 2, [10, 10]),
        z: [2, null, null, null, 2, null, null, 4],
        skipped: [1, 2, 3, 5, 6],
      }),
    )
    // ring 1: 1 ← (2, 2), 5 ← (2, 2), 2 ← (4), 3 ← (4), 6 ← (4); nothing waits here
    expect(ring).toEqual([2, 2, 4, 4, 2, 2, 4, 4])
    const later = expectOk(
      filledHeights({
        ...gridMap(4, 2, [10, 10]),
        z: [2, null, null, null, 2, null, null, null],
        skipped: [1, 2, 3, 5, 6, 7],
      }),
    )
    // 2, 3, 6, 7 have no measured neighbour in ring 1: filled from 1 and 5 in ring 2 and on
    expect(later).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
    expect(mapRange(map)).toEqual({ min: 1, max: 8, range: 7 })
  })

  it('refuses an incomplete map, and a map whose points are all skipped', () => {
    const base = gridMap(2, 2, [10, 10])
    const e = expectErrCode(filledHeights({ ...base, z: [0, null, 0, 0] }), 'run.surfaceMap')
    expect(e.issues[0]?.rule).toBe('incomplete')
    expect(e.message).toContain('3 of 4')
    expectErrCode(
      filledHeights({ ...base, z: [null, null, null, null], skipped: [0, 1, 2, 3] }),
      'run.surfaceMap',
    )
    expectErrCode(filledHeights({ ...base, cols: 1 }), 'input.malformed')
  })

  it('splits at half the smaller spacing, at most 2 mm', () => {
    expect(maxSegmentOf(gridMap(4, 3, [20, 20]))).toBe(2)
    expect(maxSegmentOf(gridMap(4, 3, [3, 8]))).toBe(1.5)
  })
})

describe('following the map', () => {
  const map = gridMap()
  const heights = expectOk(filledHeights(map))
  const h = mapHeight(map, heights)
  const anchor = h(SPOT.at[0], SPOT.at[1])!

  it('splits every move below the clearance, linearises arcs, keeps rapids above it', () => {
    const p = program()
    const r = expectOk(applyHeightMap(p, map))
    const seg = maxSegmentOf(map)
    const ms = motions(r.program.blocks)
    for (const { from, b } of ms) {
      if (b.kind === 'arc') expect.fail('an arc below the clearance was kept')
      if (from !== undefined && (from[2] < 10 || b.to[2] < 10))
        expect(Math.hypot(b.to[0] - from[0], b.to[1] - from[1])).toBeLessThanOrEqual(seg + 1e-9)
    }
    // the rapids at the clearance are the same blocks, untouched
    const above = (bs: readonly Block[]) =>
      bs.filter((b) => b.kind === 'rapid' && b.to[2] >= 10).map((b) => JSON.stringify(b))
    expect(above(r.program.blocks)).toEqual(above(p.blocks))
    expect(r.surface.split).toBeGreaterThan(0)
    expect(r.surface.range).toBeCloseTo(Math.max(...heights) - Math.min(...heights), 12)
  })

  it('offsets each point by the map relative to the touch-off spot', () => {
    const r = expectOk(applyHeightMap(program(), map))
    let maxDz = 0
    for (const { b } of motions(r.program.blocks)) {
      if (b.to[2] >= 10) continue
      // the cut stays 0.3 below the surface as the map sees it, relative to the spot
      const dz = h(b.to[0], b.to[1])! - anchor
      maxDz = Math.max(maxDz, Math.abs(dz))
      if (b.kind === 'feed' && b.feed === 1000) expect(b.to[2]).toBeCloseTo(-0.3 + dz, 9)
    }
    expect(r.surface.maxDz).toBeCloseTo(maxDz, 9)
  })

  it('leaves Z exact at the touch-off spot (dz = 0)', () => {
    const blocks: Block[] = [
      { kind: 'toolChange', number: 1, tool: TOOL, zRef: SPOT },
      { kind: 'spindle', rpm: 18000 },
      { kind: 'rapid', to: [5, 5, 10] },
      { kind: 'feed', to: [5, 5, -1], feed: 300 },
      { kind: 'rapid', to: [5, 5, 10] },
    ]
    const r = expectOk(applyHeightMap(program(blocks), map))
    const plunge = r.program.blocks.find((b) => b.kind === 'feed')
    expect(plunge?.kind === 'feed' && plunge.to).toEqual([5, 5, -1])
  })

  it('anchors each tool run at its own touch-off spot', () => {
    const other: ProgramZRef = { label: 'Facing 1 floor', level: -0.5, at: [50, 30], top: false }
    const blocks: Block[] = [
      ...engraving(),
      { kind: 'toolChange', number: 2, tool: TOOL, zRef: other },
      { kind: 'spindle', rpm: 18000 },
      { kind: 'rapid', to: [50, 30, 10] },
      { kind: 'feed', to: [50, 30, -1], feed: 300 },
      { kind: 'feed', to: [20, 30, -1], feed: 300 },
    ]
    const r = expectOk(applyHeightMap(program(blocks), map))
    const last = r.program.blocks.slice(-1)[0]!
    expect(last.kind === 'feed' && last.to[2]).toBeCloseTo(-1 + h(20, 30)! - h(50, 30)!, 9)
    const plunge = r.program.blocks.findLast(
      (b) => b.kind === 'feed' && b.to[0] === 50 && b.to[1] === 30,
    )
    expect(plunge?.kind === 'feed' && plunge.to[2]).toBe(-1)
  })

  it('follows seeded random moves within the segment length and the offset', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) as number
    for (let n = 0; n < 20; n++) {
      const blocks: Block[] = [
        { kind: 'toolChange', number: 1, tool: TOOL, zRef: SPOT },
        { kind: 'spindle', rpm: 10000 },
        { kind: 'rapid', to: [rnd() * 60, rnd() * 40, 10] },
      ]
      for (let k = 0; k < 6; k++)
        blocks.push({ kind: 'feed', to: [rnd() * 60, rnd() * 40, -rnd() * 2], feed: 500 })
      const r = expectOk(applyHeightMap(program(blocks), map))
      for (const { from, b } of motions(r.program.blocks)) {
        if (from === undefined || b.to[2] >= 10) continue
        expect(Math.hypot(b.to[0] - from[0], b.to[1] - from[1])).toBeLessThanOrEqual(2 + 1e-9)
      }
    }
  })
})

describe('refusals', () => {
  const rule = (r: ReturnType<typeof applyHeightMap>) =>
    expectErrCode(r, 'run.surfaceMap').issues[0]?.rule

  it('a range over the follow limit', () => {
    const steep = gridMap(4, 3, [20, 20], (x) => 0.03 * x)
    expect(rule(applyHeightMap(program(), steep))).toBe('range')
    expectOk(applyHeightMap(program(), steep, { maxRange: 2 }))
  })

  it('a program that leaves the mapped area', () => {
    const small = { ...gridMap(2, 2, [20, 20]), origin: [5, 5] as const }
    // the grid spans X 5–25: one cell beyond is X 45; the first segment past it is refused
    const e = expectErrCode(applyHeightMap(program(), small), 'run.surfaceMap')
    expect(e.issues[0]?.rule).toBe('outside')
    expect(e.message).toContain('X 46.0 Y 10.0')
  })

  it('a touch-off spot outside the map, or none', () => {
    const far = { ...gridMap(), origin: [40, 40] as const }
    expect(rule(applyHeightMap(program(), far))).toBe('anchor')
    const noSpot = engraving().map((b): Block => {
      if (b.kind !== 'toolChange') return b
      const { zRef: _z, ...rest } = b
      return rest
    })
    expect(rule(applyHeightMap(program(noSpot), gridMap()))).toBe('anchor')
  })

  it('a rise reaching the clearance height', () => {
    const tall = gridMap(4, 3, [20, 20], (x) => (x >= 40 ? 12 : 0))
    expect(rule(applyHeightMap(program(), tall, { maxRange: 20 }))).toBe('clearance')
  })
})

describe('export with a surface map', () => {
  /** The engraving as a toolpath of one plan operation, its run touching off at (5, 5). */
  function engravingOp() {
    const tool = endMill(3)
    const moves: Move[] = [
      { kind: 'rapid', to: [10, 10, 10] },
      { kind: 'rapid', to: [10, 10, 2] },
      { kind: 'line', to: [10, 10, -0.3], feed: 300 },
      { kind: 'line', to: [60, 10, -0.3], feed: 1000 },
      { kind: 'arc', to: [60, 30, -0.3], center: [60, 20], cw: false, feed: 1000 },
      { kind: 'line', to: [10, 30, -0.3], feed: 1000 },
      { kind: 'line', to: [10, 10, -0.3], feed: 1000 },
      { kind: 'rapid', to: [10, 10, 10] },
    ]
    const tp: Toolpath = {
      planOperationId: 'engraving1',
      tool: tool.id,
      spindleSpeed: 18000,
      passes: [{ kind: 'finish', moves }],
      stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
    }
    return { ...operation(tp, tool, 'Engraving 1'), zRef: SPOT }
  }

  it('writes the followed engraving (golden)', async () => {
    const input = exportInput([engravingOp()])
    const plain = expectOk(exportGrbl(input, OPTS))
    const e = expectOk(exportGrbl({ ...input, heightMap: { map: gridMap() } }, OPTS))
    expect(plain.surface).toBeUndefined()
    expect(e.surface?.maxDz).toBeGreaterThan(0.1)
    expect(e.lines.length).toBeGreaterThan(plain.lines.length + 40)
    expect(e.lines.some((l) => /^G[23]\b/.test(l))).toBe(false)
    await expect(e.text).toMatchFileSnapshot('__golden__/height-map-engraving.nc')
  })

  it('refuses through the export', () => {
    const input = exportInput([engravingOp()])
    const far = { ...gridMap(), origin: [40, 40] as const }
    expectErrCode(exportGrbl({ ...input, heightMap: { map: far } }, OPTS), 'run.surfaceMap')
  })
})
