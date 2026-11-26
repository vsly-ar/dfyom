// The test-only G-code oracle itself (workholding.md § Testing): true arcs, and a later tool's
// own Z0 below the stock top (DF69) counted from its tool change.
import { describe, expect, it } from 'vitest'
import { gcodeClearance } from './gcode-oracle.testing'

const BOX = [{ x: [0, 10], y: [0, 10], top: 25 }] as const

describe('gcodeClearance', () => {
  it('measures a line and a true arc below the box top + margin, ignores moves above it', () => {
    expect(gcodeClearance('G21\nG0 X20 Y5 Z10\nG1 X30\n', BOX, 3)).toBe(7)
    // a half circle about (20, 5) of radius 5 reaches X15: 5 − 3
    expect(gcodeClearance('G21\nG0 X25 Y5 Z10\nG3 X15 Y5 I-5 J0\n', BOX, 3)).toBeCloseTo(2, 6)
    expect(gcodeClearance('G21\nG0 X12 Y5 Z27\nG1 X20\n', BOX, 3)).toBe(Infinity)
  })

  it("a later tool's Z0 below the stock top lowers its moves from its tool change on", () => {
    const program = (z0: string) =>
      [
        'G21',
        'G0 X30 Y5 Z27.5',
        `(Z0 for tool 2: Facing 1 floor, ${z0} below the stock top)`,
        '(DFYOM TOOL CHANGE 2: Flat 2, 2 mm flat)',
        'M0',
        'G0 X14 Y5 Z27.5',
        'G1 X20',
      ].join('\n')
    // Z27.5 above a floor 1 mm down is Z26.5 from the stock top: under 25 + 2
    expect(gcodeClearance(program('1.00'), BOX, 3)).toBe(1)
    expect(gcodeClearance(program('0.00'), BOX, 3)).toBe(Infinity)
  })
})
