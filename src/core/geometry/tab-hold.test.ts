// Tabs that hold (v0.4 TB1): the hold test, counted tabs moved off free sides, entered positions
// kept, and the same centres for evaluation (tab stretches) and toolpaths (generator input).
// Doc: docs/modes/design-v0.4.md#tabs-relocate-off-free-sides-tb1
import { describe, expect, it } from 'vitest'
import { regionProfileOperation } from '../toolpath/inputs'
import { line, type Loop } from './2d/model'
import type { OperationGeometry } from './model'
import {
  analyticTabCentres,
  freeSides,
  holdTest,
  resolveProfileTabs,
  resolveTabs,
  tabStretches,
} from './tab-hold'

type Profile = Extract<OperationGeometry, { kind: 'profile' }>

/** A 40 × 20 sharp rectangle loop from its front-left corner, counter-clockwise. */
const square: Loop = {
  elements: [
    line([-20, -10], [20, -10]),
    line([20, -10], [20, 10]),
    line([20, 10], [-20, 10]),
    line([-20, 10], [-20, -10]),
  ],
}

const region = (over: Partial<Profile> = {}): Profile => ({
  kind: 'profile',
  id: 'profile1',
  shape: {
    center: [50, 30],
    contour: { kind: 'region', region: { pieces: [{ outer: square, holes: [] }] } },
  },
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 4, thickness: 2 },
  ...over,
})

/** The same rectangle as a v0.1 contour (the v0.1 builders' count rule). */
const rectangle = (center: [number, number]): Profile => ({
  ...region(),
  shape: { center, contour: { kind: 'rectangle', length: 40, width: 20, cornerRadius: 0 } },
})

const roomy = { length: 100, width: 60, thickness: 10 }
/** The rectangle 4 mm from the stock front (margin 4 < slot 6): the front side is free. */
const nearFront = { length: 100, width: 60, thickness: 10 }
const frontCentre: [number, number] = [50, 14]

describe('tab hold test', () => {
  it('holds where the slot leaves stock beyond the cut, on held sides only', () => {
    const chain: Loop = {
      elements: square.elements.map((e) =>
        e.kind === 'line' ? line([e.a[0] + 50, e.a[1] + 14], [e.b[0] + 50, e.b[1] + 14]) : e,
      ),
    }
    const input = { chain, side: 'outside' as const, slotWidth: 6, width: 4, stock: nearFront }
    expect(freeSides(input)).toEqual([true, false, false, false])
    const held = holdTest(input)
    expect(held(20)).toBe(false) // front middle: the slot runs off the stock
    expect(held(50)).toBe(true) // right side
    expect(held(80)).toBe(true) // back
    // the margin equal to the slot holds (as dfm.slotOpensStock)
    expect(holdTest({ ...input, stock: { length: 100, width: 60 }, slotWidth: 4 })(20)).toBe(true)
    // every side free: nothing holds (dfm.slotLeavesStock)
    expect(holdTest({ ...input, stock: { length: 44, width: 24 } })(50)).toBe(false)
  })
})

