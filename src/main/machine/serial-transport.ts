// `SerialTransport`: the controller byte stream over a serial port (`serialport`, MIT), and
// `nodeSerialPorts`, the machine host's `SerialPorts` (list and open). Loaded only in the machine
// host (utility process or headless worker), and `serialport` only on the first list or open, so a
// virtual connection never loads the native binding.
// Doc: docs/modes/run-machine.md#serial-transport, docs/conventions/packaging.md#native-modules
import { AppError } from '../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { SerialPortInfo, SerialPorts } from '../../core/run/serial'
import type { ControllerTransport } from '../../core/run/transport'

/** The part of `serialport`'s `SerialPortStream` the transport uses (a mock in tests). */
export interface PortStream {
  readonly isOpen: boolean
  open(callback: (err: Error | null) => void): void
  write(data: Buffer, callback: (err: Error | null | undefined) => void): boolean
  drain(callback: (err: Error | null) => void): void
  close(callback: (err: Error | null) => void): void
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'close', listener: (err?: Error & { disconnected?: boolean }) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

const connectionError = (message: string, where: string, data: Record<string, unknown> = {}) =>
  new AppError('machine.connection', message, { where, data })

export class SerialTransport implements ControllerTransport {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  /** We asked to close: the port's `close` event is not a lost connection. */
  private closing = false
  private closed = false

  private constructor(
    private readonly port: PortStream,
    private readonly path: string,
  ) {
    port.on('data', (chunk) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      for (const l of [...this.dataListeners]) l(bytes)
    })
    port.on('close', (err) => this.onPortClosed(err?.message ?? 'the port closed'))
    // an error on an open port (e.g. the device went away) ends it like a close
    port.on('error', (err) => this.onPortClosed(err.message))
  }

  /** Opens `port` (created with `autoOpen: false`); `machine.connection` with the OS message. */
  static async open(port: PortStream, path: string): AsyncAppResult<SerialTransport> {
    const err = await new Promise<Error | null>((resolve) => port.open(resolve))
    if (err !== null)
      return Err(
        connectionError(`cannot open ${path}: ${err.message}`, 'SerialTransport.open', { path }),
      )
    return Ok(new SerialTransport(port, path))
  }

  write(bytes: Uint8Array): AsyncAppResult<void> {
    const where = 'SerialTransport.write'
    if (this.closed || !this.port.isOpen)
      return Promise.resolve(fail('machine.connection', `${this.path} is closed`, { where }))
    return new Promise<AppResult<void>>((resolve) => {
      this.port.write(Buffer.from(bytes), (err) => {
        if (err) return resolve(Err(connectionError(`write failed: ${err.message}`, where)))
        // handed to the OS once drained
        this.port.drain((e) =>
          resolve(
            e === null ? Ok(undefined) : Err(connectionError(`write failed: ${e.message}`, where)),
          ),
        )
      })
    })
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
    if (this.closed) return Ok(undefined)
    this.closing = true
    this.closed = true
    if (!this.port.isOpen) return Ok(undefined)
    // errors closing a port that is already gone do not matter
    await new Promise<void>((resolve) => this.port.close(() => resolve()))
    return Ok(undefined)
  }

  private onPortClosed(reason: string): void {
    if (this.closing) return
    this.closing = this.closed = true
    for (const l of [...this.closeListeners]) l(reason)
  }
}

interface PortInfoLike {
  readonly path: string
  readonly manufacturer?: string | undefined
  readonly serialNumber?: string | undefined
  readonly vendorId?: string | undefined
  readonly productId?: string | undefined
}

/** `serialport`'s port info → ours (`usb`: the OS reports a USB vendor id). */
export function portInfo(p: PortInfoLike): SerialPortInfo {
  const opt = (k: 'manufacturer' | 'serialNumber' | 'vendorId' | 'productId') => {
    const v = p[k]
    return typeof v === 'string' && v !== '' ? { [k]: v.slice(0, k.endsWith('Id') ? 20 : 200) } : {}
  }
  return {
    path: p.path,
    ...opt('manufacturer'),
    ...opt('serialNumber'),
    ...opt('vendorId'),
    ...opt('productId'),
    usb: typeof p.vendorId === 'string' && p.vendorId !== '',
  }
}

/** The port factory and lister over a `serialport`-like module (the real one, or the mock). */
export interface SerialModule {
  list(): Promise<PortInfoLike[]>
  create(path: string, baud: number): PortStream
}

export function serialPortsOf(load: () => Promise<SerialModule>): SerialPorts {
  const loaded = async (where: string): AsyncAppResult<SerialModule> => {
    try {
      return Ok(await load())
    } catch (e) {
      return fail('machine.connection', `serial ports are not available: ${String(e)}`, { where })
    }
  }
  return {
    async list() {
      const where = 'SerialPorts.list'
      const mod = await loaded(where)
      if (mod.isErr()) return Err(mod.unwrapErr())
      try {
        return Ok((await mod.unwrap().list()).map(portInfo))
      } catch (e) {
        return fail('machine.connection', `cannot list serial ports: ${String(e)}`, { where })
      }
    },
    async open(path, baud) {
      const mod = await loaded('SerialPorts.open')
      if (mod.isErr()) return Err(mod.unwrapErr())
      return SerialTransport.open(mod.unwrap().create(path, baud), path)
    },
  }
}

/** Node `serialport`, loaded on first use: 8N1, no flow control (GRBL's defaults). */
export const nodeSerialPorts: SerialPorts = serialPortsOf(async () => {
  const { SerialPort } = await import('serialport')
  return {
    list: () => SerialPort.list(),
    create: (path, baudRate) =>
      new SerialPort({
        path,
        baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        rtscts: false,
        autoOpen: false,
      }) as unknown as PortStream,
  }
})
