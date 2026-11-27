// Go to coordinates, the move planning (DF128).
// Spec: docs/modes/run-goto.md#the-move-safe-order, #checks
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  goToLengths,
  goToMoves,
  goToSafeZ,
  goToSeconds,
  goToTarget,
  goToZeroTarget,
  machineTopZ,
  type GoToInput,
} from './goto'

// travel 800 × 600 × 100, pull-off 1: the machine top is Z −1
const envelope = { travel: [800, 600, 100] as const, pullOff: 1 }
// work zero at machine (−400, −300, −80): the stock top is Z −80, the safe height Z −75
const wco = [-400, -300, -80] as const
const base: GoToInput = {
  from: [-400, -300, -82], // 2 mm inside the stock, at the work zero XY
  wco,
  target: [0, 0, 0],
  frame: 'work',
  mode: 'absolute',
  safeZ: -75,
  liftToTop: false,
  envelope,
}
const plan = (over: Partial<GoToInput>) => expectOk(goToMoves({ ...base, ...over }))

describe('goToMoves: the safe order', () => {
  it('goes up first: Z alone to the target Z, then X/Y', () => {
    expect(plan({ from: [-450, -350, -70], target: [0, 0, 20] })).toEqual([
      { to: [-450, -350, -60], axis: 'z' },
      { to: [-400, -300, -60], axis: 'xy' },
    ])
  })

  it('goes down last: X/Y at the current Z (above the safe height), then Z', () => {
    expect(plan({ from: [-450, -350, -60], target: [0, 0, 1] })).toEqual([
      { to: [-400, -300, -60], axis: 'xy' },
      { to: [-400, -300, -79], axis: 'z' },
    ])
  })

  it('a move that only lowers Z is one step', () => {
    expect(plan({ from: [-400, -300, -60], target: [0, 0, 1] })).toEqual([
      { to: [-400, -300, -79], axis: 'z' },
    ])
  })

  it('from inside the stock: lifts to the safe height before X/Y, then down (three steps)', () => {
    const steps = plan({ from: [-450, -350, -85], target: [0, 0, -2] })
    expect(steps).toEqual([
      { to: [-450, -350, -75], axis: 'z' },
      { to: [-400, -300, -75], axis: 'xy' },
      { to: [-400, -300, -82], axis: 'z' },
    ])
    // X/Y never below max(current, target, safe height)
    expect(steps.find((s) => s.axis === 'xy')!.to[2]).toBe(-75)
  })

  it('a pure X/Y move above the safe height stays at its Z', () => {
    expect(plan({ from: [-450, -350, -50], target: [10, 0, 30] })).toEqual([
      { to: [-390, -300, -50], axis: 'xy' },
    ])
  })

  it('a pure Z move never lifts to the safe height', () => {
    expect(plan({ from: [-400, -300, -85], target: [0, 0, -3] })).toEqual([
      { to: [-400, -300, -83], axis: 'z' },
    ])
  })

  it('"Lift to the top first" raises Z to the machine top before X/Y, whatever the target', () => {
    expect(plan({ from: [-450, -350, -50], target: [0, 0, 1], liftToTop: true })).toEqual([
      { to: [-450, -350, -1], axis: 'z' },
      { to: [-400, -300, -1], axis: 'xy' },
      { to: [-400, -300, -79], axis: 'z' },
    ])
  })

  it('is empty when the target is the position (within 0.001 mm)', () => {
    expect(plan({ from: [-400, -300, -80], target: [0.0005, 0, -0.0009] })).toEqual([])
  })
})

describe('goToMoves: frames and modes', () => {
  it('work ↔ machine with a non-zero work offset name the same point', () => {
    const from = [-450, -350, -60] as const
    const work = plan({ from, frame: 'work', target: [12, 34, 5] })
    const machine = plan({ from, frame: 'machine', target: [-388, -266, -75] })
    expect(work).toEqual(machine)
    expect(goToTarget({ ...base, target: [12, 34, 5] })).toEqual([-388, -266, -75])
  })

  it('relative: the fields are the distance, the frame does not matter', () => {
    const from = [-450, -350, -60] as const
    const work = plan({ from, mode: 'relative', frame: 'work', target: [10, -5, 0] })
    const machine = plan({ from, mode: 'relative', frame: 'machine', target: [10, -5, 0] })
    expect(work).toEqual([{ to: [-440, -355, -60], axis: 'xy' }])
    expect(machine).toEqual(work)
  })

  it('relative 0 0 0 is already there', () => {
    expect(plan({ mode: 'relative', target: [0, 0, 0] })).toEqual([])
  })
})

