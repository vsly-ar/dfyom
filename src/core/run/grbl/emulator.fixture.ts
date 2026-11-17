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

/** DFYOM tool-change marker, matched against a whole line (grbl.md#output-dialect). */
const MARKER = /^\(DFYOM TOOL CHANGE (\d+): ([^()]*)\)$/

export interface StreamerOptions {
  readonly mode?: 'charCount' | 'sendResponse'
  /** Stop sending and feed-hold on the first `error:N`, as GrblSender will. */
  readonly stopOnError?: boolean
  /**
   * `dfyom`: apply the tool-change rule (stop before a marker line followed by exactly `M0`,
   * wait for `resumeToolChange()`, send the marker, skip the `M0`). Default `pause`: stream as
   * other senders do and let GRBL pause at `M0`.
   */
  readonly toolChange?: 'dfyom' | 'pause'
}

/**
 * Minimal sender over VirtualGrblTransport: character counting against the RX buffer (or
 * send-response), counting `ok`/`error:N` acknowledgements. Time only moves in `runUntil`
 * (responses are delivered on the clock too).
 */
export class TestStreamer {
  readonly clock = new VirtualClock()
  readonly transport: VirtualGrblTransport
  readonly received: string[] = []
  readonly errors: string[] = []
  acked = 0
  /** Most bytes ever unacknowledged at once. */
  maxInflight = 0
  /** Set while the DFYOM tool-change rule holds the stream. */
  toolChange: { readonly tool: number; readonly name: string } | undefined
  stopped = false
  private buffer = ''
  private readonly queue: string[] = []
  private head = 0
  private readonly urgent: string[] = []
  private readonly inflight: number[] = []
  private inHead = 0
  private used = 0
  private readonly mode: 'charCount' | 'sendResponse'

  constructor(
    readonly emu: GrblEmulator,
    private readonly options: StreamerOptions = {},
  ) {
    this.mode = options.mode ?? 'charCount'
    this.transport = new VirtualGrblTransport(emu, this.clock)
    this.transport.onData((b) => this.onData(b))
  }

  send(lines: readonly string[]): void {
    for (const l of lines) this.queue.push(l)
    this.fill()
  }

  /** Lines sent ahead of the program, also while a tool change holds it (jog, zeroing). */
  manual(lines: readonly string[]): void {
    for (const l of lines) this.urgent.push(l)
    this.fill()
  }

  /** Ends the guided tool change: sends the marker line, skips its `M0`, continues. */
  resumeToolChange(): void {
    const marker = this.queue[this.head]
    if (this.toolChange === undefined || marker === undefined) return
    this.toolChange = undefined
    this.head += 2
    this.urgent.push(marker)
    this.fill()
  }

  realtime(byte: number | string): void {
    const b = typeof byte === 'string' ? byte.charCodeAt(0) : byte
    void this.transport.write(Uint8Array.of(b))
  }

  get inflightLines(): number {
    return this.inflight.length - this.inHead
  }

  get idle(): boolean {
    return this.head >= this.queue.length && this.urgent.length === 0 && this.inflightLines === 0
  }

  /** The tool-change rule holds the stream and the machine has finished everything before it. */
  get toolChangeReady(): boolean {
    return (
      this.toolChange !== undefined &&
      this.urgent.length === 0 &&
      this.inflightLines === 0 &&
      this.emu.status().state === 'Idle'
    )
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
    this.clock.advance(0)
    const s = this.received.slice(before).find((l) => l.startsWith('<'))
    if (s === undefined) throw new Error('no status report')
    return s
  }

  private next(): string | undefined {
    if (this.urgent.length > 0) return this.urgent[0]
    if (this.toolChange !== undefined) return undefined
    const line = this.queue[this.head]
    if (line === undefined) return undefined
    const m = this.options.toolChange === 'dfyom' ? MARKER.exec(line) : null
    if (m && this.queue[this.head + 1] === 'M0') {
      this.toolChange = { tool: Number(m[1]), name: m[2] ?? '' }
      return undefined
    }
    return line
  }

  private fill(): void {
    if (this.stopped) return
    for (let line = this.next(); line !== undefined; line = this.next()) {
      const n = line.length + 1
      const fits =
        this.mode === 'charCount' ? this.used + n <= RX_BUFFER_SIZE : this.inflightLines === 0
      if (!fits) return
      if (this.urgent.length > 0) this.urgent.shift()
      else this.head++
      this.inflight.push(n)
      this.used += n
      this.maxInflight = Math.max(this.maxInflight, this.used)
      void this.transport.write(bytes(`${line}\n`))
    }
  }

  private onData(data: Uint8Array): void {
    let text = this.buffer
    for (const b of data) text += String.fromCharCode(b)
    const parts = text.split('\r\n')
    this.buffer = parts.pop() ?? ''
    for (const l of parts) {
      if (l === '') continue
      this.received.push(l)
      if (l === 'ok' || l.startsWith('error:')) {
        this.used -= this.inflight[this.inHead] ?? 0
        this.inHead++
        this.acked++
        if (l !== 'ok') {
          this.errors.push(l)
          if (this.options.stopOnError && !this.stopped) {
            this.stopped = true
            this.realtime('!')
          }
        }
      }
    }
    this.fill()
  }
}
