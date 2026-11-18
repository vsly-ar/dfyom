/**
 * Time source for run mode. Docs: docs/architecture/grbl.md#motion-timing,
 * docs/modes/run-v0.1.md#clocks
 *
 * Tests use `VirtualClock` (virtual time, as fast as the CPU allows); the machine host uses a
 * `ScaledClock` over the process's timers: real time at scale 1, faster for the virtual machine,
 * or `max` (stepped: as fast as possible while the machine has work).
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

/** Wall time and one-shot timers of the host process; injected so core stays headless. */
export interface TimerHost {
  /** Monotonic milliseconds. */
  now(): number
  /** Calls `fn` after `ms`; returns the cancel function. */
  setTimeout(fn: () => void, ms: number): () => void
}

/** The environment's monotonic time and timers (Node, Electron utility process, browsers). */
export const systemTimerHost: TimerHost = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
}

/** Wall time of the virtual clock itself: for code that wants wall timeouts under a VirtualClock. */
export function clockTimers(clock: Clock): TimerHost {
  return { now: () => clock.now(), setTimeout: (fn, ms) => clock.schedule(clock.now() + ms, fn) }
}

/** Virtual machine time scale: 1–100 × real time, or `max` (docs/modes/run-v0.1.md#clocks). */
export type TimeScale = number | 'max'
export const MAX_TIME_SCALE = 100

export function isTimeScale(s: unknown): s is TimeScale {
  return s === 'max' || (typeof s === 'number' && s >= 1 && s <= MAX_TIME_SCALE)
}

export interface ScaledClockOptions {
  /** Default 1 (real time). */
  readonly scale?: TimeScale
  /**
   * At `max`: whether the machine has work (motion, dwell, homing). While it has, the clock jumps
   * to its next timer; while it has none, it runs at real time, so an idle connection never spins
   * a core (default: always busy).
   */
  readonly busy?: () => boolean
  /** At `max`: wall time spent firing timers before yielding to the event loop (default 10 ms). */
  readonly sliceMs?: number
}

/**
 * `now() = v0 + (wall − w0) × scale`; one wall timer is armed for the earliest timer at a time.
 * `setScale` re-anchors at the current time, so virtual time never jumps. Scale `max` is the
 * stepped clock of the spec: timers fire back to back in slices of `sliceMs` wall time, with a
 * 0 ms timer between slices so messages, pause and abort get through.
 */
export class ScaledClock implements Clock {
  private v0 = 0
  private w0: number
  private s: TimeScale
  private seq = 0
  private timers: Timer[] = []
  private cancelWall: (() => void) | undefined
  private firing = false
  private disposed = false
  private busy: () => boolean
  private readonly sliceMs: number

  constructor(
    private readonly host: TimerHost,
    opts: ScaledClockOptions = {},
  ) {
    this.w0 = host.now()
    this.s = opts.scale ?? 1
    this.busy = opts.busy ?? (() => true)
    this.sliceMs = opts.sliceMs ?? 10
  }

  get scale(): TimeScale {
    return this.s
  }

  /** Real-time rate between jumps: the scale, or 1 at `max`. */
  private get rate(): number {
    return this.s === 'max' ? 1 : this.s
  }

  now(): number {
    return this.v0 + (this.host.now() - this.w0) * this.rate
  }

  schedule(at: number, fn: () => void): () => void {
    const timer: Timer = { at, seq: this.seq++, fn }
    this.timers.push(timer)
    if (!this.firing) this.arm()
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }

  setScale(scale: TimeScale): void {
    this.anchor(this.now())
    this.s = scale
    if (!this.firing) this.arm()
  }

  /** Sets the `max` busy test (the host creates the clock before the machine). */
  setBusy(busy: () => boolean): void {
    this.busy = busy
  }

  /** Re-arms the wall timer, e.g. after the machine became busy at `max`. */
  poke(): void {
    if (!this.firing) this.arm()
  }

  /** Cancels the wall timer; pending timers never fire. */
  dispose(): void {
    this.disposed = true
    this.cancelWall?.()
    this.cancelWall = undefined
    this.timers = []
  }

  private anchor(v: number): void {
    this.v0 = v
    this.w0 = this.host.now()
  }

  private earliest(): Timer | undefined {
    let best: Timer | undefined
    for (const x of this.timers) {
      if (!best || x.at < best.at || (x.at === best.at && x.seq < best.seq)) best = x
    }
    return best
  }

  private arm(): void {
    this.cancelWall?.()
    this.cancelWall = undefined
    if (this.disposed) return
    const next = this.earliest()
    if (next === undefined) return
    const jump = this.s === 'max' && this.busy()
    const delay = jump ? 0 : Math.max(0, (next.at - this.now()) / this.rate)
    this.cancelWall = this.host.setTimeout(() => {
      this.cancelWall = undefined
      this.fire()
    }, delay)
  }

  /** Fires due timers (at `max` while busy: every next timer) until the slice ends. */
  private fire(): void {
    const started = this.host.now()
    this.firing = true
    try {
      for (;;) {
        if (this.disposed) return
        const next = this.earliest()
        if (next === undefined) break
        if (next.at > this.now()) {
          if (this.s !== 'max' || !this.busy()) break
          this.anchor(next.at)
        }
        this.timers = this.timers.filter((x) => x !== next)
        next.fn()
        if (this.host.now() - started >= this.sliceMs) break
      }
    } finally {
      this.firing = false
    }
    this.arm()
  }
}
