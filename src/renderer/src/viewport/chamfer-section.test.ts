// The chamfer section's primitives (v0.4 task U4, D45): true proportions, the cone from the chamfer
// Ø at the face to the edge Ø at the cone depth, how the bore ends (through, floor, cut short: the
// stock fades out instead of a break line), a cone cut at a shallow floor, one measured part per
// field (width, depth, angle, diameter, edge), invalid parts and the label. E3: the wall section of
// a general edge (one wall and its bevel, no diameter).
// Doc: docs/conventions/ui.md#section-illustration
import { describe, expect, it } from 'vitest'
import { chamferSection, coneDepth, wallChamferSection } from './chamfer-section'
import type { SketchPrimitive } from './sketch'

const base = {
  width: 0.5,
  diameter: 4.4,
  angle: 90,
  edgeDiameter: 3.4,
  edgeDepth: 2.5,
  through: true,
  edgeName: 'Drilling 1',
}

const fades = (p: readonly SketchPrimitive[]) =>
  p.filter((x): x is Extract<SketchPrimitive, { kind: 'fade' }> => x.kind === 'fade')
const lines = (p: readonly SketchPrimitive[], style: string) =>
  p.filter((x) => x.kind === 'line' && x.style === style)
const measure = (p: readonly SketchPrimitive[], part: string) => {
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
    // the width: the face from the edge to the rim, both sides
    expect(measure(s.primitives, 'width')).toMatchObject({
      value: '0.5 mm',
      paths: [
        [
          [-2.2, 0],
          [-1.7, 0],
        ],
        [
          [1.7, 0],
          [2.2, 0],
        ],
      ],
    })
    expect(measure(s.primitives, 'edgeOf').value).toBe('Ø 3.4 mm')
    // a 2.5 mm through hole is drawn to the far face: no break line, no fade
    expect(lines(s.primitives, 'break')).toHaveLength(0)
    expect(fades(s.primitives)).toHaveLength(0)
    expect(s.bounds.maxY).toBeGreaterThan(2.5)
    expect(s.label).toBe(
      'Section: chamfer 0.5 mm wide at 90° (Ø 4.4 mm), 0.5 mm deep, on Drilling 1 Ø 3.4 mm through.',
    )
  })

  it('a deep bore fades out below the cone; a blind one shows its floor and fades out below', () => {
    const deep = chamferSection({ ...base, edgeDepth: 40 }, 'mm')
    expect(lines(deep.primitives, 'break')).toHaveLength(0)
    expect(deep.bounds.maxY).toBeLessThan(10)
    const [fade] = fades(deep.primitives)
    // across the drawing, below the cone (0.5 mm), opaque where the drawing stops
    expect(fade).toMatchObject({ x0: deep.bounds.minX, x1: deep.bounds.maxX })
    expect(fade!.from).toBeGreaterThan(0.5)
    expect(fade!.to).toBeGreaterThan(fade!.from)
    const blind = chamferSection({ ...base, edgeDepth: 1.5, through: false }, 'inch')
    expect(lines(blind.primitives, 'break')).toHaveLength(0)
    expect(fades(blind.primitives)).toHaveLength(1)
    // the floor stays crisp: the fade starts below it
    expect(fades(blind.primitives)[0]!.from).toBeGreaterThan(1.5)
    expect(blind.primitives.filter((p) => p.kind === 'material')).toHaveLength(3)
    expect(blind.label).toContain('0.059" deep.')
  })

  it('cuts a cone that reaches the floor there, and marks invalid parts', () => {
    const s = chamferSection(
      {
        ...base,
        width: 2.3,
        diameter: 8,
        edgeDepth: 1,
        through: false,
        invalid: new Set(['width']),
      },
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
    expect(measure(s.primitives, 'width').invalid).toBe(true)
    expect(measure(s.primitives, 'angle').invalid).toBeUndefined()
  })

  it('is one uniform scale: a wider angle gives a shallower cone', () => {
    expect(coneDepth({ ...base, angle: 120 })).toBeLessThan(coneDepth({ ...base, angle: 60 }))
  })
})

describe('wallChamferSection (edge chamfers E3)', () => {
  const wall = {
    width: 1.5,
    angle: 90,
    edgeDepth: 40,
    through: true,
    edgeName: 'Profile 1',
    side: 'outside' as const,
  }

  it('draws one wall with its bevel: width, depth, angle, edge; no diameter', () => {
    const s = wallChamferSection(wall, 'mm')
    expect(measure(s.primitives, 'width').paths).toEqual([
      [
        [0, 0],
        [1.5, 0],
      ],
    ])
    expect(measure(s.primitives, 'angle').paths[0]).toEqual([
      [1.5, 0],
      [0, expect.closeTo(1.5)],
    ])
    expect(measure(s.primitives, 'depth').value).toBe('1.5 mm')
    expect(measure(s.primitives, 'edgeOf').value).toBe('Profile 1')
    expect(s.primitives.some((p) => p.kind === 'measure' && p.part === 'diameter')).toBe(false)
    // a 40 mm wall is cut short and fades out below the bevel
    expect(fades(s.primitives)).toHaveLength(1)
    expect(s.bounds.maxY).toBeLessThan(10)
    expect(s.label).toBe(
      'Section: chamfer 1.5 mm wide at 90°, 1.5 mm deep, along the outline of Profile 1, through.',
    )
  })

  it('a bevel deeper than a blind pocket is cut at its floor; invalid parts', () => {
    const s = wallChamferSection(
      {
        ...wall,
        width: 2,
        edgeDepth: 1,
        through: false,
        side: 'inside',
        edgeName: 'Pocket 1',
        invalid: new Set(['width']),
      },
      'mm',
    )
    expect(measure(s.primitives, 'angle').paths[0]).toEqual([
      [2, 0],
      [expect.closeTo(1), 1],
    ])
    expect(measure(s.primitives, 'edgeOf').paths[0]![1]).toEqual([expect.closeTo(1), 1])
    expect(measure(s.primitives, 'width').invalid).toBe(true)
    expect(s.primitives.filter((p) => p.kind === 'material')).toHaveLength(2)
    expect(s.label).toContain('along the wall of Pocket 1, 1 mm deep.')
  })
})
