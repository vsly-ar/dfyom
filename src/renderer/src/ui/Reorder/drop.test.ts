import { describe, expect, it } from 'vitest'
import { dropGap, dropIndex, movedFrom, moveItem } from './drop'

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
})
