// DF127: face-frame axis labels name the part axis they lie along (docs/modes/design-v0.2.md).
import { describe, expect, it } from 'vitest'
import { frameAxisLabel } from './frame-axis-label'

describe('frameAxisLabel', () => {
  it('names the part axis and its sign with the true minus sign', () => {
    expect(frameAxisLabel('u', [-1, 0, 0])).toBe('u (−X)')
    expect(frameAxisLabel('v', [0, 1, 0])).toBe('v (+Y)')
    expect(frameAxisLabel('v', [0, 0, -1])).toBe('v (−Z)')
    expect(frameAxisLabel('u', [0, 0, 2])).toBe('u (+Z)')
  })
  it('tolerates a tiny tilt, not a real one', () => {
    const tiny = (0.1 * Math.PI) / 180
    expect(frameAxisLabel('u', [Math.cos(tiny), Math.sin(tiny), 0])).toBe('u (+X)')
    const tilt = (1 * Math.PI) / 180
    expect(frameAxisLabel('u', [Math.cos(tilt), Math.sin(tilt), 0])).toBe('u')
    expect(frameAxisLabel('v', [Math.SQRT1_2, 0, Math.SQRT1_2])).toBe('v')
  })
  it('keeps the bare name for a degenerate vector', () => {
    expect(frameAxisLabel('u', [0, 0, 0])).toBe('u')
  })
})
