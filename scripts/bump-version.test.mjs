import { describe, expect, it } from 'vitest'
import { bumpPatch, touchesAppCode } from './bump-version.mjs'

describe('touchesAppCode', () => {
  it('detects source changes', () => {
    expect(touchesAppCode(['docs/x.md', 'src/core/modes.ts'])).toBe(true)
    expect(touchesAppCode(['electron.vite.config.ts'])).toBe(true)
  })

  it('ignores docs, tests and tooling', () => {
    expect(touchesAppCode(['docs/vision.md', 'README.md', 'scripts/bump-version.mjs'])).toBe(false)
    expect(touchesAppCode(['src/core/modes.test.ts', 'src/core/README.md'])).toBe(false)
    expect(touchesAppCode([])).toBe(false)
  })
})

describe('bumpPatch', () => {
  it('increments the patch number', () => {
    expect(bumpPatch('0.0.0')).toBe('0.0.1')
    expect(bumpPatch('1.4.9')).toBe('1.4.10')
    expect(bumpPatch('2.0.0-beta.1')).toBe('2.0.1')
  })

  it('rejects non-semver', () => {
    expect(() => bumpPatch('latest')).toThrow()
  })
})
