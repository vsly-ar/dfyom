// The run scene's machine travel outline (DF33). Doc: docs/conventions/ui.md#viewport-task-35
import { describe, expect, it } from 'vitest'
import { boxEdges } from './RunLayer'

describe('boxEdges', () => {
  it('gives the 12 edges of the travel box, each axis-aligned and inside it', () => {
    const e = boxEdges([-800, -800, -100], [0, 0, 0])
    expect(e.length).toBe(12 * 2 * 3)
    const lengths: number[] = []
    for (let i = 0; i < e.length; i += 6) {
      const d = [0, 1, 2].map((k) => Math.abs(e[i + 3 + k]! - e[i + k]!))
      // exactly one axis changes along an edge
      expect(d.filter((v) => v > 0)).toHaveLength(1)
      lengths.push(Math.max(...d))
    }
    expect(lengths.sort((a, b) => a - b)).toEqual([100, 100, 100, 100, ...Array(8).fill(800)])
  })
})
