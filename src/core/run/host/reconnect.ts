/**
 * DF129 auto-reconnect (RC4): after a connection lost during a run, tries to connect again to the
 * same device (its path, or the port with its USB serial number when the OS re-enumerated it) with
 * backoff for 2 minutes, and at once when its port reappears in the OS's list. Headless: the
 * attempt itself (a plain connect: handshake and reads only) and the port list are injected.
 * Doc: docs/modes/run-recovery.md#auto-reconnect, #implementation-rc4
 */
import type { AsyncAppResult } from '../../../shared/result'
import type { TimerHost } from '../clock'
import type { SerialPortInfo } from '../serial'

/** How long DFYOM keeps trying after the loss (Q158). */
export const RECONNECT_WINDOW_MS = 120_000
/** Delay before each attempt: at once, then 1, 2, 4 and 8 s; then every `RECONNECT_EVERY_MS`. */
export const RECONNECT_DELAYS_MS: readonly number[] = [0, 1000, 2000, 4000, 8000]
export const RECONNECT_EVERY_MS = 10_000
/** The OS's port list is scanned this often while waiting (a port that appears is tried at once). */
export const PORT_SCAN_MS = 1000

/** The lost serial device: its path and, when the OS reported them, its USB identity. */
export interface LostDevice {
  readonly path: string
  readonly serialNumber?: string | undefined
  readonly vendorId?: string | undefined
  readonly productId?: string | undefined
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined || a.toLowerCase() === b.toLowerCase()

/**
 * The port to try for `lost` among `ports`, or undefined (not there: wait). Its own path, unless the
 * OS reports another serial number there (another device took the path); else the port with its
 * serial number (and VID:PID when both are known). Never another device.
 */
export function matchPort(ports: readonly SerialPortInfo[], lost: LostDevice): string | undefined {
  const sn = lost.serialNumber
  const own = ports.find((p) => p.path === lost.path)
  if (
    own !== undefined &&
    (sn === undefined || own.serialNumber === undefined || own.serialNumber === sn)
  )
    return own.path
  if (sn === undefined) return undefined
  return ports.find(
    (p) =>
      p.serialNumber === sn && same(p.vendorId, lost.vendorId) && same(p.productId, lost.productId),
  )?.path
}

/** Where auto-reconnect is (`RunStatus.connection.reconnect`). */
export const RECONNECT_PHASES = ['waiting', 'connecting', 'reconnected', 'gaveUp'] as const
export type ReconnectPhase = (typeof RECONNECT_PHASES)[number]

export interface ReconnectProgress {
  readonly phase: ReconnectPhase
  /** Attempts made so far (the one connecting included). */
  readonly attempt: number
  /** Waiting: ms until the next scheduled attempt. */
  readonly nextInMs?: number
}

export interface ReconnectorDeps {
  readonly timers: TimerHost
  /**
   * One attempt: a plain connect to `path` (serial) or to the virtual machine (`undefined`);
   * Ok once connected.
   */
  attempt(path: string | undefined): AsyncAppResult<unknown>
  /** Serial: the lost device and the OS's port list; absent for the virtual machine. */
  readonly serial?: {
    readonly lost: LostDevice
    list(): AsyncAppResult<SerialPortInfo[]>
  }
  onChange(progress: ReconnectProgress): void
}

/** One reconnecting episode: from `start()` to reconnected, gave up or `cancel()`. */
export class Reconnector {
  private attempts = 0
  private phase: ReconnectPhase = 'waiting'
  private startedAt = 0
  private nextAt: number | undefined
  private cancelNext: (() => void) | undefined
  private cancelScan: (() => void) | undefined
  private cancelDeadline: (() => void) | undefined
  /** The device was in the last scan (undefined before the first). */
  private present: boolean | undefined
  private stopped = false

  constructor(private readonly deps: ReconnectorDeps) {}

  get progress(): ReconnectProgress {
    return {
      phase: this.phase,
      attempt: this.attempts,
      ...(this.phase === 'waiting' && this.nextAt !== undefined
        ? { nextInMs: Math.max(0, this.nextAt - this.deps.timers.now()) }
        : {}),
    }
  }

  get active(): boolean {
    return !this.stopped
  }

  start(): void {
    this.startedAt = this.deps.timers.now()
    this.cancelDeadline = this.deps.timers.setTimeout(() => {
      // an attempt still connecting at the deadline decides by itself
      if (this.phase === 'waiting') this.finish('gaveUp')
    }, RECONNECT_WINDOW_MS)
    this.schedule(RECONNECT_DELAYS_MS[0] ?? 0)
    if (this.deps.serial !== undefined) this.scanLater()
  }

  /** Stops trying (the user's "Stop trying", a connect or disconnect of their own). */
  cancel(): void {
    this.stop()
  }

  private stop(): void {
    this.stopped = true
    this.cancelNext?.()
    this.cancelScan?.()
    this.cancelDeadline?.()
    this.cancelNext = this.cancelScan = this.cancelDeadline = undefined
    this.nextAt = undefined
  }

  private finish(phase: 'reconnected' | 'gaveUp'): void {
    this.stop()
    this.phase = phase
    this.deps.onChange(this.progress)
  }

  /** The next attempt in `ms`, or giving up when it would come after the 2 minutes. */
  private schedule(ms: number): void {
    this.cancelNext?.()
    const at = this.deps.timers.now() + ms
    if (at - this.startedAt >= RECONNECT_WINDOW_MS) {
      this.nextAt = undefined
      this.cancelNext = undefined
      return
    }
    this.nextAt = at
    this.cancelNext = this.deps.timers.setTimeout(() => void this.tryOnce(), ms)
  }

  private scanLater(): void {
    this.cancelScan = this.deps.timers.setTimeout(() => void this.scan(), PORT_SCAN_MS)
  }

  /** A port that appears (absent in the last scan, there now) is tried at once. */
  private async scan(): Promise<void> {
    const serial = this.deps.serial
    if (this.stopped || serial === undefined) return
    if (this.phase === 'waiting') {
      const listed = await serial.list()
      if (this.stopped) return
      const there = listed.isOk() && matchPort(listed.unwrap(), serial.lost) !== undefined
      const arrived = there && this.present === false
      this.present = there
      if (arrived && this.phase === 'waiting') {
        this.scanLater()
        return this.tryOnce()
      }
    }
    this.scanLater()
  }

  private async tryOnce(): Promise<void> {
    if (this.stopped || this.phase !== 'waiting') return
    this.cancelNext?.()
    this.cancelNext = undefined
    this.nextAt = undefined
    this.attempts++
    this.phase = 'connecting'
    this.deps.onChange(this.progress)
    const path = await this.target()
    const r = path === null ? undefined : await this.deps.attempt(path)
    if (this.stopped) return
    if (r?.isOk() === true) return this.finish('reconnected')
    if (this.deps.timers.now() - this.startedAt >= RECONNECT_WINDOW_MS) return this.finish('gaveUp')
    this.phase = 'waiting'
    this.schedule(RECONNECT_DELAYS_MS[this.attempts] ?? RECONNECT_EVERY_MS)
    this.deps.onChange(this.progress)
  }

  /** Serial: the matching port (`null`: none listed, the attempt fails); virtual: `undefined`. */
  private async target(): Promise<string | undefined | null> {
    const serial = this.deps.serial
    if (serial === undefined) return undefined
    const listed = await serial.list()
    // no list from the OS: try the path itself
    if (listed.isErr()) return serial.lost.path
    const path = matchPort(listed.unwrap(), serial.lost)
    this.present = path !== undefined
    return path ?? null
  }
}
