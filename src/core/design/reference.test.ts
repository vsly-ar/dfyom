// Reference placement math: unit guess, placed extent, fit, exceedsStock.
// Spec: docs/modes/reference-model.md#source-unit-guess, #fit-to-stock, #placement-math-task-r2
import { describe, expect, it } from 'vitest'
import { exceedsStock, fitPosition, guessUnit, placedExtent, rotationMatrix } from './reference'

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
