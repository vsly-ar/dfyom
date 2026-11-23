// The reference view model: the ghost matrix uses R2's placed-box convention, placement from the
// stored quantities, live warnings. Spec: docs/modes/reference-model.md#placement-math-task-r2
import { describe, expect, it } from 'vitest'
import { placedBox, type Placement } from '../../../../core/design/reference'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { Box } from '../../../../core/design/stl'
import { fieldContext } from '../../../../core/design/operation'
import { Quantity } from '../../../../core/quantity/quantity'
import {
  fitPreview,
  ghostMatrix,
  lengthSource,
  liveWarnings,
  middleDepth,
  referencePlacement,
  scaleAbout,
  sectionMatrix,
  sizeText,
  sourceSize,
} from './reference-view'

const bounds: Box = { min: { x: -1, y: 2, z: 0.5 }, max: { x: 3, y: 4, z: 1.5 } }

/** Applies a column-major 4 × 4 matrix to a point. */
const apply = (m: number[], [x, y, z]: number[]) =>
  [0, 1, 2].map((r) => m[r]! * x! + m[4 + r]! * y! + m[8 + r]! * z! + m[12 + r]!)

function transformedBox(m: number[], b: Box) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y])
      for (const z of [b.min.z, b.max.z]) {
        const p = apply(m, [x, y, z])
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i]!, p[i]!)
          hi[i] = Math.max(hi[i]!, p[i]!)
        }
      }
  return { lo, hi }
}

const placement = (over: Partial<Placement>): Placement => ({
  sourceUnit: 'mm',
  scale: 1,
  rotation: { x: 0, y: 0, z: 0 },
  position: { x: 10, y: 20, z: -5 },
  ...over,
})

describe('ghostMatrix', () => {
  it('puts the placed box where core says, for quarter turns, scale and inch', () => {
    for (const p of [
      placement({}),
      placement({ rotation: { x: 90, y: 0, z: 0 } }),
      placement({ rotation: { x: 0, y: -90, z: 180 }, scale: 2 }),
      placement({ rotation: { x: 270, y: 90, z: 90 }, sourceUnit: 'inch' }),
    ]) {
      const want = placedBox(bounds, p)
      const { lo, hi } = transformedBox(ghostMatrix(bounds, p), bounds)
      expect(lo[0]).toBeCloseTo(want.min.x, 9)
      expect(lo[1]).toBeCloseTo(want.min.y, 9)
      expect(lo[2]).toBeCloseTo(want.min.z, 9)
      expect(hi[0]).toBeCloseTo(want.max.x, 9)
      expect(hi[1]).toBeCloseTo(want.max.y, 9)
      expect(hi[2]).toBeCloseTo(want.max.z, 9)
    }
  })

  it('for free angles keeps the min corner of the rotated source corners on position', () => {
    const p = placement({ rotation: { x: 0, y: 0, z: 30 } })
    const { lo } = transformedBox(ghostMatrix(bounds, p), bounds)
    expect(lo).toEqual([expect.closeTo(10, 9), expect.closeTo(20, 9), expect.closeTo(-5, 9)])
  })

  it('a quarter turn about Z maps +X onto +Y (right-handed, x then y then z)', () => {
    const m = ghostMatrix(bounds, placement({ rotation: { x: 0, y: 0, z: 90 } }))
    expect([m[0], m[1], m[2]]).toEqual([0, 1, 0])
  })
})

const q = (source: string, kind: 'length' | 'angle' | 'scalar') =>
  Quantity.parse(source, fieldContext(kind, 'mm')).unwrap().toDTO()

function record(position = ['10 mm', '20 mm', '-5 mm']): ReferenceDTO {
  return {
    id: 'reference-1',
    partId: 'part-1',
    name: 'box',
    asset: {
      path: `assets/${'a'.repeat(64)}.stl`,
      sha256: 'a'.repeat(64),
      format: 'stl',
      triangles: 12,
      bounds,
    },
    sourceUnit: 'mm',
    scale: q('1', 'scalar'),
    rotation: { x: q('0°', 'angle'), y: q('90°', 'angle'), z: q('0°', 'angle') },
    position: {
      x: q(position[0]!, 'length'),
      y: q(position[1]!, 'length'),
      z: q(position[2]!, 'length'),
    },
  } as ReferenceDTO
}

