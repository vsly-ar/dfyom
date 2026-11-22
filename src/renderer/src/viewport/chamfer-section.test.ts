// The chamfer section's primitives (v0.4 task U4): true proportions, the cone from the chamfer Ø at
// the face to the edge Ø at the cone depth, how the bore ends (through, floor, cut short by a break),
// a cone cut at a shallow floor, one measured part per field, invalid parts and the label.
// Doc: docs/conventions/ui.md#section-illustration
import { describe, expect, it } from 'vitest'
import { chamferSection, coneDepth, type SectionPrimitive } from './chamfer-section'

const base = {
  diameter: 4.4,
  angle: 90,
  edgeDiameter: 3.4,
  edgeDepth: 2.5,
  through: true,
  edgeName: 'Drilling 1',
}

const lines = (p: readonly SectionPrimitive[], style: string) =>
  p.filter((x) => x.kind === 'line' && x.style === style)
const measure = (p: readonly SectionPrimitive[], part: string) => {
  const m = p.find((x) => x.kind === 'measure' && x.part === part)
  if (m?.kind !== 'measure') throw new Error(`no measure ${part}`)
  return m
}

describe('chamferSection', () => {
  it('draws the cone from the chamfer Ø at the face to the edge Ø at its depth', () => {
    expect(coneDepth(base)).toBeCloseTo(0.5)
    const s = chamferSection(base, 'mm')
    const angle = measure(s.primitives, 'angle')
    expect(angle.paths[1]).toEqual([
      [2.2, 0],
      [1.7, expect.closeTo(0.5)],
    ])
    expect(measure(s.primitives, 'diameter').paths[0]).toEqual([
      [-2.2, 0],
      [2.2, 0],
    ])
    expect(measure(s.primitives, 'depth').value).toBe('0.5 mm')
    expect(measure(s.primitives, 'edgeOf').value).toBe('Ø 3.4 mm')
    // a 2.5 mm through hole is drawn to the far face: no break line
    expect(lines(s.primitives, 'break')).toHaveLength(0)
    expect(s.bounds.maxY).toBeGreaterThan(2.5)
    expect(s.label).toBe(
      'Section: chamfer Ø 4.4 mm at 90°, 0.5 mm deep, on Drilling 1 Ø 3.4 mm through.',
    )
  })

  it('a deep bore is cut short by break lines; a blind one shows its floor and a break below', () => {
    const deep = chamferSection({ ...base, edgeDepth: 40 }, 'mm')
    expect(lines(deep.primitives, 'break')).toHaveLength(2)
    expect(deep.bounds.maxY).toBeLessThan(10)
    const blind = chamferSection({ ...base, edgeDepth: 1.5, through: false }, 'inch')
    expect(lines(blind.primitives, 'break')).toHaveLength(1)
    expect(blind.primitives.filter((p) => p.kind === 'material')).toHaveLength(3)
    expect(blind.label).toContain('0.059" deep.')
  })

  it('cuts a cone that reaches the floor there, and marks invalid parts', () => {
    const s = chamferSection(
      { ...base, diameter: 8, edgeDepth: 1, through: false, invalid: new Set(['diameter']) },
      'mm',
    )
    // half-angle 45°: at 1 mm below the face the cone has radius 4 − 1 = 3
    expect(measure(s.primitives, 'angle').paths[1]).toEqual([
      [4, 0],
      [expect.closeTo(3), 1],
    ])
    expect(measure(s.primitives, 'edgeOf').paths).toEqual([
      [
        [expect.closeTo(-3), 1],
        [expect.closeTo(3), 1],
      ],
    ])
    expect(measure(s.primitives, 'diameter').invalid).toBe(true)
    expect(measure(s.primitives, 'angle').invalid).toBeUndefined()
  })

  it('is one uniform scale: a wider angle gives a shallower cone', () => {
    expect(coneDepth({ ...base, angle: 120 })).toBeLessThan(coneDepth({ ...base, angle: 60 }))
  })
})
