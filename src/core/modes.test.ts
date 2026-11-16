import { describe, expect, it } from 'vitest'
import { APP_MODES, isAppMode } from './modes'

describe('app modes', () => {
  it('has exactly design, plan and run', () => {
    expect(APP_MODES).toEqual(['design', 'plan', 'run'])
  })

  it('narrows strings to AppMode', () => {
    expect(isAppMode('plan')).toBe(true)
    expect(isAppMode('simulate')).toBe(false)
  })
})