describe('resolveTabs', () => {
  it('keeps tabs that hold where the count rule puts them', () => {
    const r = resolveProfileTabs(region(), roomy)
    expect(r.centres).toEqual([15, 45, 75, 105])
    expect(r.moved).toEqual([])
    expect(r.unheld).toEqual([])
  })

  it('moves a counted tab off a free side to the nearest held position (general loop)', () => {
    const op = region({ shape: { ...region().shape, center: frontCentre } })
    const r = resolveProfileTabs(op, nearFront)
    // tab 0 at 15 lies on the free front side. Forward, the right side (from 40) has tab 1 at 45,
    // so the nearest free place is back round the front-left corner: the end of the left side
    // (120), the tab's span just clear of the corner
    expect(r.moved).toEqual([0])
    expect(r.unheld).toEqual([])
    expect(r.centres.slice(1)).toEqual([45, 75, 105])
    expect(r.centres[0]).toBeCloseTo(117.75, 9)
    const held = holdTest({
      chain: { elements: [] },
      side: 'outside',
      slotWidth: 6,
      width: 4,
      stock: nearFront,
    })
    expect(held(0)).toBe(false) // an empty loop holds nothing
    // deterministic
    expect(resolveProfileTabs(op, nearFront).centres).toEqual(r.centres)
  })

  it('moves a v0.1 rectangle tab off a free side (wall-middle count rule)', () => {
    // v0.1 rule: first tab at the middle of the front wall (20), then a quarter turn apart
    const fits = analyticTabCentres(rectangle([50, 30]), roomy, 4)
    expect(fits).toEqual({ centres: [20, 50, 80, 110], moved: false })
    const r = analyticTabCentres(rectangle(frontCentre), nearFront, 4)
    expect(r.moved).toBe(true)
    expect(r.centres.slice(1)).toEqual([50, 80, 110])
    // 22.25 from the wall middle either way: just past the front-right corner (ahead) wins
    expect(r.centres[0]).toBeCloseTo(42.25, 9)
    // the slot covers the opening: no tabs
    expect(analyticTabCentres(rectangle(frontCentre), nearFront, 0)).toEqual({
      centres: [],
      moved: false,
    })
  })

  it('places what fits and leaves the rest where they were, without overlapping', () => {
    const op = region({
      shape: { ...region().shape, center: frontCentre },
      tabs: { count: 12, width: 4, thickness: 2 },
    })
    const r = resolveProfileTabs(op, nearFront)
    const sorted = [...r.centres].sort((a, b) => a - b)
    for (let i = 0; i + 1 < sorted.length; i++)
      expect(sorted[i + 1]! - sorted[i]!).toBeGreaterThanOrEqual(4 - 1e-9)
    expect(r.moved.length).toBeGreaterThan(0)
    // no stock at all: nothing holds, nothing moves
    const crowded = resolveTabs(
      {
        chain: square,
        side: 'outside',
        slotWidth: 6,
        width: 18,
        stock: { length: 0, width: 0 },
      },
      [5, 25, 45],
      false,
    )
    expect(crowded.anyHeld).toBe(false)
    expect(crowded.centres).toEqual([5, 25, 45])
    expect(crowded.unheld).toEqual([0, 1, 2])
    // only the right side holds (front, back and left free): its 20 mm take one 9 mm tab only
    const right = resolveTabs(
      {
        chain: shift(square, 20, 13),
        side: 'outside',
        slotWidth: 6,
        width: 9,
        stock: { length: 70, width: 26 },
      },
      [20, 50, 80],
      false,
    )
    expect(right.anyHeld).toBe(true)
    expect(right.moved).toEqual([])
    expect(right.unheld).toEqual([0, 2])
    expect(right.centres).toEqual([20, 50, 80])
  })

  it('never moves entered positions; it reports those that hold nothing', () => {
    const op = region({
      shape: { ...region().shape, center: frontCentre },
      tabs: { count: 4, width: 4, thickness: 2, positions: [10, 50] },
    })
    const r = resolveProfileTabs(op, nearFront)
    expect(r.centres).toEqual([10, 50])
    expect(r.moved).toEqual([])
    expect(r.unheld).toEqual([0])
  })

  it('gives evaluation and toolpaths the same centres', () => {
    const op = region({ shape: { ...region().shape, center: frontCentre } })
    const r = resolveProfileTabs(op, nearFront)
    expect(tabStretches(op, nearFront)).toEqual(r.centres.map((c) => ({ from: c - 2, to: c + 2 })))
    expect(regionProfileOperation(op, nearFront).tabs.positions).toEqual(r.centres)
    // open paths and blind grooves build none
    expect(tabStretches(region({ side: 'on', depth: 2 }), roomy)).toEqual([])
  })
})

function shift(l: Loop, dx: number, dy: number): Loop {
  return {
    elements: l.elements.map((e) =>
      e.kind === 'line' ? line([e.a[0] + dx, e.a[1] + dy], [e.b[0] + dx, e.b[1] + dy]) : e,
    ),
  }
}
