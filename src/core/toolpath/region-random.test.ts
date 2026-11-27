// 30 seeded random regions from S4's corpus (v0.3 T3, docs/modes/plan-v0.3.md#tests): each is
// pocketed by `generateRegionPocket` and checked with the heightmap oracle (S4's three-way
// classification): no gouge, nothing below the floor, no reachable cell left, and the uncut area
// equals region − opening(R) within 1 % (+ 1 mm² for the boundary cells). The corpus regions
// come up in turn, turned and scaled at random; stepover, depth, entry, allowance and direction
// vary with the seed.
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../geometry/model'
import { regionArea } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { generateRegionPocket, type RegionPocketInput } from './region-pocket'
import { cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'
import { placeLoops, pocketRapids, regionCoverage } from './testing/region-coverage'
import { random, randomRegion } from './testing/region-fixtures'
import { violations } from './testing/rules'

const port = nodeRegion2d()
const D6 = endMill(6)
const R = 3
const CELL = 0.25

describe('30 seeded random regions (heightmap oracle)', () => {
  it(
    'clear every reachable cell, never gouge, and leave exactly the rest material',
    { timeout: 120_000 }, // ≈ 10 s alone
    () => {
      for (let seed = 1; seed <= 30; seed++) {
        const r = randomRegion(seed)
        const what = `seed ${seed}: ${r.name} turned ${r.angle.toFixed(3)} rad, ×${r.scale.toFixed(3)}`
        const placed = placeLoops(r.loops)
        const region = port.normalise(placed.loops).unwrap()
        const rnd = random(seed)
        // a stepover between 0.3 D and the clamp (0.9 D is clamped to R)
        const stepover = 1.8 + rnd() * 3.6
        const depth = 1 + Math.round(rnd() * 2)
        const inp: RegionPocketInput = {
          planOperationId: 'op-random',
          tool: D6,
          cutting: cutting(D6, { stepover, stepdown: 2 }),
          heights: HEIGHTS,
          stock: { length: placed.size.length, width: placed.size.width, thickness: 10 },
          operation: { region, onZ: 0, depth },
          strategy: {
            entry: (['helix', 'ramp', 'plunge'] as const)[seed % 3]!,
            helixDiameter: 4.8,
            rampAngle: 3,
            finishAllowance: seed % 2 === 0 ? 0.2 : 0,
            finishStepdown: depth,
            direction: seed % 4 === 0 ? 'conventional' : 'climb',
          },
          maxFeedRate: RATES,
        }
        const tp = generateRegionPocket(inp, port)
        expect(tp.isOk(), what).toBe(true)
        const c0 = port.offset(region, R).unwrap()
        const wall = port.offset(region, R - 1e-4).unwrap()
        expect(
          violations(tp.unwrap(), {
            feedRate: inp.cutting.feedRate,
            plungeRate: inp.cutting.plungeRate,
            rampAngle: 3,
            retractZ: HEIGHTS.retractHeight,
            lowRapids: true,
            clearanceZ: HEIGHTS.clearanceHeight,
            targetZ: -depth,
            contains: (p: Vec3) =>
              p[2] > 1e-9 || (p[2] >= -depth - 1e-9 && port.contains(wall, [p[0], p[1]])),
          }),
          what,
        ).toEqual([])
        const cov = regionCoverage(region, c0, tp.unwrap(), D6, placed.size, -depth, CELL)
        const opening = port.offset(c0, -R).unwrap()
        const expectedRest = regionArea(port.difference(region, opening).unwrap())
        expect(cov.gouge, what).toBe(0)
        expect(pocketRapids(tp.unwrap(), inp, CELL), what).toEqual([])
        expect(cov.belowFloor, what).toBe(0)
        expect(cov.leftover, what).toBeLessThan(0.5)
        expect(Math.abs(cov.rest - expectedRest), what).toBeLessThan(
          0.01 * expectedRest + 1, // + 1 mm²: the boundary cells (0.25 mm) classify either way
        )
      }
    },
  )
})

describe('2D library edge cases met by random regions', () => {
  it('an invalid offset near collapse in the helix search does not fail the pocket', () => {
    // seed 7 (the gear, turned 4.883 rad, ×0.731) at the default stepover: offsetting a leaf by
    // ≈ 1.9723 mm returns "an offset hole lies in no outer loop" from the 2D library
    const r = randomRegion(7)
    const placed = placeLoops(r.loops)
    const region = port.normalise(placed.loops).unwrap()
    const tp = generateRegionPocket(
      {
        planOperationId: 'op-gear',
        tool: D6,
        cutting: cutting(D6, { stepdown: 2 }),
        heights: HEIGHTS,
        stock: { ...placed.size, thickness: 10 },
        operation: { region, onZ: 0, depth: 2 },
        strategy: {
          entry: 'helix',
          helixDiameter: 4.8,
          rampAngle: 3,
          finishAllowance: 0.2,
          finishStepdown: 2,
          direction: 'climb',
        },
        maxFeedRate: RATES,
      },
      port,
    )
    expect(tp.isOk()).toBe(true)
  })
})
