// The Run alignment step, pure part (DF78).
// Spec: docs/modes/alignment.md#run-the-alignment-step, #ticks-and-the-confirm-gate
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  alignmentGate,
  confirmStep,
  entryTo,
  pointerMoves,
  pointerReady,
  reconcileStep,
  startStep,
  tickEntry,
  type StepStatus,
} from './alignment'
import type { SetupDTO } from '../plan/plan.dto'

const status = (over: Partial<StepStatus> = {}): StepStatus => ({
  connection: { state: 'open' },
  state: 'Idle',
  homed: true,
  mpos: [-100, -100, -5],
  wpos: [0, 0, 5],
  workZero: [-100, -100, -10],
  spindle: 0,
  ...over,
})
const entries = [
  { id: 'zero', name: 'Work zero', target: [0, 0] as [number, number], ticked: false },
  { id: 'a', name: 'Mark A', target: [50, 20] as [number, number], ticked: false },
  { id: 'b', name: 'Mark B', target: [-10, 30] as [number, number], ticked: false },
]
const setup = { id: 's', name: 'Top', alignment: [{ id: 'a' }] } as unknown as SetupDTO

describe('alignment step', () => {
  it('moves up to the clearance height, then over X/Y; none when there', () => {
    // G54 Z on the top (level 0), clearance 10: Z up to G54.z + 10 = 0 → capped at −0.5
    expect(pointerMoves(status(), [50, 20], 10)).toEqual([
      { to: [-100, -100, -0.5], feed: 500 },
      { to: [-50, -80, -0.5], feed: 2000 },
    ])
    // G54 Z on a surface 20 below the top: clearance above the top; already higher: no Z move
    const low = status({ workZero: [-100, -100, -40], zeroLevel: -20, mpos: [-100, -100, -5] })
    expect(pointerMoves(low, [-10, 0], 5)).toEqual([{ to: [-110, -100, -5], feed: 2000 }])
    expect(pointerMoves(status(), [0, 0], 10)).toEqual([])
  })

  it('walks the entries, wrapping', () => {
    expect(entryTo({ entries }, 'next')?.id).toBe('zero')
    expect(entryTo({ entries, current: 'b' }, 'next')?.id).toBe('zero')
    expect(entryTo({ entries, current: 'zero' }, 'previous')?.id).toBe('b')
    expect(entryTo({ entries }, 'a')?.id).toBe('a')
    expect(entryTo({ entries }, 'nope')).toBeUndefined()
  })

  it('refuses a move with the spindle on or not Idle', () => {
    expect(
      expectErrCode(pointerReady(status({ spindle: 1000 }), 'w'), 'run.state').issues[0]?.rule,
    ).toBe('spindleOn')
    expectErrCode(pointerReady(status({ state: 'Jog' }), 'w'), 'run.state')
    expectOk(pointerReady(status(), 'w'))
  })

  it('ticks at the entry, confirms, and a G54 X/Y change clears it', () => {
    let step = startStep('p', 's', entries, status())
    const far = expectErrCode(tickEntry(step, 'a', true, status(), 'w'), 'run.state')
    expect(far.issues[0]?.rule).toBe('notAtPoint')
    step = expectOk(tickEntry(step, 'zero', true, status(), 'w'))
    step = expectOk(tickEntry(step, 'a', true, status({ wpos: [50, 20.005, 5] }), 'w'))
    expect(
      expectErrCode(confirmStep(step, false, 'w'), 'run.state').toJSON().frames[0]?.data,
    ).toMatchObject({
      unticked: ['b'],
    })
    step = expectOk(confirmStep(step, true, 'w'))
    expect(step).toMatchObject({ confirmed: true, skipped: ['b'] })
    expectOk(alignmentGate(step, 'p', setup, status(), 'w'))
    // the same G54 (Z changes do not count): kept
    expect(reconcileStep(step, status({ workZero: [-100, -100, -12] }))).toBe(step)
    const moved = reconcileStep(step, status({ workZero: [-99, -100, -10] }))!
    expect(moved).toMatchObject({ confirmed: false, skipped: [], zeroAt: [-99, -100] })
    expect(moved.entries.some((e) => e.ticked)).toBe(false)
    const gate = expectErrCode(
      alignmentGate(moved, 'p', setup, status({ workZero: [-99, -100, -10] }), 'w'),
      'run.state',
    )
    expect(gate.issues[0]?.rule).toBe('alignmentPending')
    // a lost position or a closed connection drops the step
    expect(reconcileStep(step, status({ state: 'Alarm' }))).toBeUndefined()
    expect(reconcileStep(step, status({ connection: { state: 'closed' } }))).toBeUndefined()
    // a setup without points has no gate
    expectOk(alignmentGate(undefined, 'p', { ...setup, alignment: [] }, status(), 'w'))
  })
})
