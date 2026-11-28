// generateLine (engraved-patterns.md E1): the depth profile by pass, the pass count, open lines
// alternating, the ramp-back (length, slope ≤ rampAngle, never below the pass), the zigzag of a
// short line, closed lines (direction kept, start at the middle of the longest element), helical
// arcs ≤ 90°, the plunge entry, the order (nearest end first) and coincident elements cut once.
// Doc: docs/modes/engraved-patterns.md#toolpath-plan
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { arc, line, type Element } from '../geometry/2d/model'
import { elementPoint, lineChains } from '../geometry/line'
import type { Shape } from '../geometry/model'
import { generateLine, linePassCount, passTarget, evalZ, type LineOperation } from './line'
import type { Move, Toolpath, Vec3 } from './model'
import { arcSweep } from './stats'
import { chamferMill, endMill, lineInput } from './testing/fixtures'

const STOCK = { length: 100, width: 60, thickness: 10 }
const TAN10 = Math.tan((10 * Math.PI) / 180)
const vBit = chamferMill(6, 60)

const openShape = (elements: Element[], center: [number, number] = [50, 30]): Shape => ({
  center,
  contour: { kind: 'path', path: { elements } },
})
const square = (x: number, y: number, s: number): Shape => ({
  center: [x, y],
  contour: {
    kind: 'region',
    region: {
      pieces: [
        {
          outer: {
            elements: [
              line([0, 0], [s, 0]),
              line([s, 0], [s, s]),
              line([s, s], [0, s]),
              line([0, s], [0, 0]),
            ],
          },
          holes: [],
        },
      ],
    },
  },
})

const lineOp = (paths: Shape[], start: number, end = start): LineOperation => ({
  kind: 'line',
  id: 'line1',
  onZ: 0,
  paths,
  depth: { start, end },
  cutter: { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 },
})

/** A straight 40 mm line then a half circle (r 10), placed at (50, 30). */
const curve = () => openShape([line([-30, 0], [10, 0]), arc([10, 0], [30, 0], [20, 0], true)])

/** Every move with the position it starts from. */
type Motion = Exclude<Move, { kind: 'drill' }>

function moves(tp: Toolpath): { from: Vec3; m: Motion }[] {
  const out: { from: Vec3; m: Motion }[] = []
  let at: Vec3 = [0, 0, 10]
  for (const p of tp.passes)
    for (const m of p.moves) {
      if (m.kind === 'drill') continue
      out.push({ from: at, m })
      at = m.to
    }
  return out
}

const horizontal = (from: Vec3, m: Move): number => {
  if (m.kind === 'line' || m.kind === 'rapid')
    return Math.hypot(m.to[0] - from[0], m.to[1] - from[1])
  if (m.kind === 'arc')
    return Math.abs(arcSweep(from, m)) * Math.hypot(from[0] - m.center[0], from[1] - m.center[1])
  return 0
}

describe('depth profile and passes', () => {
  it('cuts ⌈max depth / stepdown⌉ passes, pass k no deeper than k · stepdown', () => {
    expect(linePassCount(1.5, 0.5)).toBe(3)
    expect(linePassCount(1.2, 0.5)).toBe(3)
    expect(linePassCount(0.2, 0.5)).toBe(1)
    const z = { s: [0, 130], z: [-0.2, -1.5] }
    const p1 = passTarget(z, 0, 1, 0.5)
    expect(evalZ(p1, 0)).toBeCloseTo(-0.2, 9)
    expect(evalZ(p1, 130)).toBeCloseTo(-0.5, 9)
    // the crossing with −0.5 is a breakpoint: (0.5 − 0.2) / 1.3 × 130 = 30
    expect(p1.s.some((s) => Math.abs(s - 30) < 1e-9)).toBe(true)
    const p3 = passTarget(z, 0, 3, 0.5)
    expect(evalZ(p3, 65)).toBeCloseTo(-0.85, 9)
    expect(evalZ(p3, 130)).toBeCloseTo(-1.5, 9)
  })
})

