// Click or hold (DF88): docs/conventions/ui.md#jog-position-and-probing-df88
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJogPress, HOLD_DELAY_MS, type JogPressHandlers } from './jog-press'

function setup() {
  const calls: string[] = []
  const h: JogPressHandlers = {
    step: (axis, sign) => calls.push(`step ${axis}${sign}`),
    holdStart: (axis, sign) => calls.push(`hold ${axis}${sign}`),
    holdEnd: () => calls.push('end'),
  }
  return { calls, press: createJogPress(() => h) }
}

describe('createJogPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a release inside the hold delay is one step, never a continuous jog', () => {
    const { calls, press } = setup()
    press.press('x+', 'x', 1)
    vi.advanceTimersByTime(HOLD_DELAY_MS - 1)
    press.release('x+')
    vi.advanceTimersByTime(HOLD_DELAY_MS * 4)
    expect(calls).toEqual(['step x1'])
    expect(press.active()).toBeUndefined()
  })

  it('a press held past the delay jogs continuously until released (no step)', () => {
    const { calls, press } = setup()
    press.press('z-', 'z', -1)
    vi.advanceTimersByTime(HOLD_DELAY_MS)
    expect(calls).toEqual(['hold z-1'])
    expect(press.active()).toEqual({ id: 'z-', holding: true })
    vi.advanceTimersByTime(5000)
    press.release('z-')
    expect(calls).toEqual(['hold z-1', 'end'])
  })

  it('an abort inside the delay sends nothing; after it, it ends the hold', () => {
    const { calls, press } = setup()
    press.press('y+', 'y', 1)
    press.abort()
    vi.advanceTimersByTime(HOLD_DELAY_MS * 2)
    expect(calls).toEqual([])
    press.press('y+', 'y', 1)
    vi.advanceTimersByTime(HOLD_DELAY_MS)
    press.abort()
    press.abort()
    expect(calls).toEqual(['hold y1', 'end'])
  })

  it('one press at a time: a second press and a foreign release are ignored', () => {
    const { calls, press } = setup()
    expect(press.press('x+', 'x', 1)).toBe(true)
    expect(press.press('y+', 'y', 1)).toBe(false)
    press.release('y+')
    press.release('x+')
    expect(calls).toEqual(['step x1'])
  })
})
