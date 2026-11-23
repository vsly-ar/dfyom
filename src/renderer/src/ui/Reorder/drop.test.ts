import { describe, expect, it } from 'vitest'
import { dropGap, dropIndex, edgeScrollSpeed, movedFrom, moveItem } from './drop'

describe('drag to reorder maths (D45)', () => {
  it('the gap is how many row middles lie above the pointer', () => {
    const mids = [15, 45, 75]
    expect(dropGap(mids, 0)).toBe(0)
    expect(dropGap(mids, 16)).toBe(1)
    expect(dropGap(mids, 74)).toBe(2)
    expect(dropGap(mids, 200)).toBe(3)
  })

  it('a row dropped in a gap lands at its index; its own gaps keep it', () => {
    expect(dropIndex(1, 0)).toBe(0)
    expect(dropIndex(1, 1)).toBe(1)
    expect(dropIndex(1, 2)).toBe(1)
    expect(dropIndex(1, 3)).toBe(2)
  })

  it('movedFrom inverts moveItem', () => {
    const list = ['a', 'b', 'c', 'd', 'e']
    for (let from = 0; from < list.length; from++)
      for (let to = 0; to < list.length; to++) {
        const next = moveItem(list, from, to)
        expect(next.map((_, j) => list[movedFrom(j, from, to)])).toEqual(next)
      }
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(moveItem(list, 9, 0)).toEqual(list)
  })

  it('auto-scrolls near the edges only, faster closer to them (U3)', () => {
    // a 300 px container at 100…400, bands of 32 px, at most 14 px per frame
    expect(edgeScrollSpeed(250, 100, 400)).toBe(0)
    expect(edgeScrollSpeed(132, 100, 400)).toBe(0)
    expect(edgeScrollSpeed(368, 100, 400)).toBe(0)
    expect(edgeScrollSpeed(116, 100, 400)).toBe(-7)
    expect(edgeScrollSpeed(100, 100, 400)).toBe(-14)
    expect(edgeScrollSpeed(50, 100, 400)).toBe(-14)
    expect(edgeScrollSpeed(384, 100, 400)).toBe(7)
    expect(edgeScrollSpeed(420, 100, 400)).toBe(14)
    // a short container splits itself into two bands
    expect(edgeScrollSpeed(110, 100, 140)).toBeLessThan(0)
    expect(edgeScrollSpeed(130, 100, 140)).toBeGreaterThan(0)
    expect(edgeScrollSpeed(120, 100, 100)).toBe(0)
  })
})
