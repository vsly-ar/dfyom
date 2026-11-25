// The Presets menu's thumbnails (design review U9 P5): a window onto each preset's lattice.
import { describe, expect, it } from 'vitest'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { cellPoints, presetThumb, THUMB } from './pattern-thumbs'

const preset = (id: string) => PATTERN_PRESETS.find((p) => p.id === id)!
const centre = (pts: readonly (readonly [number, number])[]) => {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}
const width = (pts: readonly (readonly [number, number])[]) =>
  Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))

describe('preset thumbnails (U9 P5)', () => {
  it('every preset: several cells meeting the box, each a readable size', () => {
    for (const p of PATTERN_PRESETS) {
      const cells = presetThumb(p)
      expect(cells.length).toBeGreaterThanOrEqual(4)
      for (const c of cells) {
        const [x, y] = centre(c)
        expect(x).toBeGreaterThan(-THUMB.w)
        expect(x).toBeLessThan(2 * THUMB.w)
        expect(y).toBeGreaterThan(-THUMB.h)
        expect(y).toBeLessThan(2 * THUMB.h)
      }
      expect(width(cells[0]!)).toBeGreaterThan(4)
    }
  })

  it('square rows line up; staggered rows shift by half a pitch', () => {
    const rows = (id: string) => {
      const cs = presetThumb(preset(id)).map(centre)
      const ys = [...new Set(cs.map((c) => Math.round(c[1]! * 100)))].sort((a, b) => a - b)
      return ys.map((y) =>
        cs
          .filter((c) => Math.round(c[1]! * 100) === y)
          .map((c) => c[0]!)
          .sort((a, b) => a - b),
      )
    }
    const square = rows('roundedSquares')
    expect(square[1]![0]).toBeCloseTo(square[0]![0]!)
    const staggered = rows('staggeredHoles')
    const pitch = staggered[0]![1]! - staggered[0]![0]!
    expect(Math.abs(staggered[1]![0]! - staggered[0]![0]!)).toBeCloseTo(pitch / 2)
  })

  it('cells take the preset’s rotation: a diamond is a square at 45°', () => {
    const pts = cellPoints({ kind: 'rectangle', length: '8 mm', width: '8 mm', rotation: '45°' })
    const xs = pts.map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8 * Math.SQRT2, 1)
  })
})
