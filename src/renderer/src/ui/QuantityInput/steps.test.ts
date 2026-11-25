// Doc: docs/conventions/inspector-layout.md#field-step-model-df104
import { describe, expect, it } from 'vitest'
import { STEP_LADDERS, stepLabel, stepsFor, unitSystemOf, type StepKind } from './steps'

const metric = { unitSystem: 'metric' as const }
const imperial = { unitSystem: 'imperial' as const }

describe('step ladders', () => {
  it('every ladder is ascending, at most six steps, and holds its default', () => {
    for (const [kind, l] of Object.entries(STEP_LADDERS)) {
      for (const sys of ['metric', 'imperial'] as const) {
        const steps = l[sys].map(Number)
        expect(steps, `${kind} ${sys}`).toEqual([...steps].sort((a, b) => a - b))
        expect(steps.length, `${kind} ${sys}`).toBeLessThanOrEqual(6)
        expect(l[sys], `${kind} ${sys}`).toContain(l.default[sys])
      }
    }
  })

  it('has the doc’s ladders for depth, xy and feed', () => {
    expect(stepsFor('depth', metric).steps).toEqual(['0.01', '0.1', '0.5', '1', '5', '10'])
    expect(stepsFor('depth', imperial).steps).toEqual(['0.001', '0.01', '0.05', '0.1', '0.5', '1'])
    expect(stepsFor('xy', metric).steps).toEqual(['0.1', '0.5', '1', '5', '10', '50'])
    expect(stepsFor('feed', imperial).steps).toEqual(['1', '5', '10', '50'])
  })

  it('labels drop the leading zero', () => {
    expect(stepLabel('0.1')).toBe('.1')
    expect(stepLabel('10')).toBe('10')
  })

  it('inch display units take the imperial ladder', () => {
    expect(unitSystemOf('in')).toBe('imperial')
    expect(unitSystemOf('in/min')).toBe('imperial')
    expect(unitSystemOf('mm')).toBe('metric')
    expect(unitSystemOf('deg')).toBe('metric')
  })
})

describe('default step (rule 3)', () => {
  const initial = (kind: StepKind, value?: number) => stepsFor(kind, { ...metric, value }).initial

  it('is the kind default for an empty, zero or large value', () => {
    expect(initial('depth')).toBe('0.1')
    expect(initial('depth', 0)).toBe('0.1')
    expect(initial('depth', 3)).toBe('0.1')
    expect(initial('xy', 120)).toBe('1')
    expect(initial('rpm', 18000)).toBe('1000')
    expect(initial('rotation', 0)).toBe('15')
  })

  it('is lowered to the largest step not above half the value', () => {
    expect(initial('depth', 0.3)).toBe('0.1')
    expect(initial('depth', 0.15)).toBe('0.01')
    expect(initial('fit', 0.05)).toBe('0.01')
    expect(initial('fit', 0.015)).toBe('0.005')
    expect(initial('xy', 1.5)).toBe('0.5')
    expect(initial('rotation', 10)).toBe('5')
    expect(initial('depth', -0.3)).toBe('0.1') // the magnitude
  })

  it('takes the smallest step when even that is above half the value', () => {
    expect(initial('depth', 0.005)).toBe('0.01')
    expect(initial('count', 1)).toBe('1')
  })

  it('in inch: the imperial default', () => {
    expect(stepsFor('depth', { ...imperial, value: 0.5 }).initial).toBe('0.01')
    expect(stepsFor('xy', { ...imperial, value: 4 }).initial).toBe('0.1')
  })
})

describe('scaling to the stock and limits (rule 5)', () => {
  it('hides depth steps above half the stock thickness (10.1 mm board)', () => {
    const s = stepsFor('depth', { ...metric, scale: { thickness: 10.1 } })
    expect(s.steps).toEqual(['0.01', '0.1', '0.5', '1', '5'])
  })

  it('caps xy and small by the largest side, feed and rpm by the machine', () => {
    expect(stepsFor('xy', { ...metric, scale: { side: 60 } }).steps).toEqual([
      '0.1',
      '0.5',
      '1',
      '5',
      '10',
    ])
    expect(stepsFor('feed', { ...metric, scale: { maxFeed: 1500 } }).steps).toEqual([
      '10',
      '50',
      '100',
      '500',
    ])
    expect(stepsFor('rpm', { ...metric, scale: { maxRpm: 8000 } }).steps).toEqual([
      '100',
      '500',
      '1000',
    ])
  })

  it('caps an inch project in inches', () => {
    // 12.7 mm = 0.5 in: steps up to 0.25 in
    const s = stepsFor('depth', { ...imperial, scale: { thickness: 12.7 } })
    expect(s.steps).toEqual(['0.001', '0.01', '0.05', '0.1'])
  })

  it('keeps at least the three smallest steps', () => {
    const s = stepsFor('depth', { ...metric, scale: { thickness: 0.5 } })
    expect(s.steps).toEqual(['0.01', '0.1', '0.5'])
  })

  it('kinds without a cap ignore the stock', () => {
    expect(stepsFor('fit', { ...metric, scale: { thickness: 1, side: 1 } }).steps).toHaveLength(4)
  })

  it('the preselected step is always a shown step', () => {
    const s = stepsFor('xy', { ...metric, scale: { side: 2 }, value: 100 })
    expect(s.steps).toEqual(['0.1', '0.5', '1'])
    expect(s.initial).toBe('1')
    const d = stepsFor('rpm', { ...metric, scale: { maxRpm: 1000 }, value: 24000 })
    expect(d.steps).toContain(d.initial)
  })
})

describe('integers (rule 6)', () => {
  it('count fields are integer with integer steps', () => {
    const s = stepsFor('count', metric)
    expect(s.integer).toBe(true)
    expect(s.steps).toEqual(['1', '2', '5', '10'])
    expect(stepsFor('depth', metric).integer).toBe(false)
  })

  it('stop at the field’s maximum: ≤ 20 keeps 10, ≤ 12 stops at 5', () => {
    expect(stepsFor('count', { ...metric, max: 20 }).steps).toEqual(['1', '2', '5', '10'])
    expect(stepsFor('count', { ...metric, max: 12 }).steps).toEqual(['1', '2', '5'])
  })
})

describe('remembered step (rule 4)', () => {
  it('wins over the default while it fits the scaled ladder', () => {
    expect(stepsFor('depth', { ...metric, value: 0.3, remembered: '1' }).initial).toBe('1')
    const scaled = stepsFor('depth', { ...metric, remembered: '10', scale: { thickness: 10.1 } })
    expect(scaled.initial).toBe('0.1')
    expect(stepsFor('depth', { ...metric, remembered: '0.25' }).initial).toBe('0.1')
  })
})
