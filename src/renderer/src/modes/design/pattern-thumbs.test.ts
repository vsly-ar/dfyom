// The Presets menu's thumbnails (design review U9 P5): a window onto each preset's lattice.
import { describe, expect, it } from 'vitest'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { cellPoints, presetRings, presetThumb, PREVIEW, THUMB } from './pattern-thumbs'

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

  it("DF107: at the dialog's PREVIEW size every preset shows more cells, about its box", () => {
    for (const p of PATTERN_PRESETS) {
      const cells = presetThumb(p, PREVIEW)
      expect(cells.length).toBeGreaterThan(presetThumb(p).length)
      for (const c of cells) {
        const [x, y] = centre(c)
        expect(x).toBeGreaterThan(-PREVIEW.w / 2)
        expect(x).toBeLessThan(1.5 * PREVIEW.w)
        expect(y).toBeGreaterThan(-PREVIEW.h / 2)
        expect(y).toBeLessThan(1.5 * PREVIEW.h)
      }
      expect(width(cells[0]!)).toBeGreaterThan(6)
    }
  })

  it('DF107: a polar preset is a centre cell and rings an equal step apart', () => {
    const cells = presetThumb(preset('speakerGrille'), PREVIEW)
    const [cx, cy] = centre(cells[0]!)
    expect(cx).toBeCloseTo(PREVIEW.w / 2)
    expect(cy).toBeCloseTo(PREVIEW.h / 2)
    const radii = cells.map((c) => {
      const [x, y] = centre(c)
      return Math.hypot(x! - cx!, y! - cy!)
    })
    const rings = [...new Set(radii.map((r) => Math.round(r * 10) / 10))].sort((a, b) => a - b)
    expect(rings.length).toBeGreaterThanOrEqual(3)
    expect(rings[2]! - rings[1]!).toBeCloseTo(rings[1]! - rings[0]!, 0)
  })

  it("P10: polar rings hold the layout's counts (⌊π / asin(1 / 2k)⌋), not a hex grid's 6k", () => {
    const grille = preset('speakerGrille')
    const cells = presetThumb(grille, PREVIEW)
    const [cx, cy] = centre(cells[0]!)
    const step = presetRings(grille, PREVIEW)[0]!.r
    const perRing = new Map<number, number>()
    for (const c of cells) {
      const [x, y] = centre(c)
      const k = Math.round(Math.hypot(x! - cx!, y! - cy!) / step)
      perRing.set(k, (perRing.get(k) ?? 0) + 1)
    }
    // rings 1–3 lie wholly inside the window (about 3.8 rings from the centre to its top edge)
    for (const k of [1, 2, 3])
      expect(perRing.get(k)).toBe(Math.floor(Math.PI / Math.asin(1 / (2 * k)) + 1e-9))
    // ring 4 has 25 cells in the layout, 24 under the old 6k rule; part of it is cut by the box
    expect(Math.floor(Math.PI / Math.asin(1 / 8) + 1e-9)).toBe(25)
  })

  it('P10: ring guides through each ring of a polar preset, about the box centre; none for rows', () => {
    const rings = presetRings(preset('speakerGrille'), PREVIEW)
    expect(rings.length).toBeGreaterThanOrEqual(3)
    for (const [i, g] of rings.entries()) {
      expect(g.cx).toBeCloseTo(PREVIEW.w / 2)
      expect(g.cy).toBeCloseTo(PREVIEW.h / 2)
      expect(g.r).toBeCloseTo(rings[0]!.r * (i + 1))
    }
    expect(presetRings(preset('honeycomb'), PREVIEW)).toEqual([])
  })
})
