// The open toe clamp's front view (design review R12, Q131): true proportions from the item's
// values, one measured part per size the view shows, a refused size marked, a thick stock faded.
// Doc: docs/conventions/ui.md#workholding
import { describe, expect, it } from 'vitest'
import type { SketchPrimitive } from '../../viewport/sketch'
import { clampSection } from './clamp-section'

const measures = (p: readonly SketchPrimitive[]) =>
  p.filter((x): x is Extract<SketchPrimitive, { kind: 'measure' }> => x.kind === 'measure')

describe('clampSection', () => {
  it('draws grip and reach as one chain over the strap and the top beside the heel', () => {
    const s = clampSection({ grip: 10, reach: 50, top: 25, stockThickness: 18 }, 'mm')
    const m = measures(s.primitives)
    expect(m.map((x) => x.part)).toEqual(['grip', 'reach', 'top'])
    const [grip, reach, top] = m
    // grip from the strap end (x = -grip) to the stock edge (x = 0), reach on to the strap end
    expect(grip!.paths[0]).toEqual([
      [-10, expect.any(Number)],
      [0, expect.any(Number)],
    ])
    expect(reach!.paths[0]![1]![0]).toBe(50)
    expect(grip!.paths[0]![0]![1]).toBeLessThan(-25)
    // the top from Z0 (the stock top) up to the strap top
    expect(top!.paths[0]!.map((p) => p[1])).toEqual([0, -25])
    expect(m.map((x) => x.value)).toEqual(['10 mm', '50 mm', '25 mm'])
    expect(s.label).toBe(
      'Front view of the toe clamp: grip 10 mm on the stock, reach 50 mm past the edge, top 25 mm above Z0.',
    )
    // the table under a thin stock, no fade
    expect(s.primitives.some((p) => p.kind === 'fade')).toBe(false)
    expect(s.bounds.maxY).toBe(18)
  })

  it('fades a thick stock out under the clamp instead of drawing it whole', () => {
    const s = clampSection({ grip: 10, reach: 50, top: 25, stockThickness: 200 }, 'mm')
    expect(s.primitives.some((p) => p.kind === 'fade')).toBe(true)
    expect(s.bounds.maxY).toBe(21)
  })

  it('marks a refused size and formats inch projects', () => {
    const s = clampSection(
      { grip: 9.525, reach: 50.8, top: 25.4, stockThickness: 19.05, invalid: ['reach'] },
      'inch',
    )
    const m = measures(s.primitives)
    expect(m.find((x) => x.part === 'reach')?.invalid).toBe(true)
    expect(m.find((x) => x.part === 'grip')?.invalid).toBeUndefined()
    expect(m.map((x) => x.value)).toEqual(['0.375"', '2"', '1"'])
  })

  it('still draws something for a zero or negative size', () => {
    const s = clampSection({ grip: -5, reach: 0, top: 0, stockThickness: 0 }, 'mm')
    expect(measures(s.primitives)).toHaveLength(3)
    expect(s.bounds.maxX).toBeGreaterThan(s.bounds.minX)
    expect(s.bounds.maxY).toBeGreaterThan(s.bounds.minY)
  })
})
