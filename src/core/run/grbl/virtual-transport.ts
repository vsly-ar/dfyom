/**
 * `ControllerTransport` over the GRBL emulator, driven by a `Clock`.
 * Doc: docs/architecture/grbl.md#transport-and-sender
 *
 * Bytes written are fed to the emulator at the clock's current time; its next internal event
 * is scheduled on the clock. Output is delivered to listeners synchronously but never
 * re-entrantly: a listener that writes back sees its answer after it returns.
 */
import { fail, Ok, type AsyncAppResult } from '../../../shared/result'
import type { Clock } from '../clock'
import type { ControllerTransport } from '../transport'
import type { GrblEmulator } from './emulator/emulator'

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

export class VirtualGrblTransport implements ControllerTransport {
  private readonly listeners = new Set<(bytes: Uint8Array) => void>()
  private cancelTimer: (() => void) | undefined
  private closed = false
  private delivering = false
  private readonly pending: Uint8Array[] = []

  constructor(
    readonly emulator: GrblEmulator,
    private readonly clock: Clock,
  ) {
    // The power-up banner is delivered to the first listener.
    this.emulator.advanceTo(clock.now())
  }

  write(bytes: Uint8Array): AsyncAppResult<void> {
    if (this.closed) {
      return Promise.resolve(
        fail('machine.connection', 'virtual machine connection is closed', {
          where: 'VirtualGrblTransport.write',
        }),
      )
    }
    this.emulator.advanceTo(this.clock.now())
    this.emulator.receive(bytes)
    this.pump()
    return Promise.resolve(Ok(undefined))
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    this.pump()
    return () => this.listeners.delete(listener)
  }

  close(): AsyncAppResult<void> {
    this.closed = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.listeners.clear()
    return Promise.resolve(Ok(undefined))
  }

  /** Delivers output and schedules the emulator's next event. */
  private pump(): void {
    if (this.closed) return
    this.cancelTimer?.()
    this.cancelTimer = undefined
    const out = this.emulator.readOutput()
    if (out !== '') this.pending.push(ascii(out))
    const next = this.emulator.nextEventAt()
    if (next !== undefined) {
      this.cancelTimer = this.clock.schedule(next, () => {
        this.cancelTimer = undefined
        this.emulator.advanceTo(this.clock.now())
        this.pump()
      })
    }
    if (this.delivering || this.listeners.size === 0) return
    this.delivering = true
    try {
      for (let chunk = this.pending.shift(); chunk; chunk = this.pending.shift()) {
        for (const l of [...this.listeners]) l(chunk)
      }
    } finally {
      this.delivering = false
    }
  }
}
