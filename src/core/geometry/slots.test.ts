// The pocket's slot rule (heatsink presets H1, docs/modes/pattern-presets.md#implementation-h1):
// a straight slot as wide as the tool, open at both ends and closed, cut once per level along its
// centre line, alternating, nothing outside the slot's tool-centre line, no finishing ring, cut
// length = slot length × levels (+ the entries); 0.02 mm wider still uses the rule, 0.03 mm keeps
// the rings. H3 (docs/modes/pattern-presets.md#implementation-h3): a slot with round ends.
import { describe, expect, it } from 'vitest'
import type { Loop, Region } from './2d/model'
import { bulgeLoop, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { PocketStrategy, Toolpath } from '../toolpath/model'
import { TOOL_FIT_TOLERANCE } from '../toolpath/pocket'
import { generateRegionPocket, type RegionPocketInput } from '../toolpath/region-pocket'
import { SLOT_FIT_TOLERANCE, slotSplit } from './slots'
import { cutting, endMill, HEIGHTS, RATES } from '../toolpath/testing/fixtures'

const port = nodeRegion2d()
const D2 = endMill(2)
const FACE = { length: 40, width: 40 }

const strategy: PocketStrategy = {
  entry: 'ramp',
  helixDiameter: 1.6,
  rampAngle: 3,
  finishAllowance: 0.2,
  finishStepdown: 4,
  direction: 'climb',
}
const norm = (loops: Loop[]): Region => port.normalise(loops).unwrap()

function input(region: Region, depth = 1, stepdown = 0.25): RegionPocketInput {
  return {
    planOperationId: 'op-slot',
    tool: D2,
    cutting: cutting(D2, { stepdown, stepover: 0.8 }),
    heights: HEIGHTS,
    stock: { length: 40, width: 40, thickness: 14 },
    operation: { region, onZ: 0, depth },
    strategy,
    maxFeedRate: RATES,
  }
}

/** Splits like inputs.ts does and generates. */
function generate(region: Region, depth = 1, stepdown = 0.25) {
  const split = slotSplit(region, 2, strategy.finishAllowance, FACE)
  const base = input(split.region, depth, stepdown)
  const tp = generateRegionPocket(
    { ...base, operation: { ...base.operation, slots: split.slots } },
    port,
  ).unwrap()
  return { split, tp }
}

/** The moves with an end point (no drill cycles). */
const pathOf = (tp: Toolpath) =>
  tp.passes.flatMap((p) => p.moves).flatMap((m) => (m.kind === 'drill' ? [] : [m]))
const feeds = (tp: Toolpath) => pathOf(tp).filter((m) => m.kind === 'line' && m.to[2] < -1e-9)

describe('slot rule', () => {
  it("uses the pocket's tool-fit tolerance", () => {
    expect(SLOT_FIT_TOLERANCE).toBe(TOOL_FIT_TOLERANCE)
  })

  it('splits a sharp slot as wide as the tool, open where it reaches the stock edge', () => {
    const open = slotSplit(norm([rect(19, 0, 2, 40)]), 2, 0.2, FACE)
    expect(open.region.pieces).toEqual([])
    expect(open.slots).toHaveLength(1)
    const s = open.slots[0]!
    expect(s.openA && s.openB).toBe(true)
    // past the edge as an open pocket's tool centre: r √½ + allowance (+ 0.001)
    const past = Math.SQRT1_2 + 0.2 + 0.001
    const ys = [s.a[1], s.b[1]].sort((x, y) => x - y)
    expect(ys[0]).toBeCloseTo(-past, 9)
    expect(ys[1]).toBeCloseTo(40 + past, 9)
    expect(s.a[0]).toBeCloseTo(20, 9)

    const closed = slotSplit(norm([rect(19, 5, 2, 30)]), 2, 0.2, FACE).slots[0]!
    expect(closed.openA || closed.openB).toBe(false)
    expect([closed.a[1], closed.b[1]].sort((x, y) => x - y)).toEqual([6, 34])
  })

  it('takes 0.02 mm wider or narrower, not 0.03, and leaves other pieces', () => {
    const at = (w: number) => slotSplit(norm([rect(10, 5, w, 30)]), 2, 0.2, FACE).slots.length
    expect(at(2.02)).toBe(1)
    expect(at(1.98)).toBe(1)
    expect(at(2.03)).toBe(0)
    expect(at(1.97)).toBe(0)
    // a rounded slot, a square and a wide pocket keep the rings
    const other = norm([rect(2, 2, 2, 20, 0.5), rect(10, 2, 2, 2), rect(20, 2, 10, 20)])
    expect(slotSplit(other, 2, 0.2, FACE).slots).toEqual([])
  })

  it('H3: a round-ended slot as wide as the tool: its centre line ends at the arc centres', () => {
    // x 19–21, y 5–35 with semicircular ends (the tool's own closed-slot ends)
    const stadium = (w: number) =>
      norm([
        bulgeLoop([
          [20 + w / 2, 5 + w / 2, 0],
          [20 + w / 2, 35 - w / 2, 1],
          [20 - w / 2, 35 - w / 2, 0],
          [20 - w / 2, 5 + w / 2, 1],
        ]),
      ])
    const split = slotSplit(stadium(2), 2, 0.2, FACE)
    expect(split.region.pieces).toEqual([])
    const s = split.slots[0]!
    expect(s.openA || s.openB).toBe(false)
    expect([s.a[1], s.b[1]].sort((x, y) => x - y)).toEqual([6, 34])
    expect(s.a[0]).toBeCloseTo(20, 9)
    expect(slotSplit(stadium(2.02), 2, 0.2, FACE).slots).toHaveLength(1)
    expect(slotSplit(stadium(2.04), 2, 0.2, FACE).slots).toEqual([])
    // its ramped cut stays on the centre line between the arc centres
    const { tp } = generate(stadium(2), 1, 0.25)
    expect(tp.passes.map((p) => p.kind)).not.toContain('finish')
    for (const m of feeds(tp)) {
      expect(m.to[0]).toBeCloseTo(20, 9)
      expect(m.to[1]).toBeGreaterThanOrEqual(6 - 1e-9)
      expect(m.to[1]).toBeLessThanOrEqual(34 + 1e-9)
    }
  })

  it('open slot: once per level on the centre line, alternating, stepped down past the edge', () => {
    const { tp } = generate(norm([rect(19, 0, 2, 40)]), 1, 0.25)
    expect(tp.passes.map((p) => p.kind)).not.toContain('finish')
    const cuts = feeds(tp)
    // every feed below the top on the centre line
    for (const m of cuts) expect(m.to[0]).toBeCloseTo(20, 9)
    // per level: one plunge at the open end, one pass to the other end
    const along = cuts.filter((m, i) => i > 0 && Math.abs(m.to[1] - cuts[i - 1]!.to[1]) > 1)
    expect(along).toHaveLength(4)
    expect(along.map((m) => Math.sign(m.to[1] - 20))).toEqual([1, -1, 1, -1])
    // plunges only at the ends, past the stock edge
    for (const m of cuts.filter((x) => !along.includes(x)))
      expect(Math.abs(m.to[1] - 20)).toBeGreaterThan(20)
    // cut length: the centre line per level + the 4 plunges (0.25 each) and the rapids' stops
    const length = 40 + 2 * (Math.SQRT1_2 + 0.201)
    expect(tp.stats.cutLength).toBeGreaterThanOrEqual(4 * length - 1e-6)
    expect(tp.stats.cutLength).toBeLessThan(4 * length + 4 * (0.25 + 0.5) + 1e-6)
  })

  it('closed slot: ramps along its centre line, never past its ends', () => {
    const { tp } = generate(norm([rect(19, 5, 2, 30)]), 1, 0.25)
    const cuts = feeds(tp)
    for (const m of cuts) {
      expect(m.to[0]).toBeCloseTo(20, 9)
      expect(m.to[1]).toBeGreaterThanOrEqual(6 - 1e-9)
      expect(m.to[1]).toBeLessThanOrEqual(34 + 1e-9)
    }
    // no plunge into material: below the deepest level cut so far Z only falls along the line
    // (ramp ≤ 3°); straight down only through the slot already cut
    const moves = pathOf(tp)
    let prev = moves[0]!.to
    let deepest = 0
    for (const m of moves) {
      if (m.kind === 'line' && m.to[2] < deepest - 1e-9) {
        const from = Math.min(prev[2], deepest)
        const run = Math.hypot(m.to[0] - prev[0], m.to[1] - prev[1])
        expect((from - m.to[2]) / run).toBeLessThanOrEqual(Math.tan((3 * Math.PI) / 180) + 1e-9)
      }
      if (m.kind === 'line') deepest = Math.min(deepest, m.to[2])
      prev = m.to
    }
  })

  it('zigzags across several slots level by level, each slot once per level', () => {
    const xs = [5, 10, 15]
    const { tp } = generate(norm(xs.map((x) => rect(x - 1, 0, 2, 40))), 0.5, 0.25)
    const cuts = feeds(tp)
    const passes: { x: number; z: number }[] = []
    cuts.forEach((m, i) => {
      if (i > 0 && Math.abs(m.to[1] - cuts[i - 1]!.to[1]) > 1)
        passes.push({ x: m.to[0], z: m.to[2] })
    })
    expect(passes).toHaveLength(6)
    // level 1: all three slots, then level 2: all three back (nearest first)
    expect(passes.map((p) => p.z)).toEqual([-0.25, -0.25, -0.25, -0.5, -0.5, -0.5])
    expect(passes.map((p) => Math.round(p.x))).toEqual([5, 10, 15, 15, 10, 5])
  })

  it('cuts slots and other pieces in one pocket', () => {
    const { split, tp } = generate(norm([rect(4, 0, 2, 40), rect(20, 10, 10, 10)]), 0.5, 0.25)
    expect(split.slots).toHaveLength(1)
    expect(split.region.pieces).toHaveLength(1)
    const xs = feeds(tp).map((m) => m.to[0])
    expect(xs.some((x) => Math.abs(x - 5) < 1e-9)).toBe(true)
    expect(xs.some((x) => x > 20)).toBe(true)
  })
})
