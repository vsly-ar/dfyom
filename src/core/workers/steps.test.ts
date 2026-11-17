// Spec: docs/architecture/workers.md#abort-and-pause
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import {
  CONTROL_BYTES,
  noSteps,
  RUN_STATE,
  setRunState,
  sharedSteps,
  signalSteps,
  type StepProgress,
} from './steps'

describe('steps', () => {
  it('noSteps never aborts', () => {
    expectOk(noSteps.step({ done: 1 }))
  })

  it('signalSteps reports progress until aborted', () => {
    const ac = new AbortController()
    const ticks: StepProgress[] = []
    const s = signalSteps(ac.signal, (p) => ticks.push(p))
    expectOk(s.step({ done: 1, total: 2 }))
    expectOk(s.step())
    ac.abort()
    expectErrCode(s.step({ done: 2, total: 2 }), 'op.aborted')
    expect(ticks).toEqual([{ done: 1, total: 2 }])
  })

  it('sharedSteps runs while the control word is 0 and aborts once it is 2', () => {
    const control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES))
    const ticks: StepProgress[] = []
    const s = sharedSteps(control, { progress: (p) => ticks.push(p) })
    expectOk(s.step({ done: 1, label: 'a' }))
    setRunState(control, RUN_STATE.abort)
    expect(Atomics.load(control, 0)).toBe(2)
    expectErrCode(s.step({ done: 2 }), 'op.aborted')
    expect(ticks.map((t) => t.done)).toEqual([1, 2])
  })

  it('an abort written over a pause never parks', () => {
    const control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES))
    const parked: string[] = []
    const s = sharedSteps(control, { parked: (state) => parked.push(state) })
    setRunState(control, RUN_STATE.pause)
    setRunState(control, RUN_STATE.abort)
    expectErrCode(s.step(), 'op.aborted')
    expect(parked).toEqual([])
  })
})
