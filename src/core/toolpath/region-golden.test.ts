// Golden files of the region generators (v0.3 T3, docs/modes/plan-v0.3.md#tests): pockets of S4's
// corpus (two islands, a neck that splits, the 30° triangle, the 8 × 60 slot with its ramp entry)
// and profiles (the spike's bracket outside with free tabs, inside, `on` closed and open). Each
// case also passes the generic rules. Update with `npx vitest run src/core/toolpath/region-golden -u`
// after an intended generator change and review the diff (docs/conventions/testing.md).
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../geometry/model'
import type { Loop, Region } from '../geometry/2d/model'
import { dumbbell } from '../geometry/2d/testing/fixtures'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { PocketStrategy, Toolpath } from './model'
import { generateRegionPocket, type RegionPocketInput } from './region-pocket'
import {
  generateRegionProfile,
  type RegionProfileInput,
  type RegionProfileOperation,
} from './region-profile'
import { cutting, endMill, HEIGHTS, RATES } from './testing/fixtures'
import { render } from './testing/oracles'
import { placeLoops, pocketDeepCuts, pocketRapids } from './testing/region-coverage'
import { bracket, hook, slot, svgBracket, triangle, twoIslands } from './testing/region-fixtures'
import { violations } from './testing/rules'

const port = nodeRegion2d()
const D6 = endMill(6)

const pocketStrategy = (over: Partial<PocketStrategy> = {}): PocketStrategy => ({
  entry: 'helix',
  helixDiameter: 0.8 * 6,
  rampAngle: 3,
  finishAllowance: 0.2,
  finishStepdown: 4,
  direction: 'climb',
  ...over,
})

function pocketInput(loops: Loop[], depth: number): RegionPocketInput {
  const region = port.normalise(placeLoops(loops).loops).unwrap()
  return {
    planOperationId: 'op-pocket',
    tool: D6,
    cutting: cutting(D6, { stepdown: 2 }),
    heights: HEIGHTS,
    stock: { length: 300, width: 300, thickness: 20 },
    operation: { region, onZ: 0, depth },
    strategy: pocketStrategy({ finishStepdown: depth }),
    maxFeedRate: RATES,
  }
}

function profileInput(
  chain: Loop,
  op: Partial<Omit<RegionProfileOperation, 'chain'>>,
): RegionProfileInput {
  return {
    planOperationId: 'op-profile',
    tool: D6,
    cutting: cutting(D6, { stepdown: 2 }),
    heights: HEIGHTS,
    stock: { length: 300, width: 300, thickness: 6 },
    operation: {
      chain: placeLoops([chain], 15).loops[0]!,
      closed: true,
      side: 'outside',
      slotWidth: 6,
      onZ: 0,
      depth: 6,
      through: true,
      tabs: { positions: [], width: 6, thickness: 2 },
      ...op,
    },
    strategy: {
      entry: 'ramp',
      rampAngle: 3,
      breakthrough: 0.5,
      finishAllowance: 0.2,
      direction: 'climb',
      leadRadius: 3,
    },
    maxFeedRate: RATES,
  }
}

/** The common rules: feeds, plunge rate, ramp angle, retract and clearance planes, target depth. */
function rules(
  tp: Toolpath,
  i: {
    cutting: { feedRate: number; plungeRate: number }
    heights: { clearanceHeight: number; retractHeight: number }
  },
  onZ: number,
  floor: number,
  rampAngle: number,
  contains: (p: Vec3) => boolean,
  lowRapids = false,
): string[] {
  return violations(tp, {
    feedRate: i.cutting.feedRate,
    plungeRate: i.cutting.plungeRate,
    rampAngle,
    retractZ: onZ + i.heights.retractHeight,
    lowRapids,
    clearanceZ: i.heights.clearanceHeight,
    targetZ: floor,
    contains,
  })
}

const inRegion = (region: Region, onZ: number, floor: number) => (p: Vec3) =>
  p[2] > onZ + 1e-9 || (p[2] >= floor - 1e-9 && port.contains(region, [p[0], p[1]]))

describe('golden files: region pockets', () => {
  const cases: [string, Loop[], number][] = [
    ['region-pocket-two-islands', twoIslands(), 4],
    ['region-pocket-neck-splits', [dumbbell(5)], 3],
    ['region-pocket-triangle-30', [triangle(30, 40)], 2],
    ['region-pocket-slot-ramp', slot(), 3],
  ]
  for (const [name, loops, depth] of cases)
    it(name, async () => {
      const inp = pocketInput(loops, depth)
      const tp = generateRegionPocket(inp, port).unwrap()
      const wall = port.offset(inp.operation.region, 3 - 1e-4).unwrap()
      expect(rules(tp, inp, 0, -depth, 3, inRegion(wall, 0, -depth), true)).toEqual([])
      expect(pocketRapids(tp, inp)).toEqual([])
      // DF144: no feed move meets more than the stepdown of uncut material
      expect(pocketDeepCuts(tp, inp, { cell: 0.2 })).toEqual([])
      await expect(render(tp)).toMatchFileSnapshot(`__golden__/${name}.txt`)
    })

  it('the slot enters by ramp along its ring, the pocket with islands by helix', () => {
    /** Arc moves that change Z (helix turns) in the rough passes. */
    const helixArcs = (tp: Toolpath) =>
      tp.passes
        .filter((p) => p.kind === 'rough')
        .flatMap((p) =>
          p.moves.filter((m, k) => {
            const prev = p.moves[k - 1]
            return (
              m.kind === 'arc' &&
              prev !== undefined &&
              prev.kind !== 'drill' &&
              prev.to[2] !== m.to[2]
            )
          }),
        )
    expect(helixArcs(generateRegionPocket(pocketInput(slot(), 3), port).unwrap())).toEqual([])
    expect(
      helixArcs(generateRegionPocket(pocketInput(twoIslands(), 4), port).unwrap()).length,
    ).toBeGreaterThan(0)
  })
})

describe('golden files: region profiles', () => {
  const cases: [string, Loop, Partial<Omit<RegionProfileOperation, 'chain'>>][] = [
    [
      'region-profile-bracket-outside-tabs',
      svgBracket(),
      { side: 'outside', tabs: { positions: [25, 90, 160], width: 6, thickness: 2 } },
    ],
    ['region-profile-bracket-inside', svgBracket(), { side: 'inside' }],
    ['region-profile-on-closed', bracket(), { side: 'on', slotWidth: 8 }],
    [
      'region-profile-on-open-blind',
      hook(),
      { side: 'on', closed: false, slotWidth: 6, depth: 3, through: false },
    ],
  ]
  for (const [name, chain, op] of cases)
    it(name, async () => {
      const inp = profileInput(chain, op)
      const tp = generateRegionProfile(inp, port).unwrap()
      const { onZ, depth, through } = inp.operation
      const floor = onZ - depth - (through ? inp.strategy.breakthrough : 0)
      const zs = tp.passes.flatMap((p) =>
        p.moves.flatMap((m) => (m.kind === 'drill' ? [] : [m.to[2]])),
      )
      expect(Math.min(...zs)).toBeCloseTo(floor, 9)
      expect(rules(tp, inp, onZ, floor, inp.strategy.rampAngle, () => true)).toEqual([])
      await expect(render(tp)).toMatchFileSnapshot(`__golden__/${name}.txt`)
    })
})