describe('reference view model', () => {
  it('reads the placement from the stored quantities', () => {
    expect(referencePlacement(record())).toEqual(placement({ rotation: { x: 0, y: 90, z: 0 } }))
  })

  it('warns live when the placed box leaves the stock', () => {
    const stock = { length: 100, width: 60, thickness: 20 }
    expect(liveWarnings(record(), stock)).toEqual([])
    // turned 90° about Y the box is 1 × 2 × 4: from X 99.5 it sticks out by 0.5
    const out = liveWarnings(record(['99.5 mm', '20 mm', '-5 mm']), stock)
    expect(out[0]).toMatchObject({ code: 'reference.exceedsStock', params: { x: 0.5 } })
  })

  it('names the source size', () => {
    expect(sourceSize(bounds)).toBe('4 × 2 × 1')
  })
})

describe('reference section (U3)', () => {
  it('maps source points into the face frame through the ghost matrix', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 5 } }
    const p = {
      sourceUnit: 'mm' as const,
      scale: 1,
      rotation: { x: 0, y: 0, z: 0 },
      position: { x: 5, y: 5, z: -5 },
    }
    const ghost = ghostMatrix(bounds, p)
    // the bottom face's frame: u = +x, v = −y, n = −z, origin at (0, 30, −5)
    const frame = {
      origin: [0, 30, -5] as const,
      u: [1, 0, 0] as const,
      v: [0, -1, 0] as const,
      n: [0, 0, -1] as const,
    }
    const m = sectionMatrix(ghost, frame)
    const apply = (x: number, y: number, z: number) =>
      [0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!)
    // source (0, 0, 0) → part (5, 5, −5) → face (5, 25, 0)
    expect(apply(0, 0, 0).map((v) => +v.toFixed(9))).toEqual([5, 25, 0])
    // source (0, 0, 5) → part (5, 5, 0) → face w = −5
    expect(apply(0, 0, 5)[2]).toBeCloseTo(-5)
  })

  it('cuts at the middle of the placed box, never above the face', () => {
    const frame = {
      origin: [0, 0, 0] as const,
      u: [1, 0, 0] as const,
      v: [0, 1, 0] as const,
      n: [0, 0, 1] as const,
    }
    const box = { min: { x: 0, y: 0, z: -39 }, max: { x: 10, y: 10, z: 0 } }
    expect(middleDepth(box, frame, 0)).toBeCloseTo(19.5)
    expect(middleDepth(box, frame, -5)).toBeCloseTo(14.5)
    expect(middleDepth({ min: { x: 0, y: 0, z: 2 }, max: { x: 1, y: 1, z: 6 } }, frame, 0)).toBe(0)
  })
})

describe('Reference panel helpers (DF5–DF7)', () => {
  const box: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 5 } }
  const stock = { length: 100, width: 60, thickness: 20 }
  const p: Placement = {
    sourceUnit: 'mm',
    scale: 1,
    rotation: { x: 0, y: 0, z: 0 },
    position: { x: 40, y: 25, z: -5 },
  }

  it('fitPreview scales (rounded down) and places as the command does', () => {
    const fit = { anchor: {}, z: 'top' as const, margin: 0, scaleTo: ['x', 'y'] as const }
    expect(fitPreview(box, p, stock, fit)).toEqual({
      ok: true,
      placement: { ...p, scale: 5, position: { x: 0, y: 5, z: -25 } },
    })
    expect(fitPreview(box, p, stock, { ...fit, scaleTo: null, margin: 5 })).toEqual({
      ok: true,
      placement: { ...p, position: { x: 40, y: 25, z: -5 } },
    })
    expect(fitPreview(box, p, stock, { ...fit, margin: 30 })).toEqual({
      ok: false,
      problem: 'marginTooLarge',
    })
    const third = fitPreview(box, p, { ...stock, length: 20 / 3 }, { ...fit, scaleTo: ['x'] })
    expect(third.ok && third.placement.scale).toBe(0.333333)
  })

  it('scaleAbout keeps the anchor point in X/Y and the top in Z', () => {
    expect(scaleAbout(box, p, 2, {})).toEqual({ x: 30, y: 20, z: -10 })
    expect(scaleAbout(box, p, 2, { u: 'min', v: 'max' })).toEqual({ x: 40, y: 15, z: -10 })
    expect(scaleAbout(box, p, 0.5, { u: 'max', v: 'min' })).toEqual({ x: 50, y: 25, z: -2.5 })
  })

  it('sizeText and lengthSource write project units', () => {
    expect(sizeText({ x: 249.5, y: 177.12, z: 39 }, 'mm')).toBe('249.5 × 177.1 × 39 mm')
    expect(sizeText({ x: 25.4, y: 50.8, z: 12.7 }, 'inch')).toBe('1 × 2 × 0.5 in')
    expect(lengthSource(41.46971, 'mm')).toBe('41.4697 mm')
    expect(lengthSource(-0.00001, 'mm')).toBe('0 mm')
    expect(lengthSource(25.4, 'inch')).toBe('1"')
  })
})
