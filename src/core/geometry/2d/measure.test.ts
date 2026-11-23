// `chainSampler` against `chainPointAt` (hardening P5: the tab hold test samples a loop every
// 0.25 mm through it). Doc: docs/architecture/shapes.md#design-commands-p5
import { describe, expect, it } from 'vitest'
import { chainLength, chainPointAt, chainSampler } from './measure'
import { line, type Loop } from './model'
import { rect, star } from './testing/fixtures'

const loops: [string, Loop][] = [
  ['rounded rectangle', rect(0, 0, 40, 30, 5)],
  ['sharp rectangle', rect(10, 10, 40, 30)],
  ['filleted star', star(12)[0]!],
]

describe('chainSampler', () => {
  it.each(loops)('finds the points chainPointAt finds (%s), on both turns', (_, loop) => {
    const total = chainLength(loop)
    const at = chainSampler(loop, true)
    // every 0.25 mm over two turns (element ends included), plus negative distances
    for (let s = -total; s <= 2 * total; s += 0.25) {
      const want = chainPointAt(loop, s, true).unwrap()
      const got = at(s).unwrap()
      expect(got.point[0]).toBeCloseTo(want.point[0], 9)
      expect(got.point[1]).toBeCloseTo(want.point[1], 9)
      // at an element end the two may take either neighbour (the same point, another tangent)
      if (got.element === want.element) {
        expect(got.tangent[0]).toBeCloseTo(want.tangent[0], 9)
        expect(got.tangent[1]).toBeCloseTo(want.tangent[1], 9)
      } else expect(Math.abs(got.element - want.element) % (loop.elements.length - 1)).toBe(1)
    }
  })

  it('takes the same element as chainPointAt away from element ends, to the last bits', () => {
    const loop = rect(0, 0, 40, 30, 5)
    const at = chainSampler(loop, true)
    for (let s = 0.1; s < chainLength(loop); s += 0.37) {
      const got = at(s).unwrap()
      const want = chainPointAt(loop, s, true).unwrap()
      expect(got.element).toBe(want.element)
      expect(Math.hypot(got.point[0] - want.point[0], got.point[1] - want.point[1])).toBeLessThan(
        1e-12,
      )
    }
  })

  it('refuses what chainPointAt refuses: empty chains, non-finite and out-of-range distances', () => {
    const path: Loop = { elements: [line([0, 0], [10, 0])] }
    const rule = (r: ReturnType<ReturnType<typeof chainSampler>>) =>
      r.isErr() ? r.unwrapErr().issues[0]?.rule : undefined
    expect(rule(chainSampler({ elements: [] }, true)(1))).toBe('empty')
    expect(rule(chainSampler(path, false)(Number.NaN))).toBe('notFinite')
    expect(rule(chainSampler(path, false)(11))).toBe('outOfRange')
    expect(chainSampler(path, false)(10).unwrap()).toEqual(chainPointAt(path, 10, false).unwrap())
  })
})
