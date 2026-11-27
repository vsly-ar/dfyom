// The plan scene's holder ghost (hardening DF132 H5): placed at the clamp-deciding move of the
// stickout reason, at the deepest point of the toolpath when the cut decides, at the first hit of
// a `holder` collision (marked colliding); tool, nut and body stacked from the tip by the
// operation's stickout, the body cut off; none without a holder, a tool or a stickout, while the
// clamps are pending, or (the cut deciding) without a current toolpath. A hovered tool-change row
// shows the operation that decides its run.
// Doc: docs/modes/tool-holder.md#implementation-h5
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { PlanOperationDTO, SetupDTO } from '../../../../core/plan/plan.dto'
import type { Toolpath } from '../../../../core/toolpath/model'
import { ghostRims } from '../../viewport/HolderGhost'
import { bodyShown, deepestPoint, holderGhost, type HolderGhostInput } from './holder-ghost'
import type { PlanOperationView, StickoutReasonView } from './model'
import { shownHolderOperation } from './usePlanScene'

const ER11 = { nutDiameter: 19, nutLength: 12, bodyDiameter: 52, name: 'ER11' }

const row = (
  id: string,
  stickout: number | null,
  needed: number | null,
  reason: Partial<StickoutReasonView> | null,
): PlanOperationView =>
  ({
    id,
    stickout,
    stickoutNeeded: needed,
    stickoutReason:
      reason === null ? null : { kind: 'cut', planOperationId: id, clamps: 'checked', ...reason },
  }) as unknown as PlanOperationView

const toolpath: Toolpath = {
  passes: [
    {
      kind: 'rough',
      moves: [
        { kind: 'rapid', to: [10, 10, 5] },
        { kind: 'rapid', to: [10, 10, -20] }, // never deepest: rapids do not cut
        { kind: 'line', to: [10, 10, -1], feed: 100 },
        { kind: 'line', to: [30, 10, -1], feed: 400 },
        { kind: 'line', to: [30, 10, -2], feed: 100 },
        { kind: 'line', to: [40, 12, -2], feed: 400 },
      ],
    },
  ],
} as unknown as Toolpath

const base = (over: Partial<HolderGhostInput> = {}): HolderGhostInput => ({
  op: row('op1', 20, 36, {
    kind: 'workholding',
    itemId: 'wh1',
    itemName: 'Toe clamp 1',
    part: 'nut',
    x: 12,
    y: 40,
    z: -6,
  }),
  holder: ER11,
  tool: { diameter: 6 },
  toolpath,
  warnings: [],
  label: (s, n) => `Stickout ${s} mm · needs ${n} mm`,
  ...over,
})

const holderHit = (planOperationId: string): PlanWarning => ({
  code: 'plan.workholding.collision',
  severity: 'error',
  message: '',
  planOperationId,
  rule: 'holder',
  params: { setupId: 's1', itemId: 'wh1', part: 'nut', x: 15, y: 38, lowestZ: -1.5 },
})

