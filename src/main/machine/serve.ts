// Shared by the machine host entries: runs the environment-neutral host on an `Endpoint` with the
// process's timers and handles uncaught errors: logged `fatal`, then the process or thread exits
// and main fails the run with `machine.connection`. Serial ports through `nodeSerialPorts`.
// Doc: docs/modes/run-v0.1.md#processes, docs/modes/run-machine.md#serial-transport
import { systemTimerHost } from '../../core/run/clock'
import { runMachineHost, type MachineHost } from '../../core/run/host/host'
import type { Endpoint } from '../../core/workers/protocol'
import { serializeErr, type Logger } from '../../shared/logging'
import type { SerialPorts } from '../../core/run/serial'
import { loopbackSerialPorts } from '../../core/run/grbl/loopback.fixture'
import { nodeSerialPorts } from './serial-transport'

/**
 * The host's serial ports: Node `serialport`, or with `DFYOM_LOOPBACK_SERIAL=1` (end-to-end tests
 * and review renders only) one loopback port to a GRBL emulator with its default settings, so the
 * serial path runs in the real app without hardware and without the OS's device names.
 * Doc: docs/modes/run-machine.md#testing
 */
function serialPorts(): SerialPorts {
  return process.env['DFYOM_LOOPBACK_SERIAL'] === '1'
    ? loopbackSerialPorts(systemTimerHost, { bannerDelayMs: 300 })
    : nodeSerialPorts
}

export function serveMachineHost(
  endpoint: Endpoint,
  proc: 'utility' | 'worker',
  exit: (code: number) => void,
): MachineHost {
  const host = runMachineHost(endpoint, {
    timers: systemTimerHost,
    proc,
    // real controllers (docs/modes/run-machine.md#serial-transport); serialport loads on first use
    serial: serialPorts(),
    // after `disconnect` the transport is closed: end the process (main spawns a fresh one)
    onDisconnected: () => setTimeout(() => exit(0), 0),
  })
  process.on('uncaughtException', uncaughtHandler(host.log, proc, exit, 'uncaught exception'))
  process.on('unhandledRejection', uncaughtHandler(host.log, proc, exit, 'unhandled rejection'))
  return host
}

/**
 * An uncaught error leaves the controller connection in an unknown state, in a utility process
 * and in a worker thread alike: log `fatal` and end, so main fails the run with
 * `machine.connection` and the next connect starts a fresh host.
 */
export function uncaughtHandler(
  log: () => Logger,
  proc: 'utility' | 'worker',
  exit: (code: number) => void,
  kind: string,
): (err: unknown) => void {
  return (err) => {
    log().fatal({ err: serializeErr(err), scope: 'run.host', proc }, `${kind} in machine host`)
    // let the forwarder's batch go out before the process ends
    setTimeout(() => exit(1), 50)
  }
}
