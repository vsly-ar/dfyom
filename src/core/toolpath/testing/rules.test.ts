// Spec: docs/modes/plan-v0.1.md#toolpath-generators-task-210 (common rules: vertical speed)
import { describe, expect, it } from 'vitest'
import type { Move, Toolpath } from '../model'
import { violations, type PathRules } from './rules'

const rules: PathRules = {
  feedRate: 1200,
  plungeRate: 300,
  rampAngle: 3,
  retractZ: 2,
  clearanceZ: 10,
  targetZ: -2,
  contains: () => true,
}

function path(moves: Move[]): Toolpath {
  return {
    planOperationId: 'op',
    tool: 'tool',
    spindleSpeed: 10000,
    passes: [{ kind: 'rough', moves }],
    stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
  } as unknown as Toolpath
}

const down: Move[] = [
  { kind: 'rapid', to: [0, 0, 10] },
  { kind: 'rapid', to: [0, 0, 2] },
  { kind: 'line', to: [0, 0, -2], feed: 300 },
]

describe('violations: vertical speed of upward feed moves', () => {
  it('flags a steep upward feed move whose Z speed exceeds the plunge rate', () => {
    // 4 mm up over 1 mm XY at 1200: Z speed ≈ 1164 mm/min
    const tp = path([
      ...down,
      { kind: 'line', to: [1, 0, 2], feed: 1200 },
      { kind: 'rapid', to: [1, 0, 10] },
    ])
    expect(
      violations(tp, rules).some((v) => v.startsWith('rises faster than the plunge rate')),
    ).toBe(true)
  })

  it('accepts a shallow upward feed move and a vertical lift at the plunge rate', () => {
    const tp = path([
      ...down,
      { kind: 'line', to: [0, 0, -1], feed: 300 },
      // 1 mm up over 20 mm XY at 1200: Z speed ≈ 60 mm/min
      { kind: 'line', to: [20, 0, 0], feed: 1200 },
      { kind: 'rapid', to: [20, 0, 10] },
    ])
    expect(violations(tp, rules)).toEqual([])
  })
})
