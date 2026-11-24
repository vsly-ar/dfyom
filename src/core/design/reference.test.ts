// Reference placement math: unit guess, placed extent, fit, exceedsStock.
// Spec: docs/modes/reference-model.md#source-unit-guess, #fit-to-stock, #placement-math-task-r2
import { describe, expect, it } from 'vitest'
import {
  depthToReference,
  exceedsStock,
  facingDepthSource,
  fitPosition,
  fitScale,
  guessUnit,
  placedBox,
  placedExtent,
  rotationMatrix,
  roundScaleDown,
  suggestFacingDepth,
} from './reference'

const stock = { length: 100, width: 60, thickness: 20 }
const box = (x: number, y: number, z: number) => ({
  min: { x: 0, y: 0, z: 0 },
  max: { x, y, z },
})
const flat = { sourceUnit: 'mm' as const, scale: 1, rotation: { x: 0, y: 0, z: 0 } }

describe('guessUnit', () => {
  it('mm unless the mm reading is under 1/10 of the stock and fits as inch', () => {
    expect(guessUnit(box(80, 50, 15), stock).unit).toBe('mm')
    expect(guessUnit(box(2, 1.5, 0.5), stock)).toEqual({
      unit: 'inch',
      reason: 'Read as inch: 2 × 1.5 × 0.5 in mm would be 50× smaller than the stock',
    })
    // exactly 1/10 is not "under"
    expect(guessUnit(box(10, 1, 0.5), stock).unit).toBe('mm')
  })

  it('stays mm when the inch reading would not fit (orientation-free)', () => {
    // 3 in = 76.2 mm > 60 mm on the second-longest axis
    const g = guessUnit(box(3, 3, 0.5), stock)
    expect(g.unit).toBe('mm')
    expect(g.reason).toMatch(/would not fit/)
    // a tall model fits the stock lying down: sorted extents are compared
    expect(guessUnit(box(0.5, 1, 3), stock).unit).toBe('inch')
  })
})

describe('placement', () => {
  it('90° steps are exact (no drift from repeated quarter turns)', () => {
    expect(rotationMatrix({ x: 90, y: 180, z: -270 })).toEqual(
      rotationMatrix({ x: 450, y: -180, z: 90 }),
    )
    expect(rotationMatrix({ x: 0, y: 0, z: 90 }).map((v) => v + 0)).toEqual([
      0, -1, 0, 1, 0, 0, 0, 0, 1,
    ])
  })

  it('extent: unit and scale multiply; rotation x then y then z about part axes', () => {
    expect(placedExtent(box(2, 1, 0.5), { ...flat, sourceUnit: 'inch', scale: 2 })).toEqual({
      x: 101.6,
      y: 50.8,
      z: 25.4,
    })
    // x 90° then z 90°: Y→Z, then X→Y
    expect(placedExtent(box(20, 10, 5), { ...flat, rotation: { x: 90, y: 0, z: 90 } })).toEqual({
      x: 5,
      y: 20,
      z: 10,
    })
    // free angle: the rotated corner box (conservative)
    const e = placedExtent(box(10, 10, 1), { ...flat, rotation: { x: 0, y: 0, z: 45 } })
    expect(e.x).toBeCloseTo(10 * Math.SQRT2, 9)
  })

  it('fit: 9-point anchor in XY, top / centre / bottom in Z', () => {
    const e = { x: 20, y: 10, z: 5 }
    expect(fitPosition(e, stock, {}, 'top')).toEqual({ x: 40, y: 25, z: -5 })
    expect(fitPosition(e, stock, { u: 'min', v: 'max' }, 'bottom')).toEqual({
      x: 0,
      y: 50,
      z: -20,
    })
    expect(fitPosition(e, stock, { u: 'max', v: 'min' }, 'centre')).toEqual({
      x: 80,
      y: 0,
      z: -12.5,
    })
  })

  it('fitPosition keeps a margin free on each side in X and Y', () => {
    const e = { x: 20, y: 10, z: 5 }
    expect(fitPosition(e, stock, { u: 'min', v: 'max' }, 'top', 5)).toEqual({ x: 5, y: 45, z: -5 })
    expect(fitPosition(e, stock, {}, 'bottom', 5)).toEqual({ x: 40, y: 25, z: -20 })
  })

  it('fitScale: the largest factor fitting the governing axes, margin in X and Y only', () => {
    const e = { x: 20, y: 10, z: 5 }
    expect(fitScale(e, stock, ['x'])).toEqual({ ok: true, scale: 5 })
    expect(fitScale(e, stock, ['x', 'y'], 5)).toEqual({ ok: true, scale: 4.5 })
    expect(fitScale(e, stock, ['x', 'y', 'z'], 5)).toEqual({ ok: true, scale: 4 })
    expect(fitScale(e, stock, ['z'], 29)).toEqual({ ok: true, scale: 4 })
    expect(fitScale(e, stock, ['x'], 30)).toEqual({ ok: false, problem: 'marginTooLarge' })
    expect(fitScale({ x: 20, y: 10, z: 0 }, stock, ['z'])).toEqual({
      ok: false,
      problem: 'zeroExtent',
    })
    // a flat axis is skipped when another governs
    expect(fitScale({ x: 20, y: 10, z: 0 }, stock, ['x', 'z'])).toEqual({ ok: true, scale: 5 })
  })

  it('roundScaleDown keeps 6 significant digits, never rounding up', () => {
    expect(roundScaleDown(2)).toBe(2)
    expect(roundScaleDown(0.5)).toBe(0.5)
    expect(roundScaleDown(4.965)).toBe(4.965)
    expect(roundScaleDown(2 / 3)).toBe(0.666666)
    expect(roundScaleDown(123.4567891)).toBe(123.456)
    expect(roundScaleDown(0.0123456789)).toBe(0.0123456)
  })

  it('exceedsStock reports the overhang per axis, ignoring rounding noise', () => {
    const inside = { min: { x: 0, y: 0, z: -20.0000001 }, max: { x: 100, y: 60, z: 0 } }
    expect(exceedsStock('r', inside, stock)).toBeUndefined()
    const out = exceedsStock(
      'r',
      { min: { x: -2, y: 0, z: -5 }, max: { x: 101, y: 10, z: 3 } },
      stock,
    )
    expect(out).toMatchObject({
      code: 'reference.exceedsStock',
      params: { x: 3, y: 0, z: 3 },
      message: 'The reference sticks out of the stock by X 3, Z 3 mm',
    })
  })
})

