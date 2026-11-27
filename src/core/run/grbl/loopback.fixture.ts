// Test-only loopback serial ports: a `SerialPorts` whose ports are GRBL emulators behind a byte
// stream that behaves like a USB serial line (asynchronous delivery, a delayed or missing banner,
// unplugging and plugging back in, DF129). Exercises the real-machine path (serial target, handshake, settings check, silent
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

/** DF129: how a port's cable comes back (docs/modes/run-recovery.md#testing). */
export interface ReplugOptions {
  /** After this long on the timers (default 0: at once). */
  readonly afterMs?: number
  /** Under another path (the OS re-enumerated the device), with the same USB serial number. */
  readonly path?: string
}

/** The fixture's side of a port's cable (DF129). */
interface Cable {
  unplugged(controllerRuns: boolean): void
  replug(opts: ReplugOptions): void
}

export class LoopbackPort implements ControllerTransport {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private readonly held: Uint8Array[] = []
  private holding: boolean
  private muted: boolean
  private closed = false
  private unplugged = false
  /** Every byte DFYOM wrote, in order. */
  readonly written: number[] = []

  constructor(
    readonly emulator: GrblEmulator,
    private readonly inner: VirtualGrblTransport,
    private readonly clock: ScaledClock,
    timers: TimerHost,
    opts: LoopbackOptions,
    private readonly cable?: Cable,
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
    // an unplugged controller keeps its clock: it runs on, and a replug reaches it (DF129)
    if (!this.unplugged) this.clock.dispose()
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

  /**
   * The cable is pulled: the port reports `close` and leaves the port list. `controllerRuns`
   * (default true, a board powered by the machine): the emulator runs out what it received on the
   * port's clock; false (a board powered by USB only): it stops at once, as at power-off (DF129).
   */
  unplug(opts: { readonly controllerRuns?: boolean } = {}): void {
    if (this.closed) return
    this.closed = true
    this.unplugged = true
    for (const l of [...this.closeListeners]) l('device disconnected')
    void this.inner.close()
    this.cable?.unplugged(opts.controllerRuns ?? true)
  }

  /**
   * DF129: the cable comes back (after `unplug`): the port is listed again, at its path or `path`,
   * with the same USB serial number; opening it reaches the same controller, reset by DTR
   * (`GrblEmulator.powerCycle`: G54 kept, start-up lock).
   */
  replug(opts: ReplugOptions = {}): void {
    this.cable?.replug(opts)
  }

  private deliver(bytes: Uint8Array): void {
    if (this.closed) return
    for (const l of [...this.dataListeners]) l(bytes)
  }
}

/** The USB serial number of loopback port `i` (DF129: reconnecting by serial number). */
export const loopbackSerialNumber = (i: number): string =>
  `LOOPBACK${String(i + 1).padStart(4, '0')}`

/** A listed port: its USB identity, and the controller a replugged cable brings back. */
interface Listed {
  info: SerialPortInfo
  /** Set after a replug: the controller behind the cable, with its clock. */
  carried?: { readonly emulator: GrblEmulator; readonly clock: ScaledClock } | undefined
}

/**
 * Ports `paths` (USB, each with its own serial number), each opening a fresh emulator on the given
 * wall timers (1× by default); a replugged port opens the controller it had (DF129).
 */
export function loopbackSerialPorts(
  timers: TimerHost,
  opts: LoopbackOptions = {},
  paths: readonly string[] = ['/dev/cu.usbmodem1101'],
): SerialPorts & { readonly opened: LoopbackPort[] } {
  const opened: LoopbackPort[] = []
  const listed: Listed[] = paths.map((path, i) => ({
    info: {
      path,
      manufacturer: 'Arduino (www.arduino.cc)',
      serialNumber: loopbackSerialNumber(i),
      vendorId: '2341',
      productId: '0043',
      usb: true,
    },
  }))
  const cable = (entry: Listed, emu: GrblEmulator, clock: ScaledClock): Cable => ({
    unplugged(controllerRuns) {
      const i = listed.indexOf(entry)
      if (i >= 0) listed.splice(i, 1)
      // a board powered by USB only stops with the cable; one powered by the machine runs on
      if (!controllerRuns) {
        emu.advanceTo(clock.now())
        emu.powerCycle()
      }
    },
    replug(o) {
      const back = () => {
        if (listed.includes(entry)) return
        entry.info = { ...entry.info, path: o.path ?? entry.info.path }
        entry.carried = { emulator: emu, clock }
        listed.push(entry)
      }
      if ((o.afterMs ?? 0) <= 0) back()
      else timers.setTimeout(back, o.afterMs ?? 0)
    },
  })
  return {
    opened,
    list: () =>
      Promise.resolve(
        Ok(
          sortPorts([
            ...listed.map((l) => ({ ...l.info })),
            { path: '/dev/tty.Bluetooth-Incoming-Port', usb: false },
          ]),
        ),
      ),
    open(path) {
      const where = 'loopbackSerialPorts.open'
      const entry = listed.find((l) => l.info.path === path)
      if (entry === undefined)
        return Promise.resolve(
          fail('machine.connection', `cannot open ${path}: no such port`, { where }),
        )
      if (opts.openError !== undefined)
        return Promise.resolve(
          fail('machine.connection', `cannot open ${path}: ${opts.openError}`, { where }),
        )
      let emu: GrblEmulator
      let clock: ScaledClock
      if (entry.carried !== undefined) {
        // the same controller: it ran on (or not) meanwhile; opening resets it through DTR
        ;({ emulator: emu, clock } = entry.carried)
        entry.carried = undefined
        emu.advanceTo(clock.now())
        emu.powerCycle()
      } else {
        const created = GrblEmulator.create({ trace: false, silentHoming: true, ...opts.emulator })
        if (created.isErr())
          return Promise.resolve(fail('internal.unexpected', 'emulator', { where }))
        emu = created.unwrap()
        clock = new ScaledClock(timers, { scale: opts.timeScale ?? 1 })
      }
      const inner = new VirtualGrblTransport(emu, clock)
      clock.setBusy(() => emu.nextEventAt() !== undefined)
      const port = new LoopbackPort(emu, inner, clock, timers, opts, cable(entry, emu, clock))
      opened.push(port)
      return Promise.resolve(Ok(port))
    },
  }
}
