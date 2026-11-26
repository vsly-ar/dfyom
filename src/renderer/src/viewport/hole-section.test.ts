// holeSection (v0.4 U2): true proportions, through vs blind (fading out, D45), counterbore step,
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

const fades = (prims: readonly SketchPrimitive[]) =>
  prims.filter((p): p is Extract<SketchPrimitive, { kind: 'fade' }> => p.kind === 'fade')
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
    expect(fades(s.primitives)).toHaveLength(0)
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

  it("fades the stock out under a blind hole's drill point (no break line, D45)", () => {
    const s = holeSection({ ...base, bottom: 'drillPoint', depth: 4, stockDepth: 40 }, 'mm')
    expect(s.primitives.filter((p) => p.kind === 'material')).toHaveLength(1)
    expect(lines(s.primitives, 'break')).toHaveLength(0)
    const tip = 1.7 / Math.tan((59 * Math.PI) / 180)
    // one fade across the drawing, from below the tip down to the drawn bottom; no bottom line
    const [fade, ...more] = fades(s.primitives)
    expect(more).toHaveLength(0)
    expect(fade).toMatchObject({ x0: s.bounds.minX, x1: s.bounds.maxX, to: s.bounds.maxY })
    expect(fade!.from).toBeGreaterThan(4 + tip)
    expect(fade!.from).toBeLessThan(s.bounds.maxY)
    expect(
      lines(s.primitives, 'edge').some((l) => l.points.every(([, y]) => y === s.bounds.maxY)),
    ).toBe(false)
    // drawn before the measures, so a highlighted part stays on top
    const at = (k: string) => s.primitives.findIndex((p) => p.kind === k)
    expect(at('fade')).toBeLessThan(at('measure'))
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
    expect(fades(s.primitives)).toHaveLength(0)
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

  it('draws a recessed countersink: the recess step, then the cone on its floor (H1)', () => {
    const s = holeSection(
      {
        ...base,
        type: 'recessedCountersink',
        cbDiameter: 8.12,
        cbDepth: 2,
        csDiameter: 7.12,
        csAngle: 90,
        fastener: M3,
      },
      'mm',
    )
    const wall = lines(s.primitives, 'edge')[0]!.points
    expect(wall.slice(0, 3)).toEqual([
      [4.06, 0],
      [4.06, 2],
      [3.56, 2],
    ])
    expect(wall[3]![0]).toBe(1.7)
    expect(wall[3]![1]).toBeCloseTo(2 + 3.56 - 1.7)
    // the cone's rim is measured on the recess floor
    expect(measure(s.primitives, 'csDiameter')!.paths[0]).toEqual([
      [-3.56, 2],
      [3.56, 2],
    ])
    expect(measure(s.primitives, 'cbDiameter')!.value).toBe('Ø 8.12 mm')
    expect(measure(s.primitives, 'headSink')!.value).toBe('2.2 mm')
    expect(s.label).toBe(
      'Section: Ø 3.4 mm through; recess Ø 8.12 mm, 2 mm deep; countersink Ø 7.12 mm, 90°; M3 head 2.2 mm below the face.',
    )
    // as wide as the countersink: no ledge
    const flush = holeSection(
      { ...base, type: 'recessedCountersink', cbDiameter: 7.12, cbDepth: 2, csDiameter: 7.12 },
      'mm',
    )
    expect(lines(flush.primitives, 'edge')[0]!.points.slice(0, 3)).toEqual([
      [3.56, 0],
      [3.56, 2],
      [3.56, 2],
    ])
  })

  it('draws a slotted hole along its slot: walls half the travel out, the travel measured (H3)', () => {
    const v = {
      ...base,
      type: 'recessedCountersink' as const,
      cbDiameter: 8.12,
      cbDepth: 2,
      csDiameter: 7.12,
      csAngle: 90,
      fastener: M3,
    }
    const round = holeSection(v, 'mm')
    const s = holeSection({ ...v, slotLength: 10 }, 'mm')
    // every wall point of the round section, 5 mm further out
    const wall = lines(s.primitives, 'edge')[0]!.points
    const was = lines(round.primitives, 'edge')[0]!.points
    expect(wall).toEqual(was.map(([x, y]) => [x + 5, y]))
    // diameters across the right end, about its centre; the travel between the end centres
    expect(measure(s.primitives, 'diameter')!.paths[0]!.map(([x]) => x)).toEqual([3.3, 6.7])
    expect(measure(s.primitives, 'csDiameter')!.paths[0]).toEqual([
      [5 - 3.56, 2],
      [5 + 3.56, 2],
    ])
    const travel = measure(s.primitives, 'slotLength')!
    expect(travel.value).toBe('10 mm')
    // R15: the dimension line above the face (and the bounds' top), extension lines up from the
    // end centres past it; the chip above the line, centred
    const [left, rightExt, line] = travel.paths
    expect(line!.map(([x]) => x)).toEqual([-5, 5])
    const dimY = line![0]![1]
    expect(dimY).toBeLessThan(0)
    expect(line![1]![1]).toBe(dimY)
    expect(s.bounds.minY).toBeLessThan(dimY)
    expect(left!.map(([x]) => x)).toEqual([-5, -5])
    expect(rightExt!.map(([x]) => x)).toEqual([5, 5])
    expect(left![0]![1]).toBeGreaterThan(0)
    expect(left![1]![1]).toBeLessThan(dimY)
    expect(travel.chip).toEqual([0, dimY])
    expect(travel.side).toBe('above')
    expect(measure(round.primitives, 'slotLength')).toBeUndefined()
    // the screw stays at mid-travel
    expect(lines(s.primitives, 'silhouette')).toEqual(lines(round.primitives, 'silhouette'))
    expect(s.label).toBe(
      'Section along the slot: Ø 3.4 mm through, slotted: 10 mm travel, 13.4 mm overall; recess Ø 8.12 mm, 2 mm deep; countersink Ø 7.12 mm, 90°; M3 head 2.2 mm below the face.',
    )
    expect(holeSection({ ...v, slotLength: 0 }, 'mm')).toEqual(round)
  })

  it('draws a stepped countersink as terraces with each top step corner on the cone (F7)', () => {
    // M3, 1 mm stepdown: cone 1.86 deep → 2 terraces of 0.93, walls at 3.56 and 2.63
    const s = holeSection(
      { ...base, type: 'countersink', csDiameter: 7.12, csAngle: 90, csStepdown: 1, fastener: M3 },
      'mm',
    )
    const wall = lines(s.primitives, 'edge')[0]!.points
    const at = (p: readonly number[]) => p.map((v) => +v.toFixed(9))
    expect(wall.slice(0, 6).map(at)).toEqual([
      [3.56, 0],
      [3.56, 0.93],
      [2.63, 0.93],
      [2.63, 1.86],
      [1.7, 1.86],
      [1.7, 10],
    ])
    // the top corner of each terrace on the cone: depth = (R − r) / tan 45°
    for (const [x, y] of [wall[0]!, wall[2]!]) expect(y).toBeCloseTo(3.56 - x, 9)
    // the angle measures the cone through the corners; the stepdown chip shows the terrace height
    expect(measure(s.primitives, 'csAngle')!.paths[0]).toEqual([
      [3.56, 0],
      [1.7, expect.closeTo(1.86, 9)],
    ])
    expect(measure(s.primitives, 'csStepdown')!.value).toBe('0.93 mm')
    expect(measure(s.primitives, 'headSink')!.value).toBe('0.2 mm')
    expect(s.label).toBe(
      'Section: Ø 3.4 mm through; countersink Ø 7.12 mm, 90°, stepped in 2 steps of 0.93 mm; M3 head 0.2 mm below the face.',
    )
    // an uneven stepdown: ⌈1.86 / 0.8⌉ = 3 equal terraces; one terrace when it covers the cone
    const three = holeSection(
      { ...base, type: 'countersink', csDiameter: 7.12, csStepdown: 0.8 },
      'mm',
    )
    expect(measure(three.primitives, 'csStepdown')!.value).toBe('0.62 mm')
    const one = holeSection({ ...base, type: 'countersink', csDiameter: 7.12, csStepdown: 5 }, 'mm')
    expect(one.label).toContain('stepped in 1 step of 1.86 mm')
    // without a stepdown: the plain cone, no stepdown part
    expect(
      measure(
        holeSection({ ...base, type: 'countersink', csDiameter: 7.12 }, 'mm').primitives,
        'csStepdown',
      ),
    ).toBeUndefined()
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