describe('open lines', () => {
  const tp = expectOk(generateLine(lineInput(STOCK, lineOp([curve()], 0.2, 1.5), vBit)))
  const all = moves(tp)
  const feeds = all.filter((x) => x.m.kind === 'line' || x.m.kind === 'arc')

  it('reaches the profile: the start depth at the start, the end depth at the end', () => {
    const zs = feeds.map((x) => x.m.to[2])
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 9)
    // the last pass (3, odd: forward) ends at the line's end at its end depth
    const last = feeds.at(-1)!.m.to
    expect(last[0]).toBeCloseTo(80, 9)
    expect(last[1]).toBeCloseTo(30, 9)
    expect(last[2]).toBeCloseTo(-1.5, 9)
  })

  it('alternates direction: no move back to the start between passes', () => {
    // the only rapids are the approach and the final retract
    expect(all.filter((x) => x.m.kind === 'rapid')).toHaveLength(3)
  })

  it('ramps at ≤ 10° and feeds down vertically only on the first approach', () => {
    for (const { from, m } of feeds) {
      const h = horizontal(from, m)
      const dz = Math.abs(m.to[2] - from[2])
      if (h < 1e-9) {
        // the approach: down from the retract height to the face at the plunge rate
        expect(m.kind === 'line' && m.feed === 300 && m.to[2] >= -1e-9).toBe(true)
        continue
      }
      expect(dz / h).toBeLessThanOrEqual(TAN10 + 1e-9)
    }
  })

  it('splits arcs at 90°: helical arcs with a linear Z', () => {
    const arcs = all.filter((x) => x.m.kind === 'arc')
    expect(arcs.length).toBeGreaterThan(0)
    for (const { from, m } of arcs)
      if (m.kind === 'arc')
        expect(Math.abs(arcSweep(from, m))).toBeLessThanOrEqual(Math.PI / 2 + 1e-9)
    expect(arcs.some(({ from, m }) => Math.abs(m.to[2] - from[2]) > 1e-6)).toBe(true)
  })

  it('a too short line zigzags on itself at ≤ 10°', () => {
    const short = openShape([line([0, 0], [2, 0])])
    const t = expectOk(
      generateLine(lineInput(STOCK, lineOp([short], 1), vBit, {}, { stepdown: 1 })),
    )
    const f = moves(t).filter((x) => x.m.kind === 'line' && horizontal(x.from, x.m) > 1e-9)
    for (const { from, m } of f)
      expect(Math.abs(m.to[2] - from[2]) / horizontal(from, m)).toBeLessThanOrEqual(TAN10 + 1e-9)
    expect(Math.min(...f.map((x) => x.m.to[2]))).toBeCloseTo(-1, 9)
    // 1 mm at 10° needs 5.7 mm: four legs of 2 mm, then the pass
    expect(f.length).toBeGreaterThanOrEqual(5)
  })

  it('with a plunge entry feeds straight down at the plunge rate', () => {
    const t = expectOk(
      generateLine(lineInput(STOCK, lineOp([curve()], 1), vBit, { entry: 'plunge' })),
    )
    const vertical = moves(t).filter(
      (x) => x.m.kind === 'line' && horizontal(x.from, x.m) < 1e-9 && x.m.to[2] < x.from[2],
    )
    expect(vertical.map((x) => x.m.to[2])).toEqual([-0.5, -1])
    for (const v of vertical) expect(v.m.kind === 'line' && v.m.feed).toBe(300)
  })

  it('enters each line at its nearer end, nearest first from the origin', () => {
    // elements are relative to the placed centre
    const a = openShape([line([0, 0], [20, 0])], [30, 10]) // (30, 10) → (50, 10)
    const b = openShape([line([20, 0], [0, 0])], [45, 40]) // (65, 40) → (45, 40)
    const t = expectOk(generateLine(lineInput(STOCK, lineOp([a, b], 0.3), vBit)))
    const rapids = moves(t).filter((x) => x.m.kind === 'rapid' && x.m.to[2] === 10)
    // a first (its start is nearest the origin), entered at its start: the ramp-back from x 30
    expect(rapids[0]!.m.to[1]).toBeCloseTo(10, 9)
    expect(rapids[0]!.m.to[0]).toBeGreaterThan(30)
    expect(rapids[0]!.m.to[0]).toBeLessThan(35)
    // from a's end (50, 10) b's end (45, 40) is nearer than its start: b is cut reversed
    const second = rapids.find((r) => Math.abs(r.m.to[1] - 40) < 1e-9)!
    expect(second.m.to[0]).toBeGreaterThan(45)
    expect(second.m.to[0]).toBeLessThan(50)
  })
})

