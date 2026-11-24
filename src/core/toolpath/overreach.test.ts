// Tool reach past the stock (hardening DF59, interim).
// Spec: docs/modes/plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim
import { describe, expect, it } from 'vitest'
import { generateFacing } from './facing'
import type { Move, Toolpath } from './model'
import { maxOverreach, NO_OVERREACH, reachesPastStock, toolpathOverreach } from './overreach'
import { endMill, facingInput } from './testing/fixtures'

const path = (...moves: Move[]): Toolpath => ({
  planOperationId: 'op',
  tool: 't',
  spindleSpeed: 10000,
  passes: [{ kind: 'rough', moves }],
  stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
})
const rapid = (x: number, y: number, z: number): Move => ({ kind: 'rapid', to: [x, y, z] })
const line = (x: number, y: number, z: number): Move => ({ kind: 'line', to: [x, y, z], feed: 1 })

describe('toolpathOverreach', () => {
  const size = [100, 50] as const

  it('is 0 for moves inside the outline and ignores rapids and moves above the top', () => {
    const tp = path(
      rapid(-30, -30, 10),
      rapid(-30, 120, 2),
      rapid(20, 20, 2),
      line(20, 20, -1),
      line(80, 30, -1),
      line(80, 30, 2),
      // a feed move outside but above the top: air
      line(150, 30, 0.5),
    )
    expect(toolpathOverreach(tp, 6, size)).toEqual(NO_OVERREACH)
  })

  it('adds the tool radius to the centre beyond each side', () => {
    const tp = path(rapid(-2, 10, 2), line(-2, 10, -1), line(101, -1, -1), line(50, 52, -1))
    const o = toolpathOverreach(tp, 6, size)
    expect(o.xMin).toBeCloseTo(5, 12)
    expect(o.xMax).toBeCloseTo(4, 12)
    expect(o.yMin).toBeCloseTo(4, 12)
    expect(o.yMax).toBeCloseTo(5, 12)
    expect(reachesPastStock(o)).toBe(true)
  })

  it('counts a line crossing the top from the crossing point', () => {
    // a ramp from (−10, 25, 1) to (10, 25, −1) crosses Z 0 at x = 0: the tool edge at −3
    const tp = path(rapid(-10, 25, 1), line(10, 25, -1))
    expect(toolpathOverreach(tp, 6, size).xMin).toBeCloseTo(3, 12)
  })

  it('takes the extreme points an arc sweeps over', () => {
    // a half circle about (50, 3) of radius 5 from (55, 3) counter-clockwise through (50, 8)
    // to (45, 3) stays above Y 3; clockwise it passes (50, −2)
    const ccw = path(rapid(55, 3, 1), line(55, 3, -1), {
      kind: 'arc',
      to: [45, 3, -1],
      center: [50, 3],
      cw: false,
      feed: 1,
    })
    const cw = path(rapid(55, 3, 1), line(55, 3, -1), {
      kind: 'arc',
      to: [45, 3, -1],
      center: [50, 3],
      cw: true,
      feed: 1,
    })
    expect(toolpathOverreach(ccw, 2, size).yMin).toBe(0)
    expect(toolpathOverreach(cw, 2, size).yMin).toBeCloseTo(3, 12)
  })

  it('counts a drill cycle at its centre when it goes below the top', () => {
    const drill = (x: number, bottom: number): Move => ({
      kind: 'drill',
      at: [x, 25],
      top: 0,
      bottom,
      cycle: 'simple',
      retract: 2,
      feed: 1,
    })
    expect(toolpathOverreach(path(drill(1, -5)), 6, size).xMin).toBeCloseTo(2, 12)
    expect(toolpathOverreach(path(drill(1, 0.5)), 6, size)).toEqual(NO_OVERREACH)
  })

  it('a facing reaches past the stock by its overshoot (plus the tool along the rows)', () => {
    const stock = { length: 30, width: 20, thickness: 10 }
    const tool = endMill(10)
    for (const axis of ['x', 'y'] as const) {
      const input = facingInput(stock, tool, {
        strategy: { pattern: 'zigzag', axis, overshoot: 1, direction: 'climb' },
      })
      const o = toolpathOverreach(generateFacing(input).unwrap(), tool.diameter, [30, 20])
      // along the rows the tool starts and ends fully outside: overshoot + D
      const along = axis === 'x' ? [o.xMin, o.xMax] : [o.yMin, o.yMax]
      const across = axis === 'x' ? [o.yMin, o.yMax] : [o.xMin, o.xMax]
      for (const v of along) expect(v).toBeCloseTo(11, 9)
      // across them the outer rows put the flat edge `overshoot` past the stock
      for (const v of across) expect(v).toBeCloseTo(1, 9)
    }
  })
})

describe('maxOverreach', () => {
  it('takes the per-side maximum; none = 0', () => {
    expect(maxOverreach([])).toEqual(NO_OVERREACH)
    expect(
      maxOverreach([
        { xMin: 1, xMax: 0, yMin: 3, yMax: 0 },
        { xMin: 2, xMax: 0, yMin: 0, yMax: 0.5 },
      ]),
    ).toEqual({ xMin: 2, xMax: 0, yMin: 3, yMax: 0.5 })
    expect(reachesPastStock(NO_OVERREACH)).toBe(false)
  })
})
