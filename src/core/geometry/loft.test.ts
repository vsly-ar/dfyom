import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import type { ContourLabel } from './contour'
import { offsetBand, offsetLoft, type LoftLabels } from './loft'
import { CHORD_TOLERANCE, type Contour, type Level } from './model'
import { circlePocketVolume, drillVolume, pocketVolume } from './testing/analytic'
import { faceCounts, openEdges, roundedRectArea, signedVolume } from './testing/mesh-oracles'

const AIR = 0
const TOP = 1
const BOTTOM = 2
const FILLET = 3
/** wall[i] → 10 + i, corner[i] → 20 + i */
const byRole = (l: ContourLabel): number => (l.role === 'wall' ? 10 : 20) + l.index

/** Pocket-like labels: first band = walls/corners, later bands = fillet. */
const pocketLabels: LoftLabels = {
  band: (k, l) => (k === 0 ? byRole(l) : FILLET),
  top: AIR,
  bottom: BOTTOM,
}

/** Upper bound of the volume inscribed chords may lose: perimeter × tolerance × height. */
const chordLoss = (perimeter: number, height: number): number =>
  perimeter * CHORD_TOLERANCE * height

const rect = (
  length: number,
  width: number,
  cornerRadius: number,
): Extract<Contour, { kind: 'rectangle' }> => ({
  kind: 'rectangle',
  length,
  width,
  cornerRadius,
})

function filletLevels(top: number, zf: number, f: number, n: number): Level[] {
  const levels: Level[] = [{ offset: 0, z: top }]
  if (f === 0) return [...levels, { offset: 0, z: zf }]
  levels.push({ offset: 0, z: zf + f })
  for (let k = 1; k <= n; k++) {
    const phi = (k * Math.PI) / (2 * n)
    levels.push({ offset: f * (1 - Math.cos(phi)), z: zf + f * (1 - Math.sin(phi)) })
  }
  return levels
}

