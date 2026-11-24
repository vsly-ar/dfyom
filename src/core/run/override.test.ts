// Override targets (hardening DF85). Spec: docs/modes/run-machine.md#overrides-m6
import { describe, expect, it } from 'vitest'
import {
  applyOverrideStep,
  CONTROLLER_OVERRIDE_LIMITS,
  overrideCap,
  overrideLimits,
  overrideSteps,
  programmedRates,
} from './override'

const grbl = overrideLimits('grbl')
const range = grbl.feed
const unbounded = { min: -1e9, max: 1e9 }

/** Applies the steps one at a time, clamped like GRBL. */
const run = (from: number, steps: ReturnType<typeof overrideSteps>) =>
  steps.reduce((v, s) => applyOverrideStep(v, s, range), from)

describe('overrideSteps', () => {
  it('reaches every target from every start, never clamped on the way, in few bytes', () => {
    for (let from = range.min; from <= range.max; from++)
      for (let to = range.min; to <= range.max; to++) {
        const steps = overrideSteps(from, to, range)
        expect(run(from, steps)).toBe(to)
        // unclamped: every step moves by its full size and stays inside 10–200 %
        let v = from
        for (const s of steps) {
          v = applyOverrideStep(v, s, unbounded)
          expect(v).toBeGreaterThanOrEqual(range.min)
          expect(v).toBeLessThanOrEqual(range.max)
        }
        // never more than going via 100 % (a reset, then coarse and at most 5 fine steps)
        expect(steps.length).toBeLessThanOrEqual(1 + Math.ceil(Math.abs(to - 100) / 10) + 5)
      }
  })

  it('takes the coarse and fine mix and the reset when they are shorter', () => {
    expect(overrideSteps(100, 100, range)).toEqual([])
    expect(overrideSteps(100, 130, range)).toEqual(['+10', '+10', '+10'])
    expect(overrideSteps(100, 109, range)).toEqual(['+10', '-1'])
    expect(overrideSteps(100, 93, range)).toEqual(['-10', '+1', '+1', '+1'])
    expect(overrideSteps(187, 100, range)).toEqual(['reset'])
    expect(overrideSteps(187, 110, range)).toEqual(['reset', '+10'])
    // near the ends the order keeps every step inside 10–200 %
    expect(overrideSteps(195, 199, range)).toEqual(['+1', '+1', '+1', '+1'])
    expect(overrideSteps(15, 11, range)).toEqual(['-1', '-1', '-1', '-1'])
    expect(overrideSteps(198, 191, range)).toEqual(['-10', '+1', '+1', '+1'])
  })

  it('starts with a reset when the current override is not known', () => {
    expect(overrideSteps(undefined, 120, range)).toEqual(['reset', '+10', '+10'])
    expect(overrideSteps(undefined, 100, range)).toEqual(['reset'])
  })
})

describe('overrideCap', () => {
  const controller = { min: 10, max: 200, by: 'controller', floorBy: 'controller' }

  it('is the controller range without a programmed value or machine maximum', () => {
    expect(overrideCap(range, undefined, 5000)).toEqual(controller)
    expect(overrideCap(range, 0, 5000)).toEqual(controller)
    expect(overrideCap(range, 1000, undefined)).toEqual(controller)
    expect(overrideCap(range, 1000, 5000)).toEqual(controller)
  })

  it('lowers the top to the machine maximum for the programmed value', () => {
    expect(overrideCap(range, 3000, 5000)).toEqual({ ...controller, max: 166, by: 'machine' })
    expect(overrideCap(grbl.spindle, 18000, 24000)).toEqual({
      ...controller,
      max: 133,
      by: 'machine',
    })
    expect(overrideCap(range, 2500, 5000)).toEqual(controller)
    // a programmed value far over the maximum: never below the controller's minimum
    expect(overrideCap(range, 1e6, 5000).max).toBe(10)
  })

  it("raises the bottom to the spindle's minimum speed for the programmed S (DF86)", () => {
    const sp = grbl.spindle
    // the user's router: min 6200 rpm, max 24000 rpm; S 18000 → 34.4… % → 35 %
    expect(overrideCap(sp, 18000, 24000, 6200)).toEqual({
      min: 35,
      max: 133,
      by: 'machine',
      floorBy: 'machine',
    })
    // exact: no rounding up past the floor
    expect(overrideCap(sp, 12400, undefined, 6200)).toMatchObject({ min: 50, floorBy: 'machine' })
    // S at the minimum: 100 % is the floor
    expect(overrideCap(sp, 6200, 24000, 6200).min).toBe(100)
    // a floor under the controller's minimum leaves the controller's
    expect(overrideCap(sp, 100000, undefined, 6200)).toMatchObject({
      min: 10,
      floorBy: 'controller',
    })
    // spindle off (S 0) or no run: no floor
    expect(overrideCap(sp, 0, 24000, 6200)).toEqual(controller)
    expect(overrideCap(sp, undefined, 24000, 6200)).toEqual(controller)
    // no minimum speed in the profile
    expect(overrideCap(sp, 18000, undefined, undefined)).toEqual(controller)
    expect(overrideCap(sp, 18000, undefined, 0)).toEqual(controller)
    // a programmed S far under the minimum: the floor never passes the top
    expect(overrideCap(sp, 1000, 24000, 6200)).toMatchObject({ min: 200, max: 200 })
    expect(overrideCap(sp, 3000, 4000, 6200)).toMatchObject({ min: 133, max: 133 })
  })

  it('reads the limits per controller kind', () => {
    expect(CONTROLLER_OVERRIDE_LIMITS.grbl).toMatchObject({
      feed: { min: 10, max: 200 },
      spindle: { min: 10, max: 200 },
    })
  })
})

describe('programmedRates', () => {
  it('follows the modal F and S, the spindle state and inch programs', () => {
    const r = programmedRates([
      '(T1 F999 in a comment)',
      'G90 G21',
      'M3 S12000',
      'G1 X1 F800',
      'G1 X2',
      'M5',
      'G20 G1 X3 F10',
      'M4 S8000 ; F5',
    ])
    expect([...r.feed]).toEqual([0, 0, 0, 800, 800, 800, 254, 254])
    expect([...r.spindle]).toEqual([0, 0, 12000, 12000, 12000, 0, 0, 8000])
  })
})
