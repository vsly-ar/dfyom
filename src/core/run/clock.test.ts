import { describe, expect, it } from 'vitest'
import { isTimeScale, ScaledClock, VirtualClock } from './clock'
import { FakeTimers } from './clock.fixture'

describe('VirtualClock', () => {
  it('fires timers in time order, including ones scheduled while firing', () => {
    const c = new VirtualClock()
    const log: string[] = []
    c.schedule(20, () => log.push(`b@${c.now()}`))
    c.schedule(10, () => {
      log.push(`a@${c.now()}`)
      c.schedule(15, () => log.push(`c@${c.now()}`))
    })
    const cancel = c.schedule(12, () => log.push('cancelled'))
    cancel()
    c.advance(30)
    expect(log).toEqual(['a@10', 'c@15', 'b@20'])
    expect(c.now()).toBe(30)
  })

  it('runs a timer in the past at the current time and reports the next one', () => {
    const c = new VirtualClock()
    c.advance(100)
    let fired = -1
    c.schedule(50, () => (fired = c.now()))
    expect(c.nextAt()).toBe(100)
    c.advanceTo(100)
    expect(fired).toBe(100)
    expect(c.nextAt()).toBeUndefined()
  })
})

describe('ScaledClock', () => {
  it('runs at real time by default: timers fire at their wall time', () => {
    const w = new FakeTimers()
    const c = new ScaledClock(w)
    const log: string[] = []
    c.schedule(100, () => log.push(`a@${c.now()}`))
    c.schedule(50, () => log.push(`b@${c.now()}`))
    w.advance(49)
    expect(log).toEqual([])
    w.advance(1)
    expect(log).toEqual(['b@50'])
    w.advance(50)
    expect(log).toEqual(['b@50', 'a@100'])
    expect(w.pending).toBe(0)
  })

  it('scales virtual time and re-anchors on a scale change without a jump', () => {
    const w = new FakeTimers()
    const c = new ScaledClock(w, { scale: 10 })
    let fired = -1
    c.schedule(1000, () => (fired = c.now()))
    w.advance(50)
    expect(c.now()).toBe(500)
    c.setScale(1)
    expect(c.now()).toBe(500)
    w.advance(100)
    expect(c.now()).toBe(600)
    expect(fired).toBe(-1)
    c.setScale(100)
    w.advance(4)
    expect(fired).toBe(1000)
    expect(c.now()).toBe(1000)
  })

  it('keeps timer order and honours cancel', () => {
    const w = new FakeTimers()
    const c = new ScaledClock(w, { scale: 2 })
    const log: number[] = []
    const cancel = c.schedule(30, () => log.push(30))
    c.schedule(20, () => log.push(20))
    c.schedule(20, () => log.push(21))
    c.schedule(40, () => log.push(40))
    cancel()
    w.advance(100)
    expect(log).toEqual([20, 21, 40])
  })

  it('max: jumps to the next timer while busy, real time while idle', () => {
    const w = new FakeTimers()
    let busy = true
    const c = new ScaledClock(w, { scale: 'max', busy: () => busy })
    const log: number[] = []
    c.schedule(60_000, () => log.push(c.now()))
    c.schedule(120_000, () => log.push(c.now()))
    w.advance(0)
    expect(log).toEqual([60_000, 120_000])
    busy = false
    c.schedule(c.now() + 1000, () => log.push(c.now()))
    w.advance(999)
    expect(log).toHaveLength(2)
    w.advance(1)
    expect(log).toEqual([60_000, 120_000, 121_000])
  })

  it('max: yields to the event loop after each slice of wall time, stops on dispose', () => {
    const w = new FakeTimers()
    const c = new ScaledClock(w, { scale: 'max', sliceMs: 10 })
    let ticks = 0
    const tick = (): void => {
      ticks++
      w.t += 1 // each timer costs 1 ms of wall time
      c.schedule(c.now() + 200, tick)
    }
    c.schedule(200, tick)
    const armed = w.armed
    w.advance(0)
    // one slice of 10 timers, then a fresh 0 ms wall timer instead of looping on
    expect(ticks).toBe(10)
    expect(w.armed).toBe(armed + 1)
    w.advance(0)
    expect(ticks).toBe(20)
    c.dispose()
    w.advance(1000)
    expect(ticks).toBe(20)
    expect(w.pending).toBe(0)
  })

  it('accepts 1–100 or max as a time scale', () => {
    expect([1, 2.5, 100, 'max'].every(isTimeScale)).toBe(true)
    expect([0, 0.5, 101, 'fast', Number.NaN].some(isTimeScale)).toBe(false)
  })
})
