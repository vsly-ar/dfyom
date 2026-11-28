// Work area math (v0.5 RV7). Spec: docs/modes/run.md#work-area-rv7
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../shared/testing/result'
import { stepsViolation } from './goto'
import {
  limitBounds,
  limitViolation,
  markProblem,
  marksEmpty,
  travelSuggestions,
  withMark,
  workAreaBounds,
  workAreaSize,
  type WorkAreaMarks,
} from './work-area'

const TRAVEL = [800, 600, 100] as const

describe('work area (RV7)', () => {
  it('moves each marked side in by the margin, unmarked sides stay at the travel', () => {
    const marks: WorkAreaMarks = { x: { min: -790, max: -5 }, z: { min: -90 } }
    expect(workAreaBounds(TRAVEL, { marks, margin: 2 })).toEqual({
      min: [-788, -600, -88],
      max: [-7, 0, 0],
    })
    // never wider than the travel, whatever the mark
    expect(workAreaBounds(TRAVEL, { marks: { y: { min: -700 } }, margin: 0 }).min[1]).toBe(-600)
    expect(workAreaSize(TRAVEL, { marks, margin: 2 })).toEqual([781, 600, 88])
    // a margin wider than half the span: nothing left on that axis
    expect(workAreaSize(TRAVEL, { marks: { x: { min: -10, max: -6 } }, margin: 3 })[0]).toBe(0)
  })

  it('checks the travel strictly and the area only for moves that go further out', () => {
    const workArea = workAreaBounds(TRAVEL, { marks: { x: { max: -12 } }, margin: 2 })
    const limits = { travel: TRAVEL, workArea }
    expect(limitBounds({ travel: TRAVEL })).toEqual({ min: [-800, -600, -100], max: [0, 0, 0] })
    expect(limitBounds(limits)).toBe(workArea)
    // the travel: a µm of slack, no more
    expect(limitViolation({ travel: TRAVEL }, [0.0000005, 0, 0])).toBeUndefined()
    expect(limitViolation({ travel: TRAVEL }, [0.01, 0, 0])).toMatchObject({ axis: 'x', max: 0 })
    // inside the area
    expect(limitViolation(limits, [-20, -1, -1])).toBeUndefined()
    // outside without a start: refused, marked as the work area
    expect(limitViolation(limits, [-10, 0, 0])).toEqual({
      axis: 'x',
      target: -10,
      min: -800,
      max: -14,
      workArea: true,
    })
    // homed at −2 (outside): moving inward is allowed, further out is not
    expect(limitViolation(limits, [-10, 0, 0], [-2, 0, 0])).toBeUndefined()
    expect(limitViolation(limits, [-1, 0, 0], [-2, 0, 0])).toMatchObject({ workArea: true })
    // out by as much on the other side is refused too
    const both = {
      travel: TRAVEL,
      workArea: workAreaBounds(TRAVEL, { marks: { x: { min: -700, max: -12 } }, margin: 2 }),
    }
    expect(limitViolation(both, [-12, 0, 0], [-700, 0, 0])).toMatchObject({ max: -14 })
    // the travel still wins over a start outside it
    expect(limitViolation(limits, [1, 0, 0], [-2, 0, 0])).toMatchObject({ max: 0 })
  })

  it('chains the start through the steps of a Go to', () => {
    const workArea = workAreaBounds(TRAVEL, { marks: { z: { max: -10 } }, margin: 2 })
    const limits = { travel: TRAVEL, pullOff: 2, workArea }
    // up to −12 then across: fine; up to −5 (above the area) from −50: refused at step 0
    expect(
      stepsViolation(
        [-100, -100, -50],
        [{ to: [-100, -100, -12] }, { to: [-50, -50, -12] }],
        limits,
        't',
        'it',
      ),
    ).toBeUndefined()
    const r = stepsViolation([-100, -100, -50], [{ to: [-100, -100, -5] }], limits, 't', 'Go to')
    expect(r).toBeDefined()
    const e = expectErrCode(r!, 'run.travel')
    expect(e.message).toContain('Z would leave the work area')
    expect(e.toJSON().frames[0]?.data).toMatchObject({ step: 0, workArea: true })
  })

  it('suggests a $13n line from the switch to the far mark, both ways', () => {
    const env = { travel: TRAVEL, homingMask: 0 }
    // homing to +: the far side is min; 790 from the switch at 0, travel 800: lower
    expect(travelSuggestions(env, { x: { min: -790 } })).toEqual([
      { axis: 'x', setting: '$130', reach: 790, travel: 800, kind: 'lower', line: '$130=790.000' },
    ])
    // the near side does not count; under 0.5 mm is not worth it
    expect(travelSuggestions(env, { x: { max: -5 }, y: { min: -599.8 } })).toEqual([])
    // Y homes to − ($23 bit 1): its far side is max, measured from −600
    const front = { travel: TRAVEL, homingMask: 2 }
    expect(travelSuggestions(front, { y: { max: 10 } })[0]).toMatchObject({
      setting: '$131',
      reach: 610,
      kind: 'raise',
      line: '$131=610.000',
    })
  })

  it('sets, clears and guards marks', () => {
    let marks: WorkAreaMarks = {}
    expect(marksEmpty(marks)).toBe(true)
    marks = withMark(marks, 'x', 'min', -700)
    marks = withMark(marks, 'x', 'max', -3)
    expect(marks).toEqual({ x: { min: -700, max: -3 } })
    expect(markProblem(marks, 'x', 'min', -2)).toBe('crossed')
    expect(markProblem(marks, 'x', 'max', -701)).toBe('crossed')
    expect(markProblem(marks, 'x', 'max', -10)).toBeUndefined()
    marks = withMark(marks, 'x', 'min', undefined)
    expect(marks).toEqual({ x: { max: -3 } })
    expect(marksEmpty(withMark(marks, 'x', 'max', undefined))).toBe(true)
  })
})
