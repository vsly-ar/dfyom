// The stepped collision envelope and the holder in the collision check (hardening DF132 H2).
// Spec: docs/modes/tool-holder.md (§ Collision envelope, § Checks, § Testing)
import { describe, expect, it } from 'vitest'
import type { Move } from '../../toolpath/model'
import { checkWorkholding, type CheckTool } from './check'
import { toolEnvelope, type HolderSizes } from './envelope'
import type { Prism } from './obstacles'

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

const check = (moves: Move[], tool: CheckTool) =>
  checkWorkholding({
    operations: [{ planOperationId: 'op1', tool, moves }],
    prisms: [CLAMP],
    margin: 2,
    clearanceZ: 40,
  })

const er11 = (stickout: number): CheckTool => ({ diameter: 6, stickout, holder: ER11 })

describe('toolEnvelope', () => {
  it('no holder (or no stickout): the WH-F cylinder from the tip to infinity', () => {
    expect(toolEnvelope({ diameter: 6, shankDiameter: 8 }, 20, undefined)).toEqual([
      { part: 'tool', radius: 4, zFrom: 0, zTo: Infinity },
    ])
    expect(toolEnvelope({ diameter: 6 }, undefined, ER11)).toHaveLength(1)
  })

  it('tool to the stickout, the nut over its length, the body to infinity', () => {
    expect(toolEnvelope({ diameter: 6 }, 20, ER11)).toEqual([
      { part: 'tool', radius: 3, zFrom: 0, zTo: 20 },
      { part: 'nut', radius: 9.5, zFrom: 20, zTo: 32 },
      { part: 'body', radius: 26, zFrom: 32, zTo: Infinity },
    ])
  })

  it('contains the WH-F cylinder: every part above the tip at least as wide as the tool', () => {
    for (const [d, s] of [
      [6, 6],
      [3, 6.35],
      [12, 7],
    ] as const) {
      const [tool, ...holder] = toolEnvelope({ diameter: d, shankDiameter: s }, 25, ER11)
      for (const e of holder) expect(e.radius).toBeGreaterThanOrEqual(tool!.radius)
    }
  })
})

describe('checkWorkholding with a holder', () => {
  it('without a holder a cut 10 mm beside a 25 mm clamp is clear (today)', () => {
    const r = check(cutAt(20, -1), { diameter: 6 })
    expect(r.collisions).toEqual([])
    // with a holder but the WH-F tool only, the same
    expect(check(cutAt(20, -1), { diameter: 6, holder: ER11 }).collisions).toEqual([])
  })

  it('the nut beside the clamp (gap under the margin) is a holder collision with the stickout it needs', () => {
    const r = check(cutAt(20, -1), er11(20))
    expect(r.collisions).toEqual([
      {
        kind: 'holder',
        planOperationId: 'op1',
        itemId: 'wh1',
        moveIndex: 2,
        at: [20, 0, -1],
        lowestZ: -1,
        gap: 0.5,
        part: 'nut',
        partZ: 19,
        // clamp top 25 − tip −1 + 5 mm (STICKOUT_CLEARANCE)
        needed: 31,
      },
    ])
  })

  it('the nut over the clamp (inside its footprint grown by the nut radius) hits with gap 0', () => {
    const r = check(cutAt(15, -1), er11(20))
    expect(r.collisions).toEqual([
      expect.objectContaining({ kind: 'holder', part: 'nut', gap: 0, needed: 31 }),
    ])
  })

  it('beside the clamp beyond the margin: no finding', () => {
    // 12 mm from the clamp: nut gap 2.5 ≥ 2
    expect(check(cutAt(22, -1), er11(20)).collisions).toEqual([])
  })

  it('margins: an error only inside the 2 mm margin above the clamp; between 2 and 5 mm no error', () => {
    // nut bottom at Z26.5: under 25 + 2
    expect(check(cutAt(20, -1), er11(27.5)).collisions).toHaveLength(1)
    // nut bottom at Z28: above the margin, under the 5 mm read-out (H3's shortStickout warns)
    expect(check(cutAt(20, -1), er11(29)).collisions).toEqual([])
    // the stickout the finding names clears it
    expect(check(cutAt(20, -1), er11(31)).collisions).toEqual([])
  })

  it('the body where the nut clears: part body, the stickout lifts the body', () => {
    // 25 mm from the clamp at tip Z−6: nut gap 15.5, body bottom Z26 under 27, body gap 0
    const r = check(cutAt(35, -6), er11(20))
    expect(r.collisions).toEqual([
      expect.objectContaining({ kind: 'holder', part: 'body', partZ: 26, gap: 0, needed: 24 }),
    ])
  })

  it('a tool hit stays the tool kind; the needed stickout is the worst of the operation', () => {
    expect(check(cutAt(12, -1), er11(20)).collisions).toEqual([
      expect.objectContaining({ kind: 'cut', gap: 0 }),
    ])
    const deeper = [...cutAt(20, -1), ...cutAt(20, -6)]
    expect(check(deeper, er11(20)).collisions).toEqual([
      expect.objectContaining({ kind: 'holder', moveIndex: 2, lowestZ: -1, needed: 36 }),
    ])
  })
})
