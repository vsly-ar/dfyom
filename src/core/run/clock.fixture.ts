// Test-only fake wall timers for the run clocks and the machine host. Not app code.
// Doc: docs/modes/run-v0.1.md#clocks
import type { TimerHost } from './clock'

interface WallTimer {
  readonly at: number
  readonly seq: number
  readonly fn: () => void
}

/** Fake wall time: timers fire only in `advance`, in time order. */
export class FakeTimers implements TimerHost {
  t = 0
  /** Wall timers armed so far. */
  armed = 0
  private seq = 0
  private timers: WallTimer[] = []

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: WallTimer = { at: this.t + ms, seq: this.seq++, fn }
    this.timers.push(timer)
    this.armed++
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }

  get pending(): number {
    return this.timers.length
  }

  /** Runs the wall timers due up to `now + ms`, including ones armed while firing. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: WallTimer | undefined
      for (const x of this.timers)
        if (!next || x.at < next.at || (x.at === next.at && x.seq < next.seq)) next = x
      if (next === undefined || next.at > end) break
      const due = next
      this.timers = this.timers.filter((x) => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    this.t = Math.max(this.t, end)
  }
}
