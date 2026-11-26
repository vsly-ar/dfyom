// The recent projects' relative times (DF114). Doc: docs/conventions/ui.md#project-files
import { describe, expect, it } from 'vitest'
import { relativeTime } from './project'

describe('relativeTime', () => {
  const now = Date.UTC(2026, 10, 25, 12, 0)
  it('says how long ago, then the date', () => {
    expect(relativeTime(now - 10_000, now)).toBe('Just now')
    expect(relativeTime(now + 10_000, now)).toBe('Just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe('Yesterday')
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago')
    expect(relativeTime(Date.UTC(2026, 10, 12, 12, 0), now)).toBe('12 Nov 2026')
  })
})
