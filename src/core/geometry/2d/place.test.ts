// Rigid placement and surface numbering of 2D loops (pure TS, no port).
// Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/design-v0.3.md#surfaces
import { describe, expect, it } from 'vitest'
import { arc, line, signedArea, type Loop } from './model'
import { fromStartPoint, loopStart, numberRegion, orientPath, orientRegion } from './place'

/** Axis-aligned square [x0, x0 + s] × [y0, y0 + s], counter-clockwise from (x0, y0). */
const square = (x0: number, y0: number, s: number): Loop => ({
  elements: [
    line([x0, y0], [x0 + s, y0]),
    line([x0 + s, y0], [x0 + s, y0 + s]),
    line([x0 + s, y0 + s], [x0, y0 + s]),
    line([x0, y0 + s], [x0, y0]),
  ],
})

/** The same loop, rotated to start at element `k`. */
const startAt = (l: Loop, k: number): Loop => ({
  elements: [...l.elements.slice(k), ...l.elements.slice(0, k)],
})

describe('orientation', () => {
  it('rotates counter-clockwise, exactly at multiples of 90°', () => {
    const p = orientPath({ elements: [line([10, 0], [10, 5])] }, { rotation: 90, mirror: false })
    expect(p.elements[0]).toEqual(line([0, 10], [-5, 10]))
    const q = orientPath({ elements: [line([10, 0], [0, 0])] }, { rotation: 30, mirror: false })
    const a = q.elements[0]!.a
    expect(a[0]).toBeCloseTo(10 * Math.cos(Math.PI / 6), 12)
    expect(a[1]).toBeCloseTo(5, 12)
  })

  it('mirrors x before rotating and keeps outer loops counter-clockwise', () => {
    const r = { pieces: [{ outer: square(0, 0, 10), holes: [] }] }
    const m = orientRegion(r, { rotation: 0, mirror: true })
    const outer = m.pieces[0]!.outer
    expect(signedArea(outer)).toBeCloseTo(100, 9)
    const xs = outer.elements.map((e) => e.a[0])
    expect(Math.min(...xs)).toBe(-10)
    expect(Math.max(...xs)).toBe(0)
    // an arc flips its sense with the mirror, then the loop reversal flips it back
    const half: Loop = {
      elements: [arc([10, 0], [-10, 0], [0, 0], true), line([-10, 0], [10, 0])],
    }
    const hm = orientRegion({ pieces: [{ outer: half, holes: [] }] }, { rotation: 0, mirror: true })
    expect(signedArea(hm.pieces[0]!.outer)).toBeCloseTo((Math.PI * 100) / 2, 6)
  })
})

describe('start point and numbering', () => {
  it('starts each loop at its lowest v, then lowest u', () => {
    const l = fromStartPoint(startAt(square(0, 0, 10), 2))
    expect(l.elements[0]!.a).toEqual([0, 0])
    expect(l.elements[0]!.b).toEqual([10, 0])
  })

  it('splits an arc at its bottom (a rotated rounded corner), a full circle starts there', () => {
    // a loop whose lowest point lies inside an arc: a half disc standing on its round side
    const bowl: Loop = {
      elements: [line([10, 0], [-10, 0]), arc([-10, 0], [10, 0], [0, 0], true)],
    }
    const s = loopStart(bowl)
    expect(s).toMatchObject({ element: 1, atStart: false })
    expect(s.point[1]).toBeCloseTo(-10, 12)
    const l = fromStartPoint(bowl)
    expect(l.elements).toHaveLength(3)
    expect(l.elements[0]!.a[1]).toBeCloseTo(-10, 12)
    expect(l.elements[2]!.b[1]).toBeCloseTo(-10, 12)
    const circle = fromStartPoint({ elements: [arc([5, 0], [5, 0], [0, 0], true)] })
    expect(circle.elements[0]!.a).toEqual([0, -5])
  })

  it('orders pieces and holes by start point', () => {
    const r = numberRegion({
      pieces: [
        { outer: square(50, 0, 20), holes: [] },
        {
          outer: square(0, 0, 40),
          holes: [startAt(square(20, 20, 5), 1), square(5, 5, 5)].map((h) => ({
            elements: [...h.elements].reverse().map((e) => line(e.b, e.a)),
          })),
        },
      ],
    })
    expect(r.pieces.map((p) => p.outer.elements[0]!.a)).toEqual([
      [0, 0],
      [50, 0],
    ])
    expect(r.pieces[0]!.holes.map((h) => h.elements[0]!.a)).toEqual([
      [5, 5],
      [20, 20],
    ])
  })
})