describe('closed lines', () => {
  const op = lineOp([square(20, 20, 20)], 0.8)
  const tp = expectOk(generateLine(lineInput(STOCK, op, vBit)))
  const all = moves(tp)

  it('start at the middle of the longest element and keep their direction', () => {
    const first = all.find((x) => x.m.kind === 'line')!
    const l = lineChains(op).lines[0]!
    expect(first.m.to.slice(0, 2)).toEqual(elementPoint(l.elements[0]!, 0.5))
    // every horizontal move turns the same way round the square (counter-clockwise)
    const cross = all
      .filter((x) => x.m.kind === 'line' && horizontal(x.from, x.m) > 1e-6)
      .map(({ from, m }) => (from[0] - 30) * (m.to[1] - 30) - (from[1] - 30) * (m.to[0] - 30))
    expect(cross.every((c) => c >= -1e-9)).toBe(true)
  })

  it('ramp along the loop at ≤ 10° down to each pass, two passes of 0.5 and 0.8', () => {
    const feeds = all.filter((x) => x.m.kind === 'line' && horizontal(x.from, x.m) > 1e-9)
    for (const { from, m } of feeds)
      expect(Math.abs(m.to[2] - from[2]) / horizontal(from, m)).toBeLessThanOrEqual(TAN10 + 1e-9)
    const levels = [...new Set(feeds.map((x) => Math.round(x.m.to[2] * 1e6) / 1e6))]
    expect(levels).toContain(-0.5)
    expect(Math.min(...levels)).toBe(-0.8)
  })
})

describe('coincident elements', () => {
  it('two squares sharing an edge cut it once: a loop and an open run of three', () => {
    const op = lineOp([square(20, 20, 10), square(30, 20, 10)], 0.5)
    const c = lineChains(op)
    expect(c.coincident).toBe(1)
    expect(c.lines.map((l) => [l.closed, l.elements.length])).toEqual([
      [true, 4],
      [false, 3],
    ])
  })

  it('keep the deeper of two coincident elements', () => {
    const a = openShape([line([0, 0], [10, 0])], [20, 20])
    const b = openShape([line([10, 0], [0, 0])], [20, 20])
    const c = lineChains({ paths: [a, b], depth: { start: 0.2, end: 1 } })
    expect(c.coincident).toBe(1)
    // both reach 1 mm at one end: equal, the later goes
    expect(c.lines).toHaveLength(1)
  })
})

it('an end mill cuts a slot line the same way (ball and flat tools)', () => {
  const t = expectOk(
    generateLine(
      lineInput(
        STOCK,
        { ...lineOp([curve()], 1), cutter: { kind: 'flat', diameter: 3 } },
        endMill(3),
      ),
    ),
  )
  expect(Math.min(...moves(t).map((x) => x.m.to[2]))).toBeCloseTo(-1, 9)
})

describe('generateLine from an as-cut groove (DF135 C4 follow-up)', () => {
  const zsOf = (tp: Toolpath) =>
    moves(tp)
      .filter(({ m }) => m.kind !== 'rapid')
      .map(({ m }) => m.to[2])
  const rapidsBelow = (tp: Toolpath, z: number) =>
    moves(tp).filter(({ m }) => m.kind === 'rapid' && m.to[2] < z).length

  it('drops the passes nowhere below the old floor and enters the first kept one from it', () => {
    const full = expectOk(generateLine(lineInput(STOCK, lineOp([curve()], 2), vBit)))
    const input = { ...lineInput(STOCK, lineOp([curve()], 2), vBit), material: { top: -1.2 } }
    const tp = expectOk(generateLine(input))
    // passes at 0.5 mm: 4 in full, the first two (−0.5, −1) lie in the old groove
    const levels = (t: Toolpath) => [...new Set(zsOf(t).map((z) => Math.round(z * 1e6) / 1e6))]
    expect(Math.min(...zsOf(tp))).toBeCloseTo(-2, 9)
    expect(levels(tp)).not.toContain(-0.5)
    expect(levels(tp)).not.toContain(-1)
    expect(levels(full)).toContain(-0.5)
    // nothing cut above the old floor but the feed down to it
    const cutting = moves(tp).filter(({ m }) => m.kind !== 'rapid')
    expect(cutting[0]!.m.to[2]).toBeCloseTo(-1.2, 9)
    expect(cutting.slice(1).every(({ m }) => m.to[2] <= -1.2 + 1e-9)).toBe(true)
    expect(rapidsBelow(tp, 0)).toBe(0)
    expect(tp.stats.cutLength).toBeLessThan(full.stats.cutLength)
  })

  it('keeps the last pass when the edit lies inside the old groove; no top is byte-equal', () => {
    const tp = expectOk(
      generateLine({
        ...lineInput(STOCK, lineOp([square(40, 20, 10)], 1), vBit),
        material: { top: -1.5 },
      }),
    )
    expect(Math.min(...zsOf(tp))).toBeCloseTo(-1, 9)
    // one pass at the floor (in the air), entered at it, never below it
    expect(new Set(zsOf(tp).map((z) => z.toFixed(9)))).toEqual(new Set([(-1).toFixed(9)]))
    const plain = lineInput(STOCK, lineOp([curve()], 1.3), vBit)
    expect(expectOk(generateLine({ ...plain, material: {} }))).toEqual(
      expectOk(generateLine(plain)),
    )
  })
})
