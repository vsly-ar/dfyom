/**
 * Byte-stream port to a controller, the same for the serial port and the virtual machine.
 * Doc: docs/architecture/grbl.md#transport-and-sender
 */
import type { AsyncAppResult } from '../../shared/result'

export interface ControllerTransport {
  write(bytes: Uint8Array): AsyncAppResult<void>
  /** Registers a listener for received bytes; returns the unsubscribe function. */
  onData(listener: (bytes: Uint8Array) => void): () => void
  close(): AsyncAppResult<void>
  /**
   * Serial only: registers a listener for the port closing without being asked (cable pulled,
   * board unpowered); returns the unsubscribe function. Doc: docs/modes/run-machine.md#serial-transport
   */
  onClose?(listener: (reason: string) => void): () => void
}
