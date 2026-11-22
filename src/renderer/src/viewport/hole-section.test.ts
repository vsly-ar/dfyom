// holeSection (v0.4 U2): true proportions, through vs blind (break line), counterbore step,
// countersink cone, drill point, the screw silhouette and its head sink, measured parts per field,
// invalid parts, and the accessible label. Doc: docs/conventions/ui.md#section-illustration
import { describe, expect, it } from 'vitest'
import { holeSection, sketchLength, type HoleSectionValues } from './hole-section'
import { fitSketch, sketchPath, type SketchPrimitive } from './sketch'

const M3 = {
  size: 'M3',
  nominal: 3,
  socketHead: { diameter: 5.5, height: 3 },
  countersunkHead: { diameter: 6.72, angle: 90 },
}

const base: HoleSectionValues = {
  type: 'simple',
  purpose: 'clearance',
  diameter: 3.4,
  bottom: 'through',
  headSink: 0.2,
  stockDepth: 10,
}

const measures = (prims: readonly SketchPrimitive[]) =>
  prims.filter((p): p is Extract<SketchPrimitive, { kind: 'measure' }> => p.kind === 'measure')
const measure = (prims: readonly SketchPrimitive[], part: string) =>
  measures(prims).find((p) => p.part === part)
const lines = (prims: readonly SketchPrimitive[], style: string) =>
  prims.filter(
    (p): p is Extract<SketchPrimitive, { kind: 'line' }> => p.kind === 'line' && p.style === style,
  )

