// The Presets menu's thumbnails (design review U9 P5): a few cells per preset in its lattice.
import { describe, expect, it } from 'vitest'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { cellPoints, presetLoops } from './pattern-thumbs'

const preset = (id: string) => PATTERN_PRESETS.find((p) => p.id === id)!
const centre = (l: ReturnType<typeof presetLoops>[number]) => {
  const xs = l.elements.map((e) => e.a[0])
  const ys = l.elements.map((e) => e.a[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

describe('preset thumbnails (U9 P5)', () => {
  it('every preset: six closed cells', () => {
    for (const p of PATTERN_PRESETS) {
      const loops = presetLoops(p)
      expect(loops).toHaveLength(6)
      for (const l of loops) {
        expect(l.closed).toBe(true)
        expect(l.elements.length).toBeGreaterThanOrEqual(4)
      }
    }
  })

  it('square rows line up; staggered rows shift by half a pitch', () => {
    const square = presetLoops(preset('roundedSquares')).map(centre)
    expect(square[3]![0]).toBeCloseTo(square[0]![0]!)
    const staggered = presetLoops(preset('staggeredHoles')).map(centre)
    // Ø 6, gap 3: pitch 9, the second row 4.5 to the right
    expect(staggered[1]![0]! - staggered[0]![0]!).toBeCloseTo(9, 0)
    expect(staggered[3]![0]! - staggered[0]![0]!).toBeCloseTo(4.5, 0)
  })

  it('cells take the preset’s rotation: a diamond is a square at 45°', () => {
    const pts = cellPoints({ kind: 'rectangle', length: '8 mm', width: '8 mm', rotation: '45°' })
    const xs = pts.map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8 * Math.SQRT2, 1)
  })
})
