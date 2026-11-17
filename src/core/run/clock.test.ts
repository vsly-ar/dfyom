import { describe, expect, it } from 'vitest'
import { VirtualClock } from './clock'

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