describe('holder ghost (DF132 H5)', () => {
  it('stands at the clamp-deciding move with tool, nut and body by the stickout', () => {
    const g = holderGhost(base())!
    expect(g.tip).toEqual([12, 40, -6])
    expect(g.colliding).toBe(false)
    expect(g.label).toBe('Stickout 20 mm · needs 36 mm')
    expect(g.parts).toEqual([
      { part: 'tool', radius: 3, zFrom: 0, zTo: 20 },
      { part: 'nut', radius: 9.5, zFrom: 20, zTo: 32 },
      { part: 'body', radius: 26, zFrom: 32, zTo: 32 + bodyShown(ER11) },
    ])
    // the shank is drawn when wider than the cut
    expect(holderGhost(base({ tool: { diameter: 3, shankDiameter: 6 } }))!.parts[0]!.radius).toBe(3)
  })

  it('stands at the deepest point of the toolpath when the cut decides', () => {
    expect(deepestPoint(toolpath)).toEqual([30, 10, -2])
    const g = holderGhost(base({ op: row('op1', 20, 7, { kind: 'cut', clamps: 'none' }) }))!
    expect(g.tip).toEqual([30, 10, -2])
    // without a current toolpath there is nowhere to stand
    expect(holderGhost(base({ op: row('op1', 20, 7, {}), toolpath: undefined }))).toBeUndefined()
  })

  it('a drill cycle’s bottom is its deepest point', () => {
    const drill = {
      passes: [
        {
          kind: 'drill',
          moves: [
            {
              kind: 'drill',
              at: [5, 6],
              top: 0,
              bottom: -8,
              cycle: 'simple',
              retract: 2,
              feed: 100,
            },
          ],
        },
      ],
    } as unknown as Toolpath
    expect(deepestPoint(drill)).toEqual([5, 6, -8])
  })

  it('stands at the first hit of a holder collision, colliding', () => {
    const g = holderGhost(
      base({
        warnings: [holderHit('other'), holderHit('op1'), { ...holderHit('op1'), rule: 'cut' }],
      }),
    )!
    expect(g.tip).toEqual([15, 38, -1.5])
    expect(g.colliding).toBe(true)
    // a tool collision (rule cut) is not the holder's
    expect(holderGhost(base({ warnings: [{ ...holderHit('op1'), rule: 'cut' }] }))!.colliding).toBe(
      false,
    )
  })

  it('is hidden without a holder, a tool, a stickout, or while the clamps are pending', () => {
    expect(holderGhost(base({ holder: undefined }))).toBeUndefined()
    expect(holderGhost(base({ tool: undefined }))).toBeUndefined()
    expect(holderGhost(base({ op: undefined }))).toBeUndefined()
    expect(holderGhost(base({ op: row('op1', null, 36, {}) }))).toBeUndefined()
    expect(holderGhost(base({ op: row('op1', 20, null, null) }))).toBeUndefined()
    expect(holderGhost(base({ op: row('op1', 20, 7, { clamps: 'pending' }) }))).toBeUndefined()
  })

  it('the rims close at each part’s bottom and top', () => {
    const [bottom, top] = ghostRims(9.5, 20, 32, 8)
    expect(bottom!.length).toBe(9)
    expect(bottom![0]).toEqual(bottom![8]!.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)))
    expect(bottom!.every((p) => p[2] === 20 && Math.abs(Math.hypot(p[0], p[1]) - 9.5) < 1e-9)).toBe(
      true,
    )
    expect(top!.every((p) => p[2] === 32)).toBe(true)
  })
})

describe('which operation the ghost shows (DF132 H5)', () => {
  const op = (id: string, tool: string) => ({ id, tool }) as unknown as PlanOperationDTO
  const setup = {
    id: 's1',
    operations: [op('a', 't1'), op('b', 't1'), op('c', 't2')],
  } as unknown as SetupDTO
  const data = {
    operations: [row('a', 20, 7, {}), row('b', 20, 36, {}), row('c', 20, 7, {})],
    warnings: [] as PlanWarning[],
  }
  it('the selected operation, only in the scene’s setup', () => {
    expect(shownHolderOperation(setup, 'c', undefined, data)?.id).toBe('c')
    expect(shownHolderOperation(setup, 's1', undefined, data)).toBeUndefined()
    expect(shownHolderOperation(setup, 'elsewhere', undefined, data)).toBeUndefined()
  })
  it('a hovered tool-change row: the operation deciding its run, a holder collision first', () => {
    expect(shownHolderOperation(setup, 'c', 'a', data)?.id).toBe('b')
    expect(
      shownHolderOperation(setup, null, 'a', { ...data, warnings: [holderHit('a')] })?.id,
    ).toBe('a')
    // a preview that starts no run of this setup: the selection
    expect(shownHolderOperation(setup, 'c', 'b', data)?.id).toBe('c')
  })
})
