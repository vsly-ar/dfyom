import { describe, expect, it } from 'vitest'
import type { Vec3 } from './mesh'
import { closestOnAxis, lockAxis, projectOnAxis } from './measure-axis'

// a simple oblique projection: x right, y up-right (half), z up; screen y grows downwards
const toPx = (p: Vec3): [number, number] => [100 + p[0] * 10 + p[1] * 5, 100 - p[2] * 10 - p[1] * 5]

describe('lockAxis', () => {
  it('picks the axis whose screen direction matches the pointer best', () => {
    expect(lockAxis([0, 0, 0], [150, 101], toPx)).toBe('x')
    expect(lockAxis([0, 0, 0], [50, 99], toPx)).toBe('x')
    expect(lockAxis([0, 0, 0], [101, 40], toPx)).toBe('z')
    expect(lockAxis([0, 0, 0], [130, 70], toPx)).toBe('y')
  })
  it('gives no axis while the pointer sits on the first point', () => {
    expect(lockAxis([0, 0, 0], [100.5, 100.5], toPx)).toBeNull()
  })
  it('skips an axis pointing at the camera, even when perspective gives it a short stroke', () => {
    // a Top view in perspective: Z projects to a short radial stroke (here sideways)
    const persp = (p: Vec3): [number, number] => [p[0] * 10 + p[2] * 2, -p[1] * 10]
    expect(lockAxis([0, 0, 0], [30, 1], persp)).toBe('x')
    expect(lockAxis([0, 0, 0], [1, 30], persp)).toBe('y')
  })
  it('skips an axis seen end-on', () => {
    const top = (p: Vec3): [number, number] => [p[0] * 10, -p[1] * 10] // looking down Z
    expect(lockAxis([0, 0, 0], [3, -30], top)).toBe('y')
    expect(lockAxis([0, 0, 0], [30, 1], top)).toBe('x')
  })
})

describe('closestOnAxis', () => {
  it('finds the axis point nearest a ray', () => {
    // a ray straight down through (7, 3, ·) and the X axis through (0, 3, 0)
    expect(closestOnAxis([0, 3, 0], 'x', [7, 3, 50], [0, 0, -1])).toEqual([7, 3, 0])
    // the Z axis through the origin, a horizontal ray passing at height 4
    const p = closestOnAxis([0, 0, 0], 'z', [-10, 2, 4], [1, 0, 0])
    expect(p[2]).toBeCloseTo(4)
    expect(p[0]).toBe(0)
  })
  it('returns the first point for a ray parallel to the axis', () => {
    expect(closestOnAxis([1, 2, 3], 'y', [0, 0, 0], [0, 2, 0])).toEqual([1, 2, 3])
  })
})

describe('projectOnAxis', () => {
  it('keeps only the component along the axis', () => {
    expect(projectOnAxis([1, 1, 1], 'y', [5, 4, -2])).toEqual([1, 4, 1])
  })
})