describe('offsetLoft', () => {
  it('builds a closed prism labelled by contour element', () => {
    const mesh = expectOk(
      offsetLoft(
        rect(40, 25, 4),
        [
          { offset: 0, z: 1 },
          { offset: 0, z: -8 },
        ],
        { band: (_k, l) => byRole(l), top: TOP, bottom: BOTTOM },
      ),
    )
    expect(openEdges(mesh)).toBe(0)
    const exact = roundedRectArea(40, 25, 4) * 9
    const v = signedVolume(mesh)
    expect(v).toBeLessThanOrEqual(exact)
    // inscribed chords lose at most perimeter × tolerance of area
    expect(v).toBeGreaterThan(exact - chordLoss(130, 9))
    const faces = faceCounts(mesh)
    for (const f of [TOP, BOTTOM, 10, 11, 12, 13, 20, 21, 22, 23])
      expect(faces.get(f)).toBeGreaterThan(0)
  })

  it('keeps more volume with circumscribed arcs', () => {
    const levels = [
      { offset: 0, z: 0 },
      { offset: 0, z: -10 },
    ]
    const labels = { band: () => 10, top: TOP, bottom: BOTTOM }
    const mesh = expectOk(offsetLoft(rect(84, 44, 5), levels, labels, 'circumscribed'))
    const exact = roundedRectArea(84, 44, 5) * 10
    expect(openEdges(mesh)).toBe(0)
    expect(signedVolume(mesh)).toBeGreaterThanOrEqual(exact)
    expect(signedVolume(mesh)).toBeLessThan(exact * 1.0005)
  })

  it('builds a pocket with a floor fillet within the chord tolerance of its volume', () => {
    const mesh = expectOk(offsetLoft(rect(40, 25, 4), filletLevels(1, -8, 2, 8), pocketLabels))
    expect(openEdges(mesh)).toBe(0)
    const exact = pocketVolume(40, 25, 4, 9, 2)
    const v = signedVolume(mesh)
    expect(v).toBeLessThanOrEqual(exact)
    expect(v).toBeGreaterThan(exact - chordLoss(130, 9))
    expect(faceCounts(mesh).get(FILLET)).toBeGreaterThan(0)
  })

  it('collapses corners when floorRadius = cornerRadius, and builds sharp corners as fans', () => {
    for (const [c, f] of [
      [rect(40, 25, 4), 4],
      [rect(40, 25, 12.5), 5],
      [rect(40, 25, 0), 0],
    ] as const) {
      const mesh = expectOk(offsetLoft(c, filletLevels(1, -8, f, 12), pocketLabels))
      expect(openEdges(mesh)).toBe(0)
      const exact = pocketVolume(c.length, c.width, c.cornerRadius, 9, f)
      expect(signedVolume(mesh)).toBeLessThanOrEqual(exact + 1e-9)
      expect(signedVolume(mesh)).toBeGreaterThan(exact - chordLoss(130, 9))
      if (c.cornerRadius === 0)
        for (const f of [20, 21, 22, 23]) expect(faceCounts(mesh).get(f)).toBeUndefined()
    }
  })

  it('builds a circular pocket with floorRadius = depth', () => {
    const mesh = expectOk(
      offsetLoft({ kind: 'circle', radius: 10 }, filletLevels(0, -5, 5, 20), pocketLabels),
    )
    expect(openEdges(mesh)).toBe(0)
    const exact = circlePocketVolume(10, 5, 5)
    expect(signedVolume(mesh)).toBeLessThanOrEqual(exact)
    expect(signedVolume(mesh)).toBeGreaterThan(exact - chordLoss(2 * Math.PI * 10, 5))
  })

  it('closes a drill point with a fan, and a 180° point flat', () => {
    const circle: Contour = { kind: 'circle', radius: 3 }
    for (const angle of [118, 180]) {
      const tip = -12 - 3 / Math.tan(((angle / 2) * Math.PI) / 180)
      const mesh = expectOk(
        offsetLoft(
          circle,
          [
            { offset: 0, z: 1 },
            { offset: 0, z: -12 },
            { offset: 3, z: tip },
          ],
          { band: (k) => (k === 0 ? 10 : BOTTOM), top: AIR, bottom: BOTTOM },
        ),
      )
      expect(openEdges(mesh)).toBe(0)
      const exact = drillVolume(6, 13, angle)
      expect(signedVolume(mesh)).toBeLessThanOrEqual(exact)
      expect(signedVolume(mesh)).toBeGreaterThan(exact - chordLoss(6 * Math.PI, 14))
    }
  })

  it('rejects an offset larger than a contour radius (loftInvalid)', () => {
    const e = expectErrCode(
      offsetLoft(rect(40, 25, 1), filletLevels(1, -8, 2, 4), pocketLabels),
      'geometry.evaluation',
    )
    expect(e.issues[0]?.rule).toBe('loftInvalid')
    expectErrCode(
      offsetLoft(
        rect(40, 25, 4),
        [
          { offset: 0, z: -8 },
          { offset: 0, z: 1 },
        ],
        pocketLabels,
      ),
      'geometry.evaluation',
    )
  })
})

describe('offsetBand', () => {
  const labels = { top: TOP, bottom: BOTTOM, side: AIR, end: [5, 6] as const }

  it('builds a closed tab band across a slot on a straight wall', () => {
    const mesh = expectOk(
      offsetBand(
        rect(84, 44, 5),
        { from: 33, to: 41, inner: 1, outer: -7, bottom: -22, top: -17 },
        labels,
      ),
    )
    expect(openEdges(mesh)).toBe(0)
    expect(signedVolume(mesh)).toBeCloseTo(8 * 8 * 5, 9)
    const faces = faceCounts(mesh)
    expect(faces.get(TOP)).toBe(2)
    expect(faces.get(5)).toBe(2)
    expect(faces.get(6)).toBe(2)
    expect(faces.get(AIR)).toBe(4)
  })

  it('follows a sharp corner (fan on the inner side) and wraps past the start', () => {
    const ranges: [number, number][] = [
      [70, 80],
      [-4, 4],
    ]
    for (const [from, to] of ranges) {
      const mesh = expectOk(
        offsetBand(
          rect(84, 44, 0),
          { from, to, inner: 1, outer: -7, bottom: -22, top: -17 },
          labels,
        ),
      )
      expect(openEdges(mesh)).toBe(0)
      expect(signedVolume(mesh)).toBeGreaterThan(0)
    }
  })
})
