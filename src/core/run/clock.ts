/**
 * Time source for run mode. Doc: docs/architecture/grbl.md#motion-timing
 *
 * Tests use `VirtualClock` (virtual time, as fast as the CPU allows); the app supplies a
 * real-time clock in the utility process (task 3.9).
 */

export interface Clock {
  /** Milliseconds since an arbitrary origin. */
  now(): number
  /** Calls `fn` once the clock reaches `at` (ms); returns a cancel function. */
  schedule(at: number, fn: () => void): () => void
}

interface Timer {
  readonly at: number
  readonly seq: number
  readonly fn: () => void
}

/** Virtual time: nothing happens until `advance`/`advanceTo` moves it. Timers fire in order. */
export class VirtualClock implements Clock {
  private t = 0
  private seq = 0
  private timers: Timer[] = []

  now(): number {
    return this.t
  }

  schedule(at: number, fn: () => void): () => void {
    const timer: Timer = { at: Math.max(at, this.t), seq: this.seq++, fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }

  advance(ms: number): void {
    this.advanceTo(this.t + ms)
  }

  /** Fires every timer due up to `t`, including ones scheduled while firing. */
  advanceTo(t: number): void {
    for (;;) {
      const next = this.nextTimer()
      if (next === undefined || next.at > t) break
      this.timers = this.timers.filter((x) => x !== next)
      this.t = Math.max(this.t, next.at)
      next.fn()
    }
    this.t = Math.max(this.t, t)
  }

  /** Time of the earliest pending timer. */
  nextAt(): number | undefined {
    return this.nextTimer()?.at
  }

  private nextTimer(): Timer | undefined {
    let best: Timer | undefined
    for (const x of this.timers) {
      if (!best || x.at < best.at || (x.at === best.at && x.seq < best.seq)) best = x
    }
    return best
  }
}
