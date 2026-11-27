// The Run scene's workholding, pure (hardening DF133 RW1): the trust states of
// run-workholding.md § Trust, the items as Plan draws them (outlined, hidden, solid) and the tool
// the scene assumes in the spindle (Q189) with its holder ghost at the tool marker.
// Doc: docs/modes/run-workholding.md#implementation-rw1
import { describe, expect, it } from 'vitest'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { loadPlanDTO } from '../../../../core/plan/plan'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { setupWorkholding } from '../../../../core/plan/workholding/setup'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { shiftOverlay, workholdingOverlay } from '../plan/workholding-scene'
import {
  guardTool,
  runHolderGhost,
  runWorkholdingOverlay,
  workholdingTrust,
} from './run-workholding'

const open = (patch: Partial<RunStatus>): RunStatus => ({
  ...closedStatus(),
  connection: { state: 'open', target: 'virtual', timeScale: 1 },
  state: 'Idle',
  ...patch,
})

describe('workholdingTrust (run-workholding.md § Trust, Q184)', () => {
  it('solid only when homed with G54 set and items; each other state named', () => {
    expect(workholdingTrust(open({ homed: true, workZero: [-1, -2, -3] }), false)).toBe('noItems')
    expect(workholdingTrust(closedStatus(), true)).toBe('disconnected')
    expect(workholdingTrust(open({ state: 'Alarm', homed: false }), true)).toBe('notHomed')
    // homed, G54 never set (0 0 0, the DRO's hint)
    expect(workholdingTrust(open({ homed: true }), true)).toBe('zeroUnset')
    expect(workholdingTrust(open({ homed: true, workZero: [-200, 0, 0] }), true)).toBe('trusted')
    // RW6: a setup change began at this G54: outlined until it changes; a lesser state wins
    expect(workholdingTrust(open({ homed: true, workZero: [-200, 0, 0] }), true, true)).toBe(
      'zeroStale',
    )
    expect(workholdingTrust(open({ homed: false, workZero: [-200, 0, 0] }), true, true)).toBe(
      'notHomed',
    )
  })
})

async function plan(opts: { holder?: object } = {}) {
  const s = await planSetup()
  const { kind: _, ...m } = machineValues()
  const machineId =
    opts.holder === undefined
      ? s.machineId
      : (
          (await s.run('library.machine.add', {
            values: { ...libraryInput({ ...m, name: 'ER11 router' }), holder: opts.holder },
          })) as { id: string }
        ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setupId = s.plan(planId).setups[0]!.id
  await s.run('plan.workholding.set', {
    planId,
    setupId,
    items: [{ kind: 'toeClamp', edge: 'vMin', top: '20' }],
  })
  await s.run('plan.setup.update', { planId, setupId, zero: { at: ['20', '10'] } })
  const dto = s.plan(planId)
  const loaded = loadPlanDTO(dto, 'mm', 'test').unwrap()
  const setup = loaded.setups[0]!
  return { s, loaded, setup, holding: setupWorkholding(setup, loaded.stock) }
}

describe('runWorkholdingOverlay', () => {
  it("the Plan viewport's items at the moved zero; outlined unless trusted, hidden while G54 is unset", async () => {
    const { holding, setup } = await plan()
    const zero = [20, 10] as const
    const planned = shiftOverlay(workholdingOverlay(holding, setup.id, undefined, []), zero)!
    const solid = runWorkholdingOverlay(holding, setup.id, zero, 'trusted')!
    expect(solid.solids).toEqual(planned.solids)
    expect(solid.outlined).toBeUndefined()
    // read-only: no clamps to drag, no halo, no selection, no hits
    expect(solid.clamps).toBeUndefined()
    expect(solid.halo).toBeUndefined()
    expect(solid.selected).toBeUndefined()
    expect(solid.hits).toEqual([])
    // in the WCS: the setup frame less the work zero
    const frame = workholdingOverlay(holding, setup.id, undefined, [])!
    expect(solid.solids[0]!.outline[0]).toEqual([
      frame.solids[0]!.outline[0]![0] - 20,
      frame.solids[0]!.outline[0]![1] - 10,
    ])
    for (const trust of ['disconnected', 'notHomed', 'zeroStale'] as const) {
      const o = runWorkholdingOverlay(holding, setup.id, zero, trust)!
      expect(o.outlined).toBe(true)
      expect(o.solids).toEqual(planned.solids)
    }
    expect(runWorkholdingOverlay(holding, setup.id, zero, 'zeroUnset')).toBeUndefined()
    expect(runWorkholdingOverlay(holding, setup.id, zero, 'noItems')).toBeUndefined()
  })
})

describe('guardTool and the holder ghost (Q189)', () => {
  it('tool n of the setup by first use, its planned stickout and holder; the first by default', async () => {
    const { loaded, setup } = await plan({ holder: { preset: 'er11' } })
    const tools = [...new Set(setup.operations.flatMap((o) => (o.tool ? [o.tool] : [])))]
    expect(tools.length).toBeGreaterThan(1)
    const first = guardTool(loaded, setup, undefined)!
    expect(first.n).toBe(1)
    expect(first.tool).toBe(loaded.tools.get(tools[0]!))
    expect(first.holder).toMatchObject({ nutDiameter: 19, nutLength: 12, name: 'ER11' })
    expect(first.stickout).toBeGreaterThan(0)
    const second = guardTool(loaded, setup, 2)!
    expect(second.n).toBe(2)
    expect(second.tool).toBe(loaded.tools.get(tools[1]!))
    // a number the setup does not have: its first tool
    expect(guardTool(loaded, setup, 99)!.n).toBe(1)

    const ghost = runHolderGhost(first, [10, 20, 5], (g) => `T${g.n}`)!
    expect(ghost.tip).toEqual([10, 20, 5])
    expect(ghost.colliding).toBe(false)
    expect(ghost.label).toBe('T1')
    const r = Math.max(first.tool.diameter.canonical, 0) / 2
    expect(ghost.parts.map((p) => [p.part, p.zFrom])).toEqual([
      ['tool', 0],
      ['nut', first.stickout],
      ['body', first.stickout + 12],
    ])
    expect(ghost.parts[0]!.radius).toBeGreaterThanOrEqual(r)
    expect(ghost.parts[1]!.radius).toBe(9.5)
    // the body broken off as in Plan (0.3 × 52, at least 10)
    expect(ghost.parts[2]!.zTo - ghost.parts[2]!.zFrom).toBeCloseTo(15.6, 6)
    // no position (not homed): none
    expect(runHolderGhost(first, null, () => '')).toBeUndefined()
  })

  it('no holder on the machine: no ghost (the tool marker alone)', async () => {
    const { loaded, setup } = await plan()
    const g = guardTool(loaded, setup, undefined)!
    expect(g.holder).toBeUndefined()
    expect(runHolderGhost(g, [0, 0, 0], () => '')).toBeUndefined()
  })
})
