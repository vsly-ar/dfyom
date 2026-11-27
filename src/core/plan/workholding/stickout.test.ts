// The clamp term of the minimum stickout (hardening DF132 H3): analytic values against a 25 mm
// clamp, the reason, and DF130's value without a holder.
// Spec: docs/modes/tool-holder.md#minimum-stickout-gains-the-clamp-term
import { describe, expect, it } from 'vitest'
import type { Move } from '../../toolpath/model'
import { checkWorkholding, type CheckOperation, type CheckTool } from './check'
import type { HolderSizes } from './envelope'
import type { Prism } from './obstacles'
import type { PlanWarning } from '../checks'
import { dropShadowedShortStickout } from './findings'
import { clampTerms, stickoutNeed } from './stickout'

const ER11: HolderSizes = { nutDiameter: 19, nutLength: 12, bodyDiameter: 52, name: 'ER11' }

/** A 10 × 10 toe-clamp pad at the origin, 25 mm tall. */
const CLAMP: Prism = {
  itemId: 'wh1',
  footprint: {
    kind: 'polygon',
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  },
  zMin: 0,
  zMax: 25,
}

/** A feed along Y at `x` (distance x − 10 from the clamp) with the tip at `z`. */
const cutAt = (x: number, z: number): Move[] => [
  { kind: 'rapid', to: [x, -20, 40] },
  { kind: 'rapid', to: [x, -20, z] },
  { kind: 'line', to: [x, 30, z], feed: 500 },
  { kind: 'rapid', to: [x, 30, 40] },
]

const op = (moves: Move[], tool: CheckTool = { diameter: 6, holder: ER11 }): CheckOperation => ({
  planOperationId: 'op1',
  tool,
  moves,
})

const terms = (moves: Move[], margin = 2, tool?: CheckTool) =>
  clampTerms({ operations: [op(moves, tool)], prisms: [CLAMP], margin })

describe('clampTerms', () => {
  it('the nut disc (radius + margin) over the clamp: clamp top − tip Z at the deciding move', () => {
    // 9.5 + 2 = 11.5 reach: 10 mm from the clamp counts
    expect(terms(cutAt(20, -6)).get('op1')).toEqual({
      term: 31,
      itemId: 'wh1',
      part: 'nut',
      moveIndex: 2,
      at: [20, 0, -6],
    })
    // the deepest of several passes decides
    expect(terms([...cutAt(20, -1), ...cutAt(20, -6)]).get('op1')).toMatchObject({
      term: 31,
      moveIndex: 6,
    })
  })

  it('the body where the nut is out of reach: top − tip Z − nut length', () => {
    // 25 mm away: nut reach 11.5 misses, body reach 28 meets
    expect(terms(cutAt(35, -6)).get('op1')).toMatchObject({ term: 19, part: 'body' })
    // the nut wins where both meet
    expect(terms(cutAt(20, -6)).get('op1')).toMatchObject({ part: 'nut' })
  })

  it('out of reach of both, without a holder or without items: no term', () => {
    expect(terms(cutAt(39, -6)).has('op1')).toBe(false)
    expect(terms(cutAt(20, -6), 2, { diameter: 6 }).has('op1')).toBe(false)
    expect(clampTerms({ operations: [op(cutAt(20, -6))], prisms: [], margin: 2 }).has('op1')).toBe(
      false,
    )
  })

  it('a margin over 5 mm adds its excess, so the read-out stays outside the margin', () => {
    expect(terms(cutAt(20, -6), 7).get('op1')).toMatchObject({ term: 33 })
  })

  it('the stickout it gives clears the collision check, and the check flags 0.5 mm less', () => {
    for (const [x, z] of [
      [20, -6],
      [15, -1],
      [35, -6],
      [16, -3],
    ] as const) {
      const moves = cutAt(x, z)
      const t = terms(moves).get('op1')!
      const at = (stickout: number) =>
        checkWorkholding({
          operations: [op(moves, { diameter: 6, stickout, holder: ER11 })],
          prisms: [CLAMP],
          margin: 2,
          clearanceZ: 40,
        }).collisions.filter((c) => c.kind === 'holder')
      expect(at(t.term + 5)).toEqual([])
      // inside the 2 mm margin it is the error H2 reports
      expect(at(t.term + 1.5)).toHaveLength(1)
    }
  })
})

describe('stickoutNeed', () => {
  const clamp = terms(cutAt(20, -6)).get('op1')!

  it('without a clamp term (no holder, no items): DF130 exactly, the cut decides', () => {
    expect(stickoutNeed(11, undefined)).toEqual({ needed: 11, kind: 'cut' })
  })

  it('the larger decides; the cut on a tie', () => {
    expect(stickoutNeed(11, clamp)).toEqual({ needed: 36, kind: 'workholding', clamp })
    expect(stickoutNeed(40, clamp)).toEqual({ needed: 40, kind: 'cut' })
    expect(stickoutNeed(36, clamp)).toEqual({ needed: 36, kind: 'cut' })
  })
})

describe('dropShadowedShortStickout', () => {
  const short = (planOperationId: string, params: PlanWarning['params']): PlanWarning => ({
    code: 'plan.check',
    severity: 'warning',
    message: '',
    planOperationId,
    field: 'stickout',
    rule: 'shortStickout',
    params,
  })

  it('keeps one per operation: the clamp’s where it decides, DF130’s elsewhere', () => {
    const cut1 = short('op1', { stickout: 8, depth: 6, needed: 11 })
    const clamp1 = short('op1', { stickout: 8, needed: 36, itemId: 'wh1' })
    const cut2 = short('op2', { stickout: 8, depth: 6, needed: 11 })
    const list = [cut1, clamp1, cut2]
    dropShadowedShortStickout(list)
    expect(list).toEqual([clamp1, cut2])
  })
})