describe('placed box rounding (DF90)', () => {
  it("a top fitted at half scale reads 0, not the stored position's rounding left-over", () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 249.5, y: 177.06, z: 60.52402923 } }
    const p = { ...flat, scale: 0.5 }
    const z = fitPosition(
      placedExtent(bounds, p),
      { length: 250, width: 100, thickness: 40 },
      {},
      'top',
    ).z
    // the record stores the position to 0.0001 mm
    const stored = Math.round(z * 1e4) / 1e4
    const b = placedBox(bounds, { ...p, position: { x: 0, y: 0, z: stored } })
    expect(b.max.z).toBe(0)
    expect(b.min.z).toBe(-30.262)
  })
})

describe('facing depth from the reference (DF4)', () => {
  // a 60 × 40 × 10 part centred in the 100 × 60 × 20 stock, its top 0.5 below the stock top
  const part = { min: { x: 20, y: 10, z: -10.5 }, max: { x: 80, y: 50, z: -0.5 } }
  const one = [{ referenceId: 'reference1', box: part }]

  it('measures from each stock face to the reference along its normal', () => {
    expect(depthToReference('+z', stock, part)).toBeCloseTo(0.5)
    expect(depthToReference('-z', stock, part)).toBeCloseTo(9.5)
    expect(depthToReference('+x', stock, part)).toBe(20)
    expect(depthToReference('-x', stock, part)).toBe(20)
    expect(depthToReference('+y', stock, part)).toBe(10)
    expect(depthToReference('-y', stock, part)).toBe(10)
    // beside the stock: nothing under the face
    const beside = { min: { x: 120, y: 10, z: -5 }, max: { x: 140, y: 20, z: -1 } }
    expect(depthToReference('+z', stock, beside)).toBeUndefined()
  })

  it('suggests a positive depth under the stock extent, in project units, rounded down', () => {
    expect(suggestFacingDepth('+z', stock, one, 'mm')).toEqual({
      depth: 0.5,
      source: '0.5 mm',
      referenceId: 'reference1',
    })
    // 0.5 mm = 0.019685…″ → 0.0196″ (down, never into the part)
    expect(suggestFacingDepth('+z', stock, one, 'inch')?.source).toBe('0.0196"')
    expect(facingDepthSource(0.4999, 'mm')).toBe('0.499 mm')
    expect(facingDepthSource(0.48000000001, 'mm')).toBe('0.48 mm')
    expect(facingDepthSource(25.4, 'inch')).toBe('1"')
  })

  it('gives nothing for a reference at or above the face, or as deep as the stock', () => {
    const atTop = { ...part, max: { ...part.max, z: 0 } }
    expect(
      suggestFacingDepth('+z', stock, [{ referenceId: 'r', box: atTop }], 'mm'),
    ).toBeUndefined()
    const above = { ...part, max: { ...part.max, z: 2 } }
    expect(
      suggestFacingDepth('+z', stock, [{ referenceId: 'r', box: above }], 'mm'),
    ).toBeUndefined()
    // under 0.001 mm rounds down to 0
    const hair = { ...part, max: { ...part.max, z: -0.0004 } }
    expect(suggestFacingDepth('+z', stock, [{ referenceId: 'r', box: hair }], 'mm')).toBeUndefined()
    // a reference below the stock: depth ≥ thickness
    const below = { min: { x: 20, y: 10, z: -40 }, max: { x: 80, y: 50, z: -20 } }
    expect(
      suggestFacingDepth('+z', stock, [{ referenceId: 'r', box: below }], 'mm'),
    ).toBeUndefined()
    expect(suggestFacingDepth('+z', stock, [], 'mm')).toBeUndefined()
  })

  it('takes the closest of several references', () => {
    const higher = { ...part, max: { ...part.max, z: -0.25 } }
    const s = suggestFacingDepth(
      '+z',
      stock,
      [...one, { referenceId: 'reference2', box: higher }],
      'mm',
    )
    expect(s).toMatchObject({ source: '0.25 mm', referenceId: 'reference2' })
    // one sticking out above the top: facing to the other would cut into it
    const out = { ...part, max: { ...part.max, z: 1 } }
    expect(
      suggestFacingDepth('+z', stock, [...one, { referenceId: 'r', box: out }], 'mm'),
    ).toBeUndefined()
  })
})
