// Through depths after earlier setups (hardening DF50): opposite facings and pockets that clear
// a through profile's whole slot reduce the material it cuts.
// Spec: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups
import { describe, expect, it } from 'vitest'
import { hole, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { OperationGeometry, StockGeometry } from './model'
import { reachDepth } from './tool-fit'
import { throughDepths, withThroughDepths } from './through-depth'

const port = nodeRegion2d()
// the enclosure test's stock and outline, scaled to round numbers
const STOCK: StockGeometry = { length: 250, width: 100, thickness: 40 }

/** Outside profile 135 × 96 centred on the stock: slot X 50.5…199.5, Y −5…105 (0…100 in stock). */
const outline: OperationGeometry = {
  kind: 'profile',
  id: 'profile1',
  shape: {
    center: [125, 50],
    contour: { kind: 'rectangle', length: 135, width: 96, cornerRadius: 4 },
  },
  side: 'outside',
  slotWidth: 7,
  tabs: { count: 4, width: 8, thickness: 2 },
}

/** A bottom (−z) pocket of a rectangle; the −z face frame mirrors v (v = 100 − y). */
const bottomPocket = (
  id: string,
  length: number,
  width: number,
  extra: { onZ?: number; depth?: number; floorRadius?: number; center?: [number, number] } = {},
): OperationGeometry => ({
  kind: 'pocket',
  id,
  direction: '-z',
  onZ: extra.onZ ?? 0,
  shape: {
    center: extra.center ?? [125, 50],
    contour: { kind: 'rectangle', length, width, cornerRadius: 4 },
  },
  depth: extra.depth ?? 7,
  floorRadius: extra.floorRadius ?? 0,
})

/** A ring pocket on the relief's floor: 152 × 108 less a 120 × 80 island (the part's step). */
const stepPocket: OperationGeometry = {
  kind: 'pocket',
  id: 'pocket2',
  direction: '-z',
  onZ: -7,
  shape: {
    center: [125, 50],
    contour: {
      kind: 'region',
      region: {
        pieces: [{ outer: rect(-76, -54, 152, 108), holes: [hole(rect(-60, -40, 120, 80))] }],
      },
    },
  },
  depth: 2.5,
  floorRadius: 0,
}

const depths = (ops: OperationGeometry[]) => throughDepths(ops, STOCK, port)
const portless = (ops: OperationGeometry[]) => throughDepths(ops, STOCK, undefined)

describe('throughDepths', () => {
  it('no opposite cuts: the profile keeps the stock thickness', () => {
    expect(depths([outline])).toEqual(new Map())
  })

  it('an opposite facing clears the whole face (also without the 2D port)', () => {
    const facing: OperationGeometry = { kind: 'facing', id: 'facing1', direction: '-z', depth: 1 }
    expect(depths([facing, outline])).toEqual(new Map([['profile1', 39]]))
    expect(portless([facing, outline])).toEqual(new Map([['profile1', 39]]))
  })

  it('a bottom pocket covering the whole slot', () => {
    const ops = [bottomPocket('pocket1', 158, 108), outline]
    expect(depths(ops)).toEqual(new Map([['profile1', 33]]))
    // without the port pockets are not counted (the cut keeps the full thickness)
    expect(portless(ops)).toEqual(new Map())
  })

  it('stacked pockets add up: the step on the relief floor', () => {
    const ops = [bottomPocket('pocket1', 158, 108), stepPocket, outline]
    expect(depths(ops).get('profile1')).toBeCloseTo(30.5, 9)
  })

  it('a pocket on a level not yet cleared counts nothing', () => {
    // the step alone: its `on` level (7 mm up) is still material under the slot
    expect(depths([stepPocket, outline])).toEqual(new Map())
  })

  it('partial coverage counts nothing (the slot is cut through where material is left)', () => {
    expect(depths([bottomPocket('pocket1', 140, 108), outline])).toEqual(new Map())
    // v 0…60 of the bottom face frame is y 40…100: the front of the slot keeps its material
    const shifted = bottomPocket('pocket1', 158, 60, { center: [125, 30] })
    expect(depths([shifted, outline])).toEqual(new Map())
  })

  it('a floor fillet counts only the flat floor inside it', () => {
    // 152 long: the slot (X 50.5…199.5) is 1.5 inside the walls
    expect(depths([bottomPocket('pocket1', 152, 108, { floorRadius: 1 }), outline])).toEqual(
      new Map([['profile1', 33]]),
    )
    expect(depths([bottomPocket('pocket1', 152, 108, { floorRadius: 2 }), outline])).toEqual(
      new Map(),
    )
  })

  it('only cuts of an earlier setup: the default order runs the bottom first', () => {
    const top = { ...outline, direction: '-z' as const }
    const topPocket: OperationGeometry = { ...bottomPocket('pocket1', 158, 108), direction: '+z' }
    // a bottom profile with a top pocket: the top runs later, nothing is cleared yet
    expect(depths([topPocket, top])).toEqual(new Map())
    // a plan that runs the top first: the bottom pocket comes later
    const ops = [bottomPocket('pocket1', 158, 108), outline]
    expect(throughDepths(ops, STOCK, port, () => false)).toEqual(new Map())
  })

  it('opposite cuts through the whole stock leave the full extent', () => {
    expect(depths([bottomPocket('pocket1', 158, 108, { depth: 40 }), outline])).toEqual(new Map())
  })

  it('tool reach and the profile geometry read it', () => {
    const ops = withThroughDepths(
      [bottomPocket('pocket1', 158, 108), outline],
      depths([bottomPocket('pocket1', 158, 108), outline]),
    )
    const profile = ops[1]!
    expect(profile).toMatchObject({ throughDepth: 33 })
    expect(reachDepth(profile as Exclude<OperationGeometry, { kind: 'facing' }>, STOCK)).toEqual([
      33,
      'on',
    ])
    // cleared again when the depth no longer applies
    expect(withThroughDepths(ops, new Map())[1]).not.toHaveProperty('throughDepth')
  })
})
