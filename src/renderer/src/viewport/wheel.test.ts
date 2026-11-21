import { describe, expect, it } from 'vitest'
import { classifyWheel, WHEEL_GESTURE_GAP_MS, type WheelLike } from './wheel'

const wheel = (e: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  ...e,
})

describe('classifyWheel', () => {
  it('a pinch (ctrlKey) zooms, even with fractional deltas or mid-pan', () => {
    expect(classifyWheel(wheel({ deltaY: -2.5, ctrlKey: true }))).toBe('zoom')
    expect(
      classifyWheel(wheel({ deltaY: 3, ctrlKey: true }), { gesture: 'pan', time: 0 }, 10),
    ).toBe('zoom')
  })

  it('a mouse wheel zooms: line mode, or whole-pixel steps with a 120 wheelDelta', () => {
    expect(classifyWheel(wheel({ deltaY: 3, deltaMode: 1 }))).toBe('zoom')
    expect(classifyWheel(wheel({ deltaY: 1, deltaMode: 2 }))).toBe('zoom')
    expect(classifyWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toBe('zoom')
    expect(classifyWheel(wheel({ deltaY: -4, wheelDeltaY: 120 }))).toBe('zoom')
    expect(classifyWheel(wheel({ deltaY: -40, wheelDeltaY: 120 }))).toBe('zoom')
  })

  it('a two-finger trackpad scroll pans', () => {
    expect(classifyWheel(wheel({ deltaX: 2, deltaY: 0 }))).toBe('pan')
    expect(classifyWheel(wheel({ deltaX: -1, deltaY: 7 }))).toBe('pan')
    expect(classifyWheel(wheel({ deltaY: 1.5 }))).toBe('pan')
    expect(classifyWheel(wheel({ deltaY: 7, wheelDeltaY: -21 }))).toBe('pan')
    expect(classifyWheel(wheel({ deltaY: -2, wheelDeltaY: 6 }))).toBe('pan')
  })

  it('line mode wins over trackpad-looking deltas', () => {
    expect(classifyWheel(wheel({ deltaX: 1, deltaY: 1.5, deltaMode: 1 }))).toBe('zoom')
  })

  it('without wheelDeltaY a whole-pixel vertical step falls back to zoom', () => {
    expect(classifyWheel(wheel({ deltaY: 53 }))).toBe('zoom')
  })

  it('the rest of a trackpad gesture stays a pan, a later event is classified afresh', () => {
    const pan = { gesture: 'pan', time: 1000 } as const
    const step = wheel({ deltaY: 40, wheelDeltaY: -120 })
    expect(classifyWheel(step, pan, 1000 + WHEEL_GESTURE_GAP_MS - 1)).toBe('pan')
    expect(classifyWheel(step, pan, 1000 + WHEEL_GESTURE_GAP_MS)).toBe('zoom')
    expect(classifyWheel(step, { gesture: 'zoom', time: 1000 }, 1010)).toBe('zoom')
  })
})
