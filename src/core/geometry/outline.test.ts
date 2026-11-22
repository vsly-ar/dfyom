// The geometry input mapping of shape operations: outlines, pocket regions, profile chains, tabs.
// Doc: docs/architecture/shapes.md#implementation-k3
import { describe, expect, it } from 'vitest'
import { chainLength } from './2d/measure'
import { line, regionArea, type Loop } from './2d/model'
import type { OperationGeometry } from './model'
import { pocketRegion, profileChain, shapeOutline, tabCentres } from './outline'

const square: Loop = {
  elements: [
    line([-5, -5], [5, -5]),
    line([5, -5], [5, 5]),
    line([5, 5], [-5, 5]),
    line([-5, 5], [-5, -5]),
  ],
}

type Profile = Extract<OperationGeometry, { kind: 'profile' }>
const profile = (over: Partial<Profile> = {}): Profile => ({
  kind: 'profile',
  id: 'profile1',
  shape: {
    center: [20, 10],
    contour: { kind: 'region', region: { pieces: [{ outer: square, holes: [] }] } },
  },
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 2, thickness: 2 },
  ...over,
})

describe('shapeOutline', () => {
  it('places region contours by the shape centre', () => {
    const o = shapeOutline(profile().shape)
    expect(o.kind).toBe('region')
    if (o.kind !== 'region') return
    expect(o.region.pieces[0]!.outer.elements[0]).toEqual(line([15, 5], [25, 5]))
  })

  it('maps v0.1 contours to one loop from the front-left end of the front wall', () => {
    const o = shapeOutline({
      center: [50, 30],
      contour: { kind: 'rectangle', length: 40, width: 20, cornerRadius: 4 },
    })
    if (o.kind !== 'region') throw new Error('region expected')
    const outer = o.region.pieces[0]!.outer
    expect(outer.elements[0]).toEqual(line([34, 20], [66, 20]))
    expect(outer.elements).toHaveLength(8)
    expect(regionArea(o.region)).toBeCloseTo(800 - (4 - Math.PI) * 16, 6)
    // a sharp rectangle has no zero-size corner elements
    const sharp = shapeOutline({
      center: [0, 0],
      contour: { kind: 'rectangle', length: 4, width: 2, cornerRadius: 0 },
    })
    expect(sharp.kind === 'region' && sharp.region.pieces[0]!.outer.elements).toHaveLength(4)
    const circle = shapeOutline({ center: [0, 0], contour: { kind: 'circle', radius: 3 } })
    const a = circle.kind === 'region' ? circle.region.pieces[0]!.outer.elements[0]!.a : [9, 9]
    expect(a[0]).toBeCloseTo(0, 12)
    expect(a[1]).toBe(-3)
  })
})

describe('pocket and profile inputs', () => {
  it('pocketRegion is the face-frame region with onZ and depth', () => {
    const r = pocketRegion({
      kind: 'pocket',
      id: 'pocket1',
      onZ: -0.5,
      depth: 4,
      floorRadius: 0,
      shape: profile().shape,
    })
    expect(r.onZ).toBe(-0.5)
    expect(r.depth).toBe(4)
    expect(regionArea(r.region)).toBeCloseTo(100, 9)
  })

  it('profileChain is the outer loop, or the open path of an on cut', () => {
    expect(profileChain(profile()).closed).toBe(true)
    const open = profileChain(
      profile({
        side: 'on',
        shape: {
          center: [0, 0],
          contour: { kind: 'path', path: { elements: [line([0, 0], [8, 0])] } },
        },
      }),
    )
    expect(open.closed).toBe(false)
    expect(chainLength(open.chain)).toBe(8)
  })
})

describe('tabs', () => {
  it('spaces count tabs evenly, the first half a spacing after the start point', () => {
    expect(tabCentres(40, { count: 4 })).toEqual([5, 15, 25, 35])
    expect(tabCentres(40, { count: 0 })).toEqual([])
    expect(tabCentres(40, { count: 4, positions: [1, 2] })).toEqual([1, 2])
  })
})
