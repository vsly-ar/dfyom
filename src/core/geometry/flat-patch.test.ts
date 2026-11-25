// Flat patches and touch-off spots (hardening DF69).
// Spec: docs/modes/z-reference.md#touch-off-spot, docs/modes/z-reference.md#implementation-notes-df69
import { describe, expect, it } from 'vitest'
import { chainBounds, regionArea, regionLoops, type Region } from './2d/model'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { spotFits, spotIndex, touchOffSpot } from './flat-patch'
import { rectangle } from './through-depth'

const port = nodeRegion2d()

describe('touchOffSpot', () => {
  it('the bucketed search over many holes answers as the plain scan (patterns P1)', () => {
    // a 100 × 60 face with 7 × 5 Ø 4 holes and a 50 × 3 slot: 36 loops besides the outer
    const holes: Region = {
      pieces: [
        ...Array.from({ length: 35 }, (_, k) => {
          const c = [15 + (k % 7) * 12, 8 + Math.floor(k / 7) * 11]
          return circleRegion(c as [number, number], 2).pieces[0]!
        }),
        rectangleAt(25, 55.5, 50, 3).pieces[0]!,
      ],
    }
    const patch = port.difference(rectangle(100, 60), holes).unwrap()
    const loops = regionLoops(patch)
    expect(loops.length).toBe(37)
    const index = spotIndex(port, patch, chainBounds(loops.flatMap((l) => l.elements))!)
    for (let x = -2; x <= 102; x += 1.3)
      for (let y = -2; y <= 62; y += 0.9) {
        const plain = port.contains(patch, [x, y]) ? port.distance(loops, [x, y])!.distance : -1
        expect(index([x, y])).toBeCloseTo(plain, 12)
      }
  })

  it('takes the middle of a rectangle on the grid, its distance to the boundary as radius', () => {
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1)!
    expect(s.at).toEqual([50, 30])
    expect(s.radius).toBeCloseTo(30, 6)
  })

  it('rounds to the grid (inch machines: 1.27 mm)', () => {
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1.27)!
    expect(s.at[0] / 1.27).toBeCloseTo(Math.round(s.at[0] / 1.27), 9)
    expect(Math.abs(s.at[1] - 30)).toBeLessThanOrEqual(1.27 / 2)
  })

  it('maps through a rotated frame: the spot is in the WCS', () => {
    // a setup turned 90°: WCS (x, y) = face (y, −x) shifted by the face length
    const frame = {
      toWcs: ([x, y]: readonly [number, number]) => [y, 100 - x] as [number, number],
      fromWcs: ([x, y]: readonly [number, number]) => [100 - y, x] as [number, number],
    }
    const s = touchOffSpot(port, rectangle(100, 60), 4, 1, frame)!
    expect(s.at).toEqual([30, 50])
  })

  it('finds nothing when the clearance swallows the patch', () => {
    expect(touchOffSpot(port, rectangle(6, 6), 4, 1)).toBeUndefined()
    expect(regionArea(rectangle(6, 6))).toBe(36)
  })
})

describe('spotFits', () => {
  it('accepts points of the eroded patch only', () => {
    expect(spotFits(port, rectangle(100, 60), 4, [10, 10])).toBe(true)
    expect(spotFits(port, rectangle(100, 60), 4, [2, 10])).toBe(false)
  })
})

function circleRegion(c: [number, number], r: number): Region {
  return port
    .normalise([
      {
        elements: [
          { kind: 'arc', a: [c[0] + r, c[1]], b: [c[0] - r, c[1]], centre: c, ccw: true },
          { kind: 'arc', a: [c[0] - r, c[1]], b: [c[0] + r, c[1]], centre: c, ccw: true },
        ],
      },
    ])
    .unwrap()
}

function rectangleAt(x: number, y: number, w: number, h: number): Region {
  const r = rectangle(w, h)
  return {
    pieces: r.pieces.map((p) => ({
      outer: {
        elements: p.outer.elements.map((e) => ({
          ...e,
          a: [e.a[0] + x, e.a[1] + y] as [number, number],
          b: [e.b[0] + x, e.b[1] + y] as [number, number],
        })),
      },
      holes: [],
    })),
  } as Region
}
