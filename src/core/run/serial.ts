/**
 * The serial-port port of the machine host: listing ports and opening one as a
 * `ControllerTransport`. Injected by the host entries (`src/main/machine/serve.ts`: Node
 * `serialport`) or by tests (a loopback over the emulator), so core stays headless.
 * Doc: docs/modes/run-machine.md#serial-transport, #ports-and-the-port-picker
 */
import { z } from 'zod'
import type { AsyncAppResult } from '../../shared/result'
import type { ControllerTransport } from './transport'

/** GRBL 1.1's default baud rate. */
export const DEFAULT_BAUD = 115_200

/** Baud rates the port picker offers (the default first). */
export const BAUD_RATES = [115_200, 250_000, 230_400, 57_600, 38_400, 19_200, 9_600] as const

export const SerialPortInfoSchema = z.object({
  path: z.string().max(500),
  manufacturer: z.string().max(200).exactOptional(),
  serialNumber: z.string().max(200).exactOptional(),
  vendorId: z.string().max(20).exactOptional(),
  productId: z.string().max(20).exactOptional(),
  /** The OS reports a USB vendor id: a controller is usually one of these. */
  usb: z.boolean(),
})
export type SerialPortInfo = z.output<typeof SerialPortInfoSchema>

export interface SerialPorts {
  /** The ports the OS reports, USB ports first (`sortPorts`). */
  list(): AsyncAppResult<SerialPortInfo[]>
  /** Opens `path` at `baud` (8N1, no flow control); `machine.connection` on failure. */
  open(path: string, baud: number): AsyncAppResult<ControllerTransport>
}

/** USB ports first, then by path. */
export function sortPorts(ports: readonly SerialPortInfo[]): SerialPortInfo[] {
  return [...ports].sort((a, b) =>
    a.usb === b.usb ? a.path.localeCompare(b.path) : a.usb ? -1 : 1,
  )
}
