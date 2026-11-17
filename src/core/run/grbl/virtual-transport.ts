/**
 * `ControllerTransport` over the GRBL emulator, driven by a `Clock`.
 * Doc: docs/architecture/grbl.md#transport-and-sender
 *
 * Bytes written are fed to the emulator at the clock's current time; its next internal event
 * is scheduled on the clock. Output is delivered by a clock timer at the current time, never
 * inside `write()` or `onData()`, as over a serial port: a sender that awaits `write()` and
 * then books the line sees the answer afterwards (VirtualClock: on the next advance; a real
 * clock: in a later task).
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
  private cancelEvent: (() => void) | undefined
  private cancelDelivery: (() => void) | undefined
  private closed = false
  private readonly pending: Uint8Array[] = []

  constructor(
    readonly emulator: GrblEmulator,
    private readonly clock: Clock,
  ) {
    // The power-up banner is delivered once a listener is registered.
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
    this.cancelEvent?.()
    this.cancelDelivery?.()
    this.cancelEvent = this.cancelDelivery = undefined
    this.listeners.clear()
    this.pending.length = 0
    return Promise.resolve(Ok(undefined))
  }

  /** Collects output, schedules its delivery and the emulator's next event. */
  private pump(): void {
    if (this.closed) return
    const out = this.emulator.readOutput()
    if (out !== '') this.pending.push(ascii(out))
    this.cancelEvent?.()
    this.cancelEvent = undefined
    const next = this.emulator.nextEventAt()
    if (next !== undefined) {
      this.cancelEvent = this.clock.schedule(next, () => {
        this.cancelEvent = undefined
        this.emulator.advanceTo(this.clock.now())
        this.pump()
      })
    }
    if (this.pending.length > 0 && this.listeners.size > 0 && !this.cancelDelivery) {
      this.cancelDelivery = this.clock.schedule(this.clock.now(), () => this.deliver())
    }
  }

  private deliver(): void {
    this.cancelDelivery = undefined
    const chunks = this.pending.splice(0)
    for (const chunk of chunks) for (const l of [...this.listeners]) l(chunk)
  }
}
