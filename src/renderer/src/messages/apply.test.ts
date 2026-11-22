import { describe, expect, it } from 'vitest'
import { applyMessages, fieldWords, pendingList } from './apply'

describe('apply messages', () => {
  it('names fields in words', () => {
    expect(fieldWords('depth')).toBe('depth')
    expect(fieldWords('shape.cornerRadius')).toBe('corner radius')
    expect(fieldWords('overrides.feedRate')).toBe('feed rate')
    expect(fieldWords('design changes not followed yet')).toBe('design changes not followed yet')
  })

  it('groups the pending list by subject and cuts it after four groups', () => {
    expect(
      pendingList(['Pocket 1: depth', 'Pocket 1: shape.cornerRadius', 'Drilling 2 added']),
    ).toBe('Pocket 1: depth, corner radius · Drilling 2 added')
    expect(pendingList(['Pocket 1: depth', 'Pocket 1: depth'])).toBe('Pocket 1: depth')
    expect(pendingList(['A added', 'B added', 'C added', 'D added', 'E added', 'F added'])).toBe(
      'A added · B added · C added · D added · (and 2 more)',
    )
    expect(pendingList([])).toBe('')
  })

  it('counts changes in the accessible name', () => {
    expect(applyMessages.name(1)).toBe('Apply 1 change')
    expect(applyMessages.name(3)).toBe('Apply 3 changes')
    expect(applyMessages.appliedBy('agent')).toBe('Applied by agent')
    expect(applyMessages.appliedBy('cli')).toBe('Applied by command line')
  })
})
