// Through depths after earlier setups (hardening DF50, drillings DF61): opposite facings and
// pockets that clear a through profile's whole slot or a through hole reduce the material it cuts;
// material bands (DF61): what earlier cuts left over a later cut's region.
// Spec: docs/modes/plan-v0.2.md#material-removed-by-earlier-setups,
// docs/modes/plan-v0.2.md#material-left-for-later-cuts-df61
import { describe, expect, it } from 'vitest'
import { hole, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { OperationGeometry, StockGeometry } from './model'
import { reachDepth } from './tool-fit'
import { materialBands, throughDepths, withThroughDepths } from './through-depth'

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

/** A top (+z) through drilling of Ø`d` at `[x, y]`. */
const throughHole = (
  id: string,
  x: number,
  y: number,
  d = 5,
): Extract<OperationGeometry, { kind: 'drilling' }> => ({
  kind: 'drilling',
  id,
  onZ: 0,
  center: [x, y],
  diameter: d,
  bottom: { kind: 'through' },
})

describe('throughDepths of through drillings (DF61)', () => {
  it('a hole over the bottom relief cuts the material left; partly covered: the full extent', () => {
    const relief = bottomPocket('pocket1', 158, 108)
    const inside = throughHole('drill1', 100, 50)
    // the relief spans X 46…204: a hole at X 45 overlaps its wall
    const edge = throughHole('drill2', 45, 50)
    expect(depths([relief, inside, edge])).toEqual(new Map([['drill1', 33]]))
    // blind holes are not through cuts
    const blind: OperationGeometry = { ...inside, bottom: { kind: 'flat', depth: 5 } }
    expect(depths([relief, blind])).toEqual(new Map())
  })

  it('tool reach and the geometry read it', () => {
    const ops = [bottomPocket('pocket1', 158, 108), throughHole('drill1', 100, 50)]
    const hole1 = withThroughDepths(ops, depths(ops))[1]!
    expect(hole1).toMatchObject({ throughDepth: 33 })
    expect(reachDepth(hole1 as Exclude<OperationGeometry, { kind: 'facing' }>, STOCK)).toEqual([
      33,
      'on',
    ])
  })
})

describe('throughDepths with blind profiles as removals (DF61)', () => {
  it('a bottom step whose slot covers the outline slot clears its depth', () => {
    // the step along the same loop, a wider slot: from the bottom face 9.5 deep
    const step: OperationGeometry = {
      ...outline,
      id: 'profile2',
      direction: '-z',
      slotWidth: 9,
      depth: 9.5,
    }
    expect(depths([step, outline]).get('profile1')).toBeCloseTo(30.5, 9)
    // a narrower step leaves part of the slot: nothing counts
    expect(depths([{ ...step, slotWidth: 5 }, outline])).toEqual(new Map())
  })
})

describe('materialBands (DF61)', () => {
  const inOrder = (a: OperationGeometry, b: OperationGeometry, ops: OperationGeometry[]) =>
    ops.indexOf(a) < ops.indexOf(b)
  const bands = (ops: OperationGeometry[], p: typeof port | undefined = port) =>
    materialBands(ops, STOCK, p, (a, b) => inOrder(a, b, ops))
  const facing = (depth: number, direction: '+z' | '-z' = '+z'): OperationGeometry => ({
    kind: 'facing',
    id: `facing${direction}`,
    direction,
    depth,
  })
  const topPocket = (
    onZ: number,
    depth: number,
  ): Extract<OperationGeometry, { kind: 'pocket' }> => ({
    kind: 'pocket',
    id: 'pocket9',
    onZ,
    shape: {
      center: [125, 50],
      contour: { kind: 'rectangle', length: 60, width: 40, cornerRadius: 0 },
    },
    depth,
    floorRadius: 0,
  })

  it('an earlier facing above a pocket starting on the stock face: top at its floor', () => {
    const ops = [facing(2), topPocket(0, 5)]
    expect(bands(ops)).toEqual(new Map([['pocket9', { top: -2 }]]))
    // also without the port (a facing covers the whole face)
    expect(bands(ops, undefined)).toEqual(new Map([['pocket9', { top: -2 }]]))
    // on the facing floor already: nothing to skip
    expect(bands([facing(2), topPocket(-2, 3)])).toEqual(new Map())
    // the facing runs later: nothing
    expect(bands([topPocket(0, 5), facing(2)])).toEqual(new Map())
  })

  it('a step below an earlier facing, and a second facing', () => {
    const step: OperationGeometry = { ...outline, id: 'profile2', depth: 6 }
    const f1 = facing(1.5)
    const f2: OperationGeometry = { ...facing(2), id: 'facing2' }
    expect(bands([f1, step, f2])).toEqual(
      new Map([
        ['profile2', { top: -1.5 }],
        ['facing2', { top: -1.5 }],
      ]),
    )
  })

  it('a through profile under a facing gets a top, never a bottom', () => {
    expect(bands([facing(1), facing(5, '-z'), outline])).toEqual(
      new Map([['profile1', { top: -1 }]]),
    )
  })

  it('an earlier pocket covers a later one only over its whole region', () => {
    const big: OperationGeometry = { ...topPocket(0, 4), id: 'pocket8' }
    const wide: OperationGeometry = {
      ...topPocket(0, 3),
      id: 'pocket8',
      shape: {
        center: [125, 50],
        contour: { kind: 'rectangle', length: 80, width: 50, cornerRadius: 0 },
      },
    }
    expect(bands([wide, topPocket(0, 6)])).toEqual(new Map([['pocket9', { top: -3 }]]))
    // the same size: covers (shared walls); a smaller one does not
    expect(bands([big, topPocket(0, 6)])).toEqual(new Map([['pocket9', { top: -4 }]]))
    const small: OperationGeometry = {
      ...wide,
      shape: {
        center: [125, 50],
        contour: { kind: 'rectangle', length: 50, width: 30, cornerRadius: 0 },
      },
    }
    expect(bands([small, topPocket(0, 6)])).toEqual(new Map())
  })

  it('opposite cuts below a blind pocket: bottom where the material ends', () => {
    // a 36 deep top pocket over the bottom relief (7 deep): material from 0 down to −33
    const relief = bottomPocket('pocket1', 158, 108)
    expect(bands([relief, topPocket(0, 36)])).toEqual(new Map([['pocket9', { bottom: -33 }]]))
    // a floor above the relief: nothing
    expect(bands([relief, topPocket(0, 30)])).toEqual(new Map())
  })
})
