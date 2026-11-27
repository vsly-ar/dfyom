// Which run's Z reference the viewport shows and where a dragged spot lands (DF69).
// Doc: docs/modes/z-reference.md#implementation-notes-df69
import { describe, expect, it } from 'vitest'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import { insideArea, shownZRefRun, snapSpot } from './z-spot'

/** A 100 × 60 rectangle with a 20 × 20 hole in the middle, eroded by nothing. */
const square = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as [number, number][]
const area = [{ outer: square(0, 0, 100, 60), holes: [square(40, 20, 60, 40)] }]

describe('insideArea', () => {
  it('is inside the outer ring and outside its holes', () => {
    expect(insideArea(area, [10, 10])).toBe(true)
    expect(insideArea(area, [50, 30])).toBe(false)
    expect(insideArea(area, [-1, 10])).toBe(false)
  })
})

describe('snapSpot', () => {
  it('rounds to the grid inside the area', () => {
    expect(snapSpot([10.4, 10.6], 1, area)).toEqual([10, 11])
    expect(snapSpot([10.4, 10.6], 1.27, area)).toEqual([10.16, 10.16])
  })

  it('stops at the edge when the pointer leaves the area or enters a hole', () => {
    expect(snapSpot([-20, 10.2], 1, area)).toEqual([1, 10])
    expect(snapSpot([45, 30.2], 1, area)).toEqual([39, 30])
  })

  it('is undefined with no area', () => {
    expect(snapSpot([1, 1], 1, [])).toBeUndefined()
  })
})

describe('shownZRefRun', () => {
  const op = (id: string, tool: string) => ({ id, tool, designOperationIds: [id] })
  const plan = {
    setups: [
      { id: 's1', operations: [op('a', 't1'), op('b', 't1'), op('c', 't2')] },
      { id: 's2', operations: [op('d', 't2')] },
    ],
    design: { part: { operations: [] } },
  } as unknown as PlanDTO

  it('takes a previewed run start, else the selected operation’s run, else the setup’s first', () => {
    expect(shownZRefRun(plan, null, undefined)).toBeUndefined()
    expect(shownZRefRun(plan, 's1', undefined)).toBe('a')
    expect(shownZRefRun(plan, 'b', undefined)).toBe('a')
    expect(shownZRefRun(plan, 'c', undefined)).toBe('c')
    expect(shownZRefRun(plan, 's1', 'c')).toBe('c')
    // a preview that starts no run is ignored
    expect(shownZRefRun(plan, 's2', 'b')).toBe('d')
  })
})
