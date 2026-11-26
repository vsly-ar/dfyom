// The plan scene's workholding overlay (workholding.md#ui-summary) and the toe clamp drag (X2-6,
// workholding.md#toe-clamp-drag-x2-6): an item a collision finding names is marked; a dragged
// clamp snaps to the corners and the midpoint, else to 1 mm, and stays on its edge; its solids
// (and its halo when open) move along its edge only.
// Doc: docs/modes/workholding.md#toe-clamp-drag-x2-6
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { ResolvedItem } from '../../../../core/plan/workholding/items'
import { obstacles } from '../../../../core/plan/workholding/obstacles'
import type { SetupWorkholding } from '../../../../core/plan/workholding/setup'
import {
  CLAMP_SNAP,
  clampAxis,
  moveClamp,
  snapClampAt,
  workholdingOverlay,
} from './workholding-scene'

const stock = { length: 250, width: 100, thickness: 40 }
const clamp = { kind: 'toeClamp', width: 30, grip: 10, reach: 50, top: 25 } as const
const items: ResolvedItem[] = [
  { ...clamp, id: 'wh1', name: 'Toe clamp 1', edge: 'vMin', at: 15 },
  { ...clamp, id: 'wh2', name: 'Toe clamp 2', edge: 'uMax', at: 50 },
]
const holding = {
  items,
  stock,
  prisms: obstacles(items, stock),
  margin: 2,
} as unknown as SetupWorkholding

const collision = (itemId: string, setupId = 'setup1'): PlanWarning =>
  ({
    code: 'plan.workholding.collision',
    severity: 'error',
    message: '',
    params: { setupId, itemId, x: 100, y: 5, lowestZ: -3 },
  }) as unknown as PlanWarning

describe('workholding overlay', () => {
  it('marks the solids of the item a collision of this setup names', () => {
    const o = workholdingOverlay(holding, 'setup1', undefined, [
      collision('wh1'),
      collision('wh2', 'setup2'),
    ])!
    expect(o.solids.filter((s) => s.colliding).map((s) => s.itemId)).toEqual(['wh1', 'wh1'])
    expect(o.hits).toEqual([[100, 5, -3]])
  })
})

describe('toe clamp drag', () => {
  it('moves along X on the front and back edges, along Y on the left and right', () => {
    expect([clampAxis('vMin'), clampAxis('vMax'), clampAxis('uMin'), clampAxis('uMax')]).toEqual([
      0, 0, 1, 1,
    ])
  })

  it('snaps flush with a corner or to the midpoint, else to 1 mm, within the edge', () => {
    // a 30 mm clamp on a 250 mm edge: flush at 15 and 235, the middle at 125
    expect(snapClampAt(17.4, 250, 30)).toBe(15)
    expect(snapClampAt(125 + CLAMP_SNAP, 250, 30)).toBe(125)
    expect(snapClampAt(233, 250, 30)).toBe(235)
    expect(snapClampAt(80.6, 250, 30)).toBe(81)
    expect(snapClampAt(-40, 250, 30)).toBe(0)
    expect(snapClampAt(400, 250, 30)).toBe(250)
    // a clamp wider than the edge: no corner target, kept on the edge
    expect(snapClampAt(-5, 20, 30)).toBe(0)
  })

  it("moves the clamp's solids and its open halo along its edge, nothing else", () => {
    const o = workholdingOverlay(holding, 'setup1', 'wh1', [])!
    const m = moveClamp(o, 'wh1', 0, 110)
    const xs = (id: string, oo = m) =>
      oo.solids.filter((s) => s.itemId === id).flatMap((s) => s.outline.map((p) => p[0]))
    expect(Math.min(...xs('wh1'))).toBeCloseTo(110)
    expect(Math.max(...xs('wh1'))).toBeCloseTo(140)
    expect(xs('wh2')).toEqual(xs('wh2', o))
    // y unchanged
    expect(m.solids[0]!.outline.map((p) => p[1])).toEqual(o.solids[0]!.outline.map((p) => p[1]))
    expect(Math.min(...m.halo!.outlines[0]!.map((p) => p[0]))).toBeCloseTo(108)
    expect(moveClamp(o, 'wh1', 0, 0)).toBe(o)
  })
})