describe('holeSection', () => {
  it('draws a through hole to the stock bottom at true proportions, in two material pieces', () => {
    const s = holeSection(base, 'mm')
    expect(s.bounds.maxY).toBe(10)
    expect(s.bounds.minY).toBe(0)
    expect(s.primitives.filter((p) => p.kind === 'material')).toHaveLength(2)
    expect(lines(s.primitives, 'break')).toHaveLength(0)
    // the bore wall runs from the face to the bottom at r = 1.7
    const wall = lines(s.primitives, 'edge')[0]!
    expect(wall.points).toEqual([
      [1.7, 0],
      [1.7, 10],
    ])
    expect(measures(s.primitives).map((p) => p.part)).toEqual(['diameter'])
    expect(measure(s.primitives, 'diameter')!.value).toBe('Ø 3.4 mm')
    expect(s.label).toBe('Section: Ø 3.4 mm through.')
  })

  it('cuts a blind hole by a break line under its drill point', () => {
    const s = holeSection({ ...base, bottom: 'drillPoint', depth: 4, stockDepth: 40 }, 'mm')
    expect(s.primitives.filter((p) => p.kind === 'material')).toHaveLength(1)
    expect(lines(s.primitives, 'break')).toHaveLength(1)
    const tip = 1.7 / Math.tan((59 * Math.PI) / 180)
    const profile = lines(s.primitives, 'edge')[0]!.points
    expect(profile).toContainEqual([0, 4 + tip])
    expect(s.bounds.maxY).toBeGreaterThan(4 + tip)
    expect(s.bounds.maxY).toBeLessThan(40)
    expect(measure(s.primitives, 'depth')!.value).toBe('4 mm')
    expect(s.label).toBe('Section: Ø 3.4 mm, 4 mm deep, drill point.')
  })

  it('ends a blind hole at the stock bottom when it is that close', () => {
    const s = holeSection({ ...base, bottom: 'flat', depth: 8, stockDepth: 10 }, 'mm')
    expect(lines(s.primitives, 'break')).toHaveLength(0)
    expect(s.bounds.maxY).toBe(10)
  })

  it('draws the counterbore step, its two measured parts and the seated socket head', () => {
    const s = holeSection(
      { ...base, type: 'counterbore', cbDiameter: 6.5, cbDepth: 3.2, fastener: M3 },
      'mm',
    )
    const wall = lines(s.primitives, 'edge')[0]!.points
    expect(wall.slice(0, 3)).toEqual([
      [3.25, 0],
      [3.25, 3.2],
      [1.7, 3.2],
    ])
    expect(measures(s.primitives).map((p) => p.part)).toEqual([
      'diameter',
      'cbDiameter',
      'cbDepth',
      'headSink',
    ])
    // the head (k = 3) sits on the counterbore floor: its top 0.2 mm below the face
    expect(measure(s.primitives, 'headSink')!.value).toBe('0.2 mm')
    const silhouette = lines(s.primitives, 'silhouette')
    expect(silhouette).toHaveLength(2)
    expect(silhouette[0]!.points[0]![1]).toBeCloseTo(0.2)
    expect(s.label).toBe(
      'Section: Ø 3.4 mm through; counterbore Ø 6.5 mm, 3.2 mm deep; M3 head 0.2 mm below the face.',
    )
  })

  it('says a too shallow counterbore leaves the head above the face', () => {
    const s = holeSection(
      { ...base, type: 'counterbore', cbDiameter: 6.5, cbDepth: 2, fastener: M3 },
      'mm',
    )
    expect(measure(s.primitives, 'headSink')).toBeUndefined()
    expect(s.bounds.minY).toBeCloseTo(-1)
    expect(s.label).toMatch(/M3 head 1 mm above the face\.$/)
  })

  it('draws the countersink cone at its angle with the countersunk head in it', () => {
    const s = holeSection(
      { ...base, type: 'countersink', csDiameter: 7.12, csAngle: 90, fastener: M3 },
      'mm',
    )
    const wall = lines(s.primitives, 'edge')[0]!.points
    // 90°: the cone is as deep as it is wide per side
    expect(wall[0]).toEqual([3.56, 0])
    expect(wall[1]![0]).toBe(1.7)
    expect(wall[1]![1]).toBeCloseTo(3.56 - 1.7)
    expect(measure(s.primitives, 'csAngle')!.paths).toHaveLength(2)
    expect(measure(s.primitives, 'csAngle')!.value).toBe('90°')
    // head top where the cone is 6.72 wide: (7.12 − 6.72) / 2 = 0.2 below the face
    expect(measure(s.primitives, 'headSink')!.value).toBe('0.2 mm')
    expect(s.label).toBe(
      'Section: Ø 3.4 mm through; countersink Ø 7.12 mm, 90°; M3 head 0.2 mm below the face.',
    )
  })

  it('shows only the thread for a tap drill and puts a simple clearance head on the face', () => {
    const tap = holeSection({ ...base, purpose: 'tapDrill', diameter: 2.5, fastener: M3 }, 'mm')
    expect(lines(tap.primitives, 'silhouette')).toHaveLength(1)
    expect(tap.label).toBe('Section: Ø 2.5 mm through; M3 tap drill.')
    const simple = holeSection({ ...base, fastener: M3 }, 'mm')
    expect(simple.bounds.minY).toBe(-3)
    expect(simple.label).toMatch(/M3 head on the face\.$/)
  })

  it('marks invalid parts and formats inch values', () => {
    const s = holeSection(
      { ...base, type: 'counterbore', cbDiameter: 6.35, cbDepth: 3.175, invalid: ['cbDepth'] },
      'inch',
    )
    expect(measure(s.primitives, 'cbDepth')!.invalid).toBe(true)
    expect(measure(s.primitives, 'cbDiameter')!.invalid).toBeUndefined()
    expect(measure(s.primitives, 'cbDepth')!.value).toBe('0.125"')
    expect(sketchLength(25.4, 'inch')).toBe('1"')
    expect(sketchLength(3.4, 'mm')).toBe('3.4 mm')
  })
})

describe('sketch fit', () => {
  it('fits the bounds with one uniform scale, centred', () => {
    const fit = fitSketch({ minX: -10, minY: 0, maxX: 10, maxY: 10 }, 220, 120, 10)
    expect(fit.scale).toBe(10)
    expect(fit.ox).toBe(110)
    expect(fit.oy).toBe(10)
    expect(
      sketchPath(fit, [
        [0, 0],
        [10, 10],
      ]),
    ).toBe('M110 10L210 110')
  })
})
