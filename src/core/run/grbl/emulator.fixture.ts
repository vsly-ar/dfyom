// Test-only helpers for the virtual machine: direct byte I/O and a tiny streamer.
// Not app code; the real sender is GrblSender (task 3.9). Doc: docs/architecture/grbl.md
import { expectOk } from '../../../shared/testing/result'
import { VirtualClock } from '../clock'
import { GrblEmulator, RX_BUFFER_SIZE, type EmulatorOptions } from './emulator/emulator'
import { VirtualGrblTransport } from './virtual-transport'

export const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

/** Fast machine for timing tests: 100 mm/s² on every axis, 6000 mm/min max rate, 1 m travel. */
export const FAST: Readonly<Record<number, number>> = {
  110: 6000,
  111: 6000,
  112: 6000,
  120: 100,
  121: 100,
  122: 100,
  130: 1000,
  131: 1000,
  132: 1000,
}

export function emulator(options: EmulatorOptions = {}): GrblEmulator {
  return expectOk(
    GrblEmulator.create({ homing: false, ...options, settings: { ...FAST, ...options.settings } }),
  )
}

/** Sends text at the current time and returns the output lines it produced right away. */
export function send(emu: GrblEmulator, text: string): string[] {
  emu.receive(bytes(text))
  return outLines(emu)
}

export function outLines(emu: GrblEmulator): string[] {
  return emu
    .readOutput()
    .split('\r\n')
    .filter((l) => l !== '')
}

/** Runs every pending event (until the machine waits for input). */
export function settle(emu: GrblEmulator, limitMs = 3_600_000): void {
  const end = emu.time + limitMs
  for (let t = emu.nextEventAt(); t !== undefined && t <= end; t = emu.nextEventAt()) {
    emu.advanceTo(t)
  }
}

export function statusOf(emu: GrblEmulator): string {
  const out = send(emu, '?')
  const s = out.find((l) => l.startsWith('<'))
  if (s === undefined) throw new Error(`no status report in ${JSON.stringify(out)}`)
  return s
}

/**
 * Minimal sender over VirtualGrblTransport: character counting against the RX buffer (or
 * send-response), counting `ok`/`error:N` acknowledgements. Time only moves in `runUntil`.
 */
export class TestStreamer {
  readonly clock = new VirtualClock()
  readonly transport: VirtualGrblTransport
  readonly received: string[] = []
  readonly errors: string[] = []
  acked = 0
  private buffer = ''
  private readonly queue: string[] = []
  private readonly inflight: number[] = []
  /** Most bytes ever unacknowledged at once. */
  maxInflight = 0

  constructor(
    readonly emu: GrblEmulator,
    readonly mode: 'charCount' | 'sendResponse' = 'charCount',
  ) {
    this.transport = new VirtualGrblTransport(emu, this.clock)
    this.transport.onData((b) => this.onData(b))
  }

  send(lines: readonly string[]): void {
    this.queue.push(...lines)
    this.fill()
  }

  realtime(byte: number | string): void {
    const b = typeof byte === 'string' ? byte.charCodeAt(0) : byte
    void this.transport.write(Uint8Array.of(b))
  }

  get idle(): boolean {
    return this.queue.length === 0 && this.inflight.length === 0
  }

  get queued(): number {
    return this.queue.length
  }

  /** Advances virtual time event by event until `done()`; false if nothing more is scheduled. */
  runUntil(done: () => boolean, limitMs = 3_600_000): boolean {
    const end = this.clock.now() + limitMs
    while (!done()) {
      const next = this.clock.nextAt()
      if (next === undefined || next > end) return false
      this.clock.advanceTo(next)
    }
    return true
  }

  /** Status report at the current time. */
  status(): string {
    const before = this.received.length
    this.realtime('?')
    const s = this.received.slice(before).find((l) => l.startsWith('<'))
    if (s === undefined) throw new Error('no status report')
    return s
  }

  private fill(): void {
    for (let line = this.queue[0]; line !== undefined; line = this.queue[0]) {
      const n = line.length + 1
      const used = this.inflight.reduce((a, b) => a + b, 0)
      const fits =
        this.mode === 'charCount' ? used + n <= RX_BUFFER_SIZE - 1 : this.inflight.length === 0
      if (!fits) return
      this.queue.shift()
      this.inflight.push(n)
      this.maxInflight = Math.max(this.maxInflight, used + n)
      void this.transport.write(bytes(`${line}\n`))
    }
  }

  private onData(data: Uint8Array): void {
    this.buffer += String.fromCharCode(...data)
    const parts = this.buffer.split('\r\n')
    this.buffer = parts.pop() ?? ''
    for (const l of parts) {
      if (l === '') continue
      this.received.push(l)
      if (l === 'ok' || l.startsWith('error:')) {
        this.inflight.shift()
        this.acked++
        if (l !== 'ok') this.errors.push(l)
      }
    }
    this.fill()
  }
}
