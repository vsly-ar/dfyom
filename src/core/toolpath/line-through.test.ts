// A through Line (DF147 SL3, engraved-patterns.md § Cutting the part out along a line): an open end
// on or past the stock edge is entered from outside the stock at full pass depth (no plunge into
// material), an end inside the face keeps its ramp-back, passes alternate, and the slot is cut down
// to the depth: heightmap oracles (slot covered, nothing outside it cut, no move deeper than the
// stepdown into uncut material, DF144 `deepCuts`).
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { arc, line, type Element } from '../geometry/2d/model'
import type { Shape } from '../geometry/model'
import { generateLine, openLead, THROUGH_LEAD_CLEARANCE, type LineOperation } from './line'
import type { Toolpath, Vec3 } from './model'
import { endMill, lineInput } from './testing/fixtures'
import { Heightmap } from './testing/oracles'
import { deepCuts } from './testing/region-coverage'

const STOCK = { length: 100, width: 100, thickness: 10 }
const D = 6.22
const R = D / 2
const tool = endMill(D, 22)

const path = (elements: Element[]): Shape => ({
  center: [0, 0],
  contour: { kind: 'path', path: { elements } },
})

const through = (elements: Element[], depth = 10.4): LineOperation => ({
  kind: 'line',
  id: 'line1',
  onZ: 0,
  paths: [path(elements)],
  depth: { start: depth, end: depth },
  cutter: { kind: 'flat', diameter: D },
  through: true,
})

const feeds = (tp: Toolpath) =>
  tp.passes.flatMap((p) => p.moves).filter((m) => m.kind !== 'rapid' && m.kind !== 'drill')

/** Every move with where it starts. */
function withFrom(tp: Toolpath): { from: Vec3; to: Vec3; kind: string }[] {
  const out: { from: Vec3; to: Vec3; kind: string }[] = []
  let at: Vec3 = [0, 0, 10]
  for (const m of tp.passes.flatMap((p) => p.moves)) {
    if (m.kind === 'drill') continue
    out.push({ from: at, to: m.to, kind: m.kind })
    at = m.to
  }
  return out
}

/** Plunges: feed moves straight down below the face. */
const plunges = (tp: Toolpath) =>
  withFrom(tp).filter(
    (m) =>
      m.kind === 'line' &&
      m.to[2] < -1e-9 &&
      m.to[2] < m.from[2] - 1e-9 &&
      Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) < 1e-9,
  )

const generate = (op: LineOperation, stepdown = 1) =>
  expectOk(generateLine(lineInput(STOCK, op, tool, {}, { stepdown })))

/** No feed move meets more than the stepdown of uncut material (DF144). */
const deep = (tp: Toolpath, stepdown = 1) =>
  deepCuts(tp, tool, STOCK, { stepdown, finishRadial: 0 }, { cell: 0.2 })

describe('a through Line (DF147 SL3)', () => {
  it('a cut-off across the bar: entered from outside at every pass, alternating, slot to the depth', () => {
    const tp = generate(through([line([0, 22], [100, 22])]))
    // 10.4 / 1 → 11 passes, each plunged outside the stock (x < −R − clearance or x > 100 + …)
    const p = plunges(tp)
    expect(p).toHaveLength(11)
    const out = R + THROUGH_LEAD_CLEARANCE
    for (const m of p) expect(m.to[0] <= -out + 1e-9 || m.to[0] >= 100 + out - 1e-9).toBe(true)
    // alternating sides
    expect(p.map((m) => m.to[0] < 50)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ])
    expect(Math.min(...feeds(tp).map((m) => m.to[2]))).toBeCloseTo(-10.4, 9)
    expect(deep(tp)).toEqual([])
    // heightmap: the slot is cut to the depth, nothing beside it
    const hm = new Heightmap(100, 100, 0.2)
    hm.sweep(tool, tp, 0.2)
    let gouge = 0
    let leftover = 0
    for (let j = 0; j < hm.ny; j++)
      for (let i = 0; i < hm.nx; i++) {
        const [, y] = hm.center(i, j)
        const z = hm.z[j * hm.nx + i]!
        if (Math.abs(y - 22) > R + 0.05 && z < -1e-9) gouge++
        if (Math.abs(y - 22) < R - 0.15 && z > -10.4 + 1e-6) leftover++
      }
    expect(gouge).toBe(0)
    expect(leftover).toBe(0)
  })

  it('one end inside the face: entered at the open end, ramp-back at the inner one', () => {
    // drawn from the inner end: still entered from outside (reversed)
    const tp = generate(through([line([60, 22], [0, 22])]))
    const first = plunges(tp)[0]!
    expect(first.to[0]).toBeLessThan(-R)
    // passes starting at the inner end ramp (no plunge there)
    for (const m of plunges(tp)) expect(m.to[0]).toBeLessThan(0)
    expect(Math.max(...feeds(tp).map((m) => m.to[0]))).toBeLessThanOrEqual(60 + 1e-9)
    expect(deep(tp)).toEqual([])
  })

  it('both ends inside: no lead, ramp-back as a groove', () => {
    const tp = generate(through([line([20, 50], [80, 50])], 5))
    expect(plunges(tp)).toEqual([])
    expect(Math.min(...feeds(tp).map((m) => m.to[0]))).toBeGreaterThanOrEqual(20 - 1e-9)
    expect(deep(tp)).toEqual([])
  })

  it('an arc from the left edge to the right edge: leads clear of the stock, no deep cut', () => {
    // centre (50, −20), radius √(50² + 50²): from (0, 30) through (50, 50.7…) to (100, 30)
    const r = Math.hypot(50, 50)
    const tp = generate(through([arc([0, 30], [100, 30], [50, -20], false)]))
    expect(r).toBeGreaterThan(0)
    for (const m of plunges(tp)) {
      const dx = Math.max(-m.to[0], 0, m.to[0] - 100)
      const dy = Math.max(-m.to[1], 0, m.to[1] - 100)
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(R + THROUGH_LEAD_CLEARANCE - 1e-6)
    }
    expect(deep(tp)).toEqual([])
  })

  it('openLead: none for an end inside the face, longer for a slanted exit', () => {
    expect(openLead([50, 50], [-1, 0], R, STOCK)).toBeUndefined()
    const straight = openLead([0, 22], [-1, 0], R, STOCK)!
    expect(straight).toBeCloseTo(R + THROUGH_LEAD_CLEARANCE, 9)
    const slanted = openLead([0, 22], [-Math.SQRT1_2, -Math.SQRT1_2], R, STOCK)!
    expect(slanted).toBeGreaterThan(straight)
  })
})
