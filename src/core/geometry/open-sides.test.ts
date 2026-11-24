// Open sides of a pocket (hardening DF61): walls on or beyond the stock edge do not bound the
// tool; the toolpath of the open region clears a margin strip narrower than the tool and the
// corners where real walls meet the stock edge, without touching the real walls.
// Spec: docs/modes/plan-v0.3.md#open-sides-df61
import { describe, expect, it } from 'vitest'
import { regionArea, type Region } from './2d/model'
import { hole, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import {
  openReach,
  openRegion,
  opensStock,
  rectangleWallCorner,
  uncoveredRegion,
} from './open-sides'
import { generateRegionPocket } from '../toolpath/region-pocket'
import { cutting, endMill, HEIGHTS, RATES } from '../toolpath/testing/fixtures'
import { regionCoverage } from '../toolpath/testing/region-coverage'

const port = nodeRegion2d()
const face = { length: 60, width: 40 }
const D6 = endMill(6)

const region = (outer: ReturnType<typeof rect>, holes: ReturnType<typeof rect>[] = []): Region => ({
  pieces: [{ outer, holes: holes.map(hole) }],
})

/** The open region cut as `generateRegionPocket` gets it from `toGeneratorInputs`. */
function cut(r: Region, allowance = 0) {
  const open = openRegion(port, r, face, openReach(3, allowance)).unwrap()
  const tp = generateRegionPocket(
    {
      planOperationId: 'op-open',
      tool: D6,
      cutting: cutting(D6, { stepdown: 2 }),
      heights: HEIGHTS,
      stock: { ...face, thickness: 10 },
      operation: { region: open, onZ: 0, depth: 2 },
      strategy: {
        entry: 'plunge',
        helixDiameter: 4,
        rampAngle: 3,
        finishAllowance: allowance,
        finishStepdown: 2,
        direction: 'climb',
      },
      maxFeedRate: RATES,
    },
    port,
  )
  return { open, tp }
}

describe('opensStock', () => {
  it('a pocket inside the stock is closed; on or beyond the edge it is open', () => {
    expect(opensStock(port, region(rect(10, 10, 20, 10)), face)).toBe(false)
    // 0.01 from the edge: a real (thin) wall
    expect(opensStock(port, region(rect(10, 0.01, 20, 10)), face)).toBe(false)
    expect(opensStock(port, region(rect(10, 0, 20, 10)), face)).toBe(true)
    expect(opensStock(port, region(rect(-4, 10, 20, 10)), face)).toBe(true)
  })
})

describe('openRegion', () => {
  it('keeps the pocket inside the stock and adds only air outside it', () => {
    const r = region(rect(10, 0, 20, 10))
    const open = openRegion(port, r, face, 5).unwrap()
    const inside = port.intersect(open, region(rect(0, 0, 60, 40))).unwrap()
    expect(regionArea(inside)).toBeCloseTo(200, 3)
    expect(regionArea(open)).toBeGreaterThan(200)
    // wholly outside: unchanged
    const out = region(rect(-30, 0, 10, 10))
    expect(openRegion(port, out, face, 5).unwrap()).toBe(out)
  })
})

describe('the toolpath of an open region', () => {
  it('clears a 2 mm margin strip round the part with a Ø6 tool, the part untouched', () => {
    // the stock less the part 56 × 36: a strip narrower than the tool on every side
    const ring = region(rect(0, 0, 60, 40), [rect(2, 2, 56, 36)])
    // closed, the tool does not fit the strip
    const closed = generateRegionPocket(
      { ...cutInput(ring), operation: { region: ring, onZ: 0, depth: 2 } },
      port,
    )
    expect(closed.isErr()).toBe(true)
    const { open, tp } = cut(ring)
    const c0 = port.offset(open, 3).unwrap()
    const cov = regionCoverage(ring, c0, tp.unwrap(), D6, face, -2)
    expect(cov.gouge).toBe(0)
    expect(cov.belowFloor).toBe(0)
    expect(cov.leftover + cov.rest).toBe(0)
  })

  it('a notch on the edge: its corners with the real walls are cleared, with finishing', () => {
    const notch = region(rect(20, 0, 10, 8))
    for (const allowance of [0, 0.3]) {
      const { open, tp } = cut(notch, allowance)
      const c0 = port.offset(open, 3).unwrap()
      const cov = regionCoverage(notch, c0, tp.unwrap(), D6, face, -2)
      expect(cov.gouge).toBe(0)
      expect(cov.leftover).toBe(0)
      // only the two inside corners at y = 8 keep the tool radius
      expect(cov.rest).toBeLessThan(2 * (9 - (Math.PI * 9) / 4) + 0.5)
    }
  })
})

function cutInput(r: Region) {
  return {
    planOperationId: 'op-closed',
    tool: D6,
    cutting: cutting(D6, { stepdown: 2 }),
    heights: HEIGHTS,
    stock: { ...face, thickness: 10 },
    operation: { region: r, onZ: 0, depth: 2 },
    strategy: {
      entry: 'plunge' as const,
      helixDiameter: 4,
      rampAngle: 3,
      finishAllowance: 0,
      finishStepdown: 2,
      direction: 'climb' as const,
    },
    maxFeedRate: RATES,
  }
}

// DF61 follow-ups: a partly cleared pocket's uncovered part, and the v0.1 rectangle's corners
describe('uncoveredRegion', () => {
  const base = region(rect(10, 10, 40, 20))
  const reach = openReach(3, 0)
  it('covered wholly: empty; partly: the rest grown into the covered part, within the pocket', () => {
    expect(uncoveredRegion(port, base, region(rect(5, 5, 50, 30)), reach, 3)).toEqual({
      pieces: [],
    })
    // the left 30 mm cleared: the 10 mm on the right, grown by the reach
    const rest = uncoveredRegion(port, base, region(rect(10, 10, 30, 20)), reach, 3)!
    expect(regionArea(rest)).toBeCloseTo((10 + reach) * 20, 3)
    expect(port.difference(rest, base).map(regionArea).unwrap()).toBeLessThan(1e-6)
  })

  it('no split when the grown part would leave material the whole pocket cuts', () => {
    // a 2 mm strip left, grown by only 0.5 mm: narrower than the tool
    const strip = region(rect(10, 10, 38, 20))
    expect(uncoveredRegion(port, base, strip, 0.5, 3)).toBeUndefined()
    expect(uncoveredRegion(port, base, strip, reach, 3)).toBeDefined()
  })
})

describe('rectangleWallCorner', () => {
  const r = { length: 20, width: 10, cornerRadius: 0 }
  it('a corner counts as a wall only inside the stock, off its edge', () => {
    expect(rectangleWallCorner([30, 20], r, face)).toBe(true)
    // across the whole length: every corner beyond the ends
    expect(rectangleWallCorner([30, 20], { ...r, length: 70 }, face)).toBe(false)
    // sharp ends exactly on the edges: open; rounded ones put the arc inside: walls
    expect(rectangleWallCorner([30, 20], { ...r, length: 60 }, face)).toBe(false)
    expect(rectangleWallCorner([30, 20], { ...r, length: 60, cornerRadius: 2 }, face)).toBe(true)
  })
})
