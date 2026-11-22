import { describe, expect, it } from 'vitest'
import type { Toolpath } from '../../../core/toolpath/model'
import { mix, toLinear, type Rgb } from './colours'
import { setupFrame } from '../../../core/toolpath/wcs'
import { DONE_DIM, frameMatrix, segmentColours } from './RunLayer'
import { advancePlayback, linesBounds, placeBox, SEGMENT, toolpathLines } from './toolpath-lines'

const tp = (moves: Toolpath['passes'][number]['moves']): Toolpath => ({
  planOperationId: 'op1',
  tool: 't1',
  spindleSpeed: 10000,
  passes: [{ kind: 'rough', moves }],
  stats: { cutLength: 0, rapidLength: 0, estimatedSeconds: 0 },
})

const seg = (l: ReturnType<typeof toolpathLines>, i: number) =>
  Array.from(l.positions.subarray(6 * i, 6 * i + 6))

describe('toolpathLines', () => {
  it('draws moves from the previous position; the first move only places the tool', () => {
    const l = toolpathLines([
      tp([
        { kind: 'rapid', to: [0, 0, 5] },
        { kind: 'line', to: [0, 0, -1], feed: 100 },
        { kind: 'line', to: [10, 0, -1], feed: 500 },
      ]),
    ])
    expect(l.segments).toBe(2)
    expect(seg(l, 0)).toEqual([0, 0, 5, 0, 0, -1])
    expect(Array.from(l.kind)).toEqual([SEGMENT.plunge, SEGMENT.feed])
    expect(linesBounds(l)).toEqual({ min: [0, 0, -1], max: [10, 0, 5] })
  })

  it('tessellates arcs on their circle, in the given direction, with helical Z', () => {
    const l = toolpathLines([
      tp([
        { kind: 'rapid', to: [10, 0, 0] },
        { kind: 'arc', to: [-10, 0, -2], center: [0, 0], cw: false, feed: 100 },
      ]),
    ])
    expect(l.segments).toBe(60) // 180° in 3° chords
    for (let i = 0; i < l.segments; i++) {
      const [x, y] = seg(l, i).slice(3)
      expect(Math.hypot(x!, y!)).toBeCloseTo(10, 4)
      expect(y!).toBeGreaterThanOrEqual(-1e-6) // counter-clockwise: through +Y
    }
    expect(seg(l, 29)[5]).toBeCloseTo(-1, 4)
  })

  it('draws a drill cycle down at feed and back up as a rapid', () => {
    const l = toolpathLines([
      tp([
        { kind: 'rapid', to: [5, 5, 2] },
        { kind: 'drill', at: [5, 5], top: 0, bottom: -8, cycle: 'simple', retract: 2, feed: 150 },
      ]),
    ])
    expect(l.segments).toBe(3)
    expect(seg(l, 1)).toEqual([5, 5, 2, 5, 5, -8])
    expect(Array.from(l.kind)).toEqual([SEGMENT.rapid, SEGMENT.plunge, SEGMENT.rapid])
  })
})

describe('advancePlayback', () => {
  const l = toolpathLines([
    tp([
      { kind: 'rapid', to: [0, 0, 5] },
      { kind: 'line', to: [0, 0, 0], feed: 100 },
      { kind: 'line', to: [10, 0, 0], feed: 100 },
      { kind: 'rapid', to: [10, 0, 5] },
      { kind: 'rapid', to: [0, 0, 5] },
      { kind: 'line', to: [0, 0, 0], feed: 100 },
    ]),
  ])

  it('finds the segment the tool is on, only forward', () => {
    expect(advancePlayback(l, 0, [5, 0, 0])).toBe(1)
    // the same point is on segment 4 too: from 1 it stays at the first match
    expect(advancePlayback(l, 1, [0, 0, 5])).toBe(3)
    expect(advancePlayback(l, 3, [0, 0, 2])).toBe(4)
    // never back: an earlier position keeps the cursor
    expect(advancePlayback(l, 4, [5, 0, 0])).toBe(4)
  })

  it('keeps the cursor for a position off the path (a tool change)', () => {
    expect(advancePlayback(l, 2, [50, 50, 50])).toBe(2)
  })
})

describe('segmentColours', () => {
  const palette = {
    feed: [0.2, 0.2, 0.2] as Rgb,
    rapid: [0.5, 0.5, 0.5] as Rgb,
    plunge: [0.1, 0.3, 0.6] as Rgb,
    background: [1, 1, 1] as Rgb,
  }
  it('dims done segments towards the background; rapids, plunges and feeds apart', () => {
    const l = toolpathLines([
      tp([
        { kind: 'rapid', to: [0, 0, 5] },
        { kind: 'rapid', to: [0, 0, 1] },
        { kind: 'line', to: [0, 0, 0], feed: 100 },
        { kind: 'line', to: [1, 0, 0], feed: 100 },
        { kind: 'line', to: [1, 0, -1], feed: 100 },
      ]),
    ])
    const c = segmentColours(l, 2, palette)
    const at = (i: number) => Array.from(c.subarray(6 * i, 6 * i + 3))
    const close = (a: number[], b: readonly number[]) =>
      a.forEach((v, k) => expect(v).toBeCloseTo(b[k]!, 5))
    close(at(0), toLinear(mix(palette.rapid, palette.background, DONE_DIM)))
    close(at(1), toLinear(mix(palette.plunge, palette.background, DONE_DIM)))
    close(at(2), toLinear(palette.feed))
    close(at(3), toLinear(palette.plunge))
  })
})

describe('setup frame (E2)', () => {
  const stock = { length: 100, width: 60, thickness: 20 }
  const box = { min: [0, 0, -20], max: [100, 60, 0] } as const

  it('placeBox: no frame keeps the box; the bottom setup lands on the stock', () => {
    expect(placeBox(box, undefined)).toBe(box)
    // the bottom setup's WCS: the stock seen from below lies on the stock again
    const placed = placeBox(box, setupFrame('-z', 0, stock))!
    expect(placed.min.map((c) => Math.round(c))).toEqual([0, 0, -20])
    expect(placed.max.map((c) => Math.round(c))).toEqual([100, 60, 0])
  })

  it('frameMatrix maps WCS points like the placement', () => {
    const frame = setupFrame('+x', 90, stock)
    const m = frameMatrix(frame).elements
    const at = (p: readonly number[]) =>
      [0, 1, 2].map((i) => m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]!)
    // the work zero is the frame origin; WCS X runs along u
    expect(at([0, 0, 0])).toEqual([...frame.origin])
    expect(at([1, 0, 0]).map((c, i) => c - frame.origin[i]!)).toEqual([...frame.u])
  })
})