describe('goToMoves: the travel', () => {
  it.each([
    ['X above 0', [401, 0, 70], 'x', 1, 0],
    ['X below −travel', [-401, 0, 70], 'x', -801, -800],
    ['Y above 0', [0, 301, 70], 'y', 1, 0],
    ['Y below −travel', [0, -301, 70], 'y', -601, -600],
    ['Z above 0', [0, 0, 80.5], 'z', 0.5, 0],
    ['Z below −travel', [0, 0, -20.5], 'z', -100.5, -100],
  ] as const)('%s: refused with the axis, the end and the travel', (_, target, axis, at, edge) => {
    const e = expectErrCode(
      goToMoves({ ...base, from: [-400, -300, -50], target: [...target] }),
      'run.travel',
    )
    const d = e.frames[0]?.data as { axis: string; target: number; min: number; max: number }
    expect(d.axis).toBe(axis)
    expect(d.target).toBeCloseTo(at, 6)
    expect(at > 0 ? d.max : d.min).toBe(edge)
  })

  it('checks every step: a lift above the travel is refused even when the target is inside', () => {
    expectErrCode(
      goToMoves({ ...base, from: [-450, -350, -85], safeZ: 2, target: [0, 0, -2] }),
      'run.travel',
    )
  })

  it('the edges themselves are inside', () => {
    expect(plan({ frame: 'machine', from: [-1, -1, -1], target: [0, -600, -100] })).toHaveLength(2)
    expect(plan({ frame: 'machine', from: [-1, -1, -1], target: [-800, 0, 0] })).toHaveLength(2)
  })

  it('without a known travel nothing is refused here (the host and GRBL still check)', () => {
    expect(
      goToMoves({ ...base, envelope: undefined, frame: 'machine', target: [5, 0, 0] }).isOk(),
    ).toBe(true)
  })
})

describe('safe height, top, lengths and time', () => {
  it('the safe height: stock top + clearance (5 mm default), capped at the machine top', () => {
    expect(goToSafeZ({ wcoZ: -80, envelope })).toBe(-75)
    expect(goToSafeZ({ wcoZ: -80, clearance: 15, envelope })).toBe(-65)
    // Z zeroed 3 mm below the stock top (DF69): still above the stock top
    expect(goToSafeZ({ wcoZ: -83, zeroLevel: -3, envelope })).toBe(-75)
    expect(goToSafeZ({ wcoZ: -3, envelope })).toBe(-1)
    expect(machineTopZ(envelope)).toBe(-1)
    expect(machineTopZ(undefined)).toBe(0)
  })

  it('lengths per step and the time at the jog feeds, rounded up', () => {
    const from = [-450, -350, -85] as const
    const steps = plan({ from, target: [0, 0, -2] })
    const lengths = goToLengths(from, steps)
    expect(lengths[0]).toBeCloseTo(10)
    expect(lengths[1]).toBeCloseTo(Math.hypot(50, 50))
    expect(lengths[2]).toBeCloseTo(7)
    // 70.71 mm at 2000 mm/min = 2.12 s, 17 mm at 500 mm/min = 2.04 s
    expect(goToSeconds(from, steps, { xy: 2000, z: 500 })).toBe(5)
  })
})

describe('goToZeroTarget: the DRO →0 (DF140)', () => {
  // the tool 2 mm inside the stock at work (12, 7, −2); the safe height is work Z 5
  const wpos = [12, 7, -2] as const
  const from = [-388, -293, -82] as const
  it('X: X 0, Y kept, Z up to the safe height; up, then across, never back down', () => {
    const target = goToZeroTarget({ wpos, wco, axis: 'x', safeZ: -75 })
    expect(target).toEqual([0, 7, 5])
    expect(plan({ from, target }).map((s) => s.to)).toEqual([
      [-388, -293, -75],
      [-400, -293, -75],
    ])
  })
  it('Y above the safe height keeps its Z', () => {
    expect(goToZeroTarget({ wpos: [12, 7, 20], wco, axis: 'y', safeZ: -75 })).toEqual([12, 0, 20])
  })
  it('Z: Z alone to the work zero, one step', () => {
    const target = goToZeroTarget({ wpos: [12, 7, 20], wco, axis: 'z', safeZ: -75 })
    expect(target).toEqual([12, 7, 0])
    expect(plan({ from: [-388, -293, -60], target })).toEqual([
      { to: [-388, -293, -80], axis: 'z' },
    ])
  })
})
