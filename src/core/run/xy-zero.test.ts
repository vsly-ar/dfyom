// Set X/Y zero (v0.5 RV5): a stock offset by (3.2, −1.7) mm from where G54 says gives, after a
// corner probe on the virtual machine, a G54 that puts the plan's zero on the right stock point
// within 0.01 mm, for a zero on a corner and off the stock; a touch-off with a 0.1 mm feeler.
// Spec: docs/modes/run-probing.md#set-xy-zero-rv5, docs/plans/v0.5-run.md (RV5)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { emulator } from './grbl/emulator.fixture'
import { emuPort } from './probe-port.fixture'
import { runProbeRoutine } from './probe-routines'
import {
  g54For,
  planEdge,
  touchedEdge,
  VIRTUAL_MISPLACEMENT,
  virtualStockBox,
  zeroCorner,
  type PlanStock,
} from './xy-zero'

type Vec3 = [number, number, number]

const stock = (zero: [number, number]): PlanStock => ({
  length: 120,
  width: 80,
  thickness: 20,
  zero,
})

describe('planEdge, zeroCorner', () => {
  it('edges in the work coordinates for a zero on a corner, inside and off the stock', () => {
    expect(planEdge(stock([0, 0]), 'x', -1)).toBe(0)
    expect(planEdge(stock([0, 0]), 'x', 1)).toBe(120)
    expect(planEdge(stock([60, 40]), 'y', -1)).toBe(-40)
    expect(planEdge(stock([-15, 95]), 'y', 1)).toBe(-15)
    expect(zeroCorner(stock([0, 0]))).toEqual({ corner: [-1, -1], on: true })
    expect(zeroCorner(stock([120, 80]))).toEqual({ corner: [1, 1], on: true })
    expect(zeroCorner(stock([100, 10]))).toEqual({ corner: [1, -1], on: false })
  })

  it('a touch-off: the radius and the feeler on the far side of the tool', () => {
    expect(touchedEdge(-3.1, -1, 6, 0.1)).toBeCloseTo(0, 9)
    expect(touchedEdge(103.1, 1, 6, 0.1)).toBeCloseTo(100, 9)
  })
})

describe('the corner probe sets G54 so the plan zero lands on the stock', () => {
  it.each([
    ['on the X−/Y− corner', [0, 0], [-1, -1]],
    ['off the stock', [-15, 95], [-1, 1]],
    ['on the X+/Y+ corner', [120, 80], [1, 1]],
  ] as const)('zero %s', async (_name, zero, corner) => {
    const plan = stock([zero[0], zero[1]])
    const g54Before: Vec3 = [-400, -300, -60]
    const box = virtualStockBox(plan, { workZero: g54Before, mpos: [0, 0, 0] })
    // the truth: the stock's corner sits off where G54 said by the virtual misplacement
    expect(box.min[0]).toBeCloseTo(-400 - zero[0] + VIRTUAL_MISPLACEMENT[0], 9)
    expect(box.max[2]).toBe(-60)
    const cx = corner[0] < 0 ? box.min[0] : box.max[0]
    const cy = corner[1] < 0 ? box.min[1] : box.max[1]
    // the bit above the stock 6 mm in from the corner
    const at: Vec3 = [cx - corner[0] * 6, cy - corner[1] * 6, -50]
    const emu = emulator({
      probeScene: { targets: [{ kind: 'box', min: box.min, max: box.max }] },
      position: at,
      probeTip: { shape: 'cylinder', radius: 3.175 },
    })
    emu.readOutput()
    const r = expectOk(
      await runProbeRoutine(emuPort(emu).port, {
        routine: { cycle: 'corner', corner },
        probe: { kind: 'tool', tipDiameter: 6.35 },
        reach: 10,
        zDistance: 20,
        depth: 3,
        clearance: 2,
        fastFeed: 200,
        slowFeed: 25,
        moveFeed: 300,
      }),
    )
    const g54 = [
      g54For(r.x!.value, planEdge(plan, 'x', corner[0])),
      g54For(r.y!.value, planEdge(plan, 'y', corner[1])),
    ]
    // the plan's zero (WCS 0, 0) is the setup frame's `zero` from the stock's X−/Y− corner
    expect(Math.abs(g54[0]! - (box.min[0] + zero[0]))).toBeLessThanOrEqual(0.01)
    expect(Math.abs(g54[1]! - (box.min[1] + zero[1]))).toBeLessThanOrEqual(0.01)
    // G54 moved by the misplacement
    expect(g54[0]! - g54Before[0]).toBeCloseTo(VIRTUAL_MISPLACEMENT[0], 2)
    expect(g54[1]! - g54Before[1]).toBeCloseTo(VIRTUAL_MISPLACEMENT[1], 2)
  })

  it('a touch-off with a 0.1 mm feeler on the X+ edge, the probe input as the readout', () => {
    const plan = stock([0, 0])
    const box = virtualStockBox(plan, { workZero: [-400, -300, -60], mpos: [0, 0, 0] })
    const r = 3
    const emu = emulator({
      probeScene: { targets: [{ kind: 'box', min: box.min, max: box.max }] },
      position: [box.max[0] + r + 0.1, -260, -63],
      probeTip: { shape: 'cylinder', radius: r },
    })
    emu.readOutput()
    // the feeler between: not touching yet; the operator feels the drag and presses "Touching"
    expect(emu.probeTouching()).toBe(false)
    const edge = touchedEdge(emu.status().mpos[0], 1, 2 * r, 0.1)
    expect(Math.abs(g54For(edge, planEdge(plan, 'x', 1)) - box.min[0])).toBeLessThanOrEqual(0.01)
  })
})

describe('virtualStockBox', () => {
  it('under the tool when G54 was never set', () => {
    const b = virtualStockBox(stock([0, 0]), { workZero: [0, 0, 0], mpos: [-200, -150, -20] })
    expect(b).toEqual({ min: [-260, -190, -50], max: [-140, -110, -30] })
  })
})
