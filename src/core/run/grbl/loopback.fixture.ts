// Test-only loopback serial ports: a `SerialPorts` whose ports are GRBL emulators behind a byte
// stream that behaves like a USB serial line (asynchronous delivery, a delayed or missing banner,
// unplugging). Exercises the real-machine path (serial target, handshake, settings check, silent
// homing, port closed) without hardware. Not app code. Doc: docs/modes/run-machine.md#testing
import { fail, Ok, type AsyncAppResult } from '../../../shared/result'
import { ScaledClock, type TimeScale, type TimerHost } from '../clock'
import { sortPorts, type SerialPortInfo, type SerialPorts } from '../serial'
import type { ControllerTransport } from '../transport'
import { GrblEmulator, type EmulatorOptions } from './emulator/emulator'
import { VirtualGrblTransport } from './virtual-transport'

export interface LoopbackOptions {
  /** Emulator options; `silentHoming` defaults to true (GRBL-exact) here. */
  readonly emulator?: EmulatorOptions
  /** Output held back for this long after opening (an Arduino's bootloader after DTR reset). */
  readonly bannerDelayMs?: number
  /** The board does not reset on open: nothing arrives until DFYOM sends `0x18`. */
  readonly silentUntilReset?: boolean
  /** Opening fails with this OS message (e.g. "Resource busy"). */
  readonly openError?: string
  /** The controller's clock against the timers (default 1: real time; tests: faster). */
  readonly timeScale?: TimeScale
}

export class LoopbackPort implements ControllerTransport {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private readonly held: Uint8Array[] = []
  private holding: boolean
  private muted: boolean
  private closed = false
  /** Every byte DFYOM wrote, in order. */
  readonly written: number[] = []

  constructor(
    readonly emulator: GrblEmulator,
    private readonly inner: VirtualGrblTransport,
    private readonly clock: ScaledClock,
    timers: TimerHost,
    opts: LoopbackOptions,
  ) {
    this.muted = opts.silentUntilReset === true
    this.holding = (opts.bannerDelayMs ?? 0) > 0
    if (this.holding)
      timers.setTimeout(() => {
        this.holding = false
        for (const b of this.held.splice(0)) this.deliver(b)
      }, opts.bannerDelayMs ?? 0)
    inner.onData((bytes) => {
      if (this.muted) return
      if (this.holding) this.held.push(bytes)
      else this.deliver(bytes)
    })
  }

  write(bytes: Uint8Array): AsyncAppResult<void> {
    if (this.closed)
      return Promise.resolve(fail('machine.connection', 'port closed', { where: 'LoopbackPort' }))
    this.written.push(...bytes)
    if (bytes.includes(0x18)) this.muted = false
    return this.inner.write(bytes)
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): AsyncAppResult<void> {
    this.closed = true
    this.clock.dispose()
    return this.inner.close()
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * The machine's own hold or cycle-start button, or its safety door (`open`), at the current time
   * (DF82: holds DFYOM did not send).
   */
  press(button: 'feedHold' | 'cycleStart'): void {
    this.inner.controllerSide((e) => e.pressButton(button))
  }

  door(open: boolean): void {
    this.inner.controllerSide((e) => e.setDoorPin(open))
  }

  /** The controller's clock against the timers from now on (e.g. 1 to catch a move in Run). */
  setTimeScale(scale: TimeScale): void {
    this.clock.setScale(scale)
  }

  /** The cable is pulled: the port reports `close`; the emulator (the controller) runs on. */
  unplug(): void {
    if (this.closed) return
    this.closed = true
    for (const l of [...this.closeListeners]) l('device disconnected')
    void this.inner.close()
  }

  private deliver(bytes: Uint8Array): void {
    if (this.closed) return
    for (const l of [...this.dataListeners]) l(bytes)
  }
}

/** Ports `paths` (USB), each opening a fresh emulator on the given wall timers (1× by default). */
export function loopbackSerialPorts(
  timers: TimerHost,
  opts: LoopbackOptions = {},
  paths: readonly string[] = ['/dev/cu.usbmodem1101'],
): SerialPorts & { readonly opened: LoopbackPort[] } {
  const opened: LoopbackPort[] = []
  const infos: SerialPortInfo[] = paths.map((path) => ({
    path,
    manufacturer: 'Arduino (www.arduino.cc)',
    vendorId: '2341',
    productId: '0043',
    usb: true,
  }))
  return {
    opened,
    list: () =>
      Promise.resolve(
        Ok(sortPorts([...infos, { path: '/dev/tty.Bluetooth-Incoming-Port', usb: false }])),
      ),
    open(path) {
      const where = 'loopbackSerialPorts.open'
      if (!paths.includes(path))
        return Promise.resolve(
          fail('machine.connection', `cannot open ${path}: no such port`, { where }),
        )
      if (opts.openError !== undefined)
        return Promise.resolve(
          fail('machine.connection', `cannot open ${path}: ${opts.openError}`, { where }),
        )
      const created = GrblEmulator.create({ trace: false, silentHoming: true, ...opts.emulator })
      if (created.isErr())
        return Promise.resolve(fail('internal.unexpected', 'emulator', { where }))
      const clock = new ScaledClock(timers, { scale: opts.timeScale ?? 1 })
      const emu = created.unwrap()
      const inner = new VirtualGrblTransport(emu, clock)
      clock.setBusy(() => emu.nextEventAt() !== undefined)
      const port = new LoopbackPort(emu, inner, clock, timers, opts)
      opened.push(port)
      return Promise.resolve(Ok(port))
    },
  }
}
