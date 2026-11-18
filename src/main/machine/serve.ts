// Shared by the machine host entries: runs the environment-neutral host on an `Endpoint` with the
// process's timers and handles uncaught errors (docs/conventions/logging.md: the utility process
// logs `fatal` and exits, main then fails the run with `machine.connection`; a worker thread logs
// `error` and keeps running). Doc: docs/modes/run-v0.1.md#processes
import { systemTimerHost } from '../../core/run/clock'
import { runMachineHost, type MachineHost } from '../../core/run/host/host'
import type { Endpoint } from '../../core/workers/protocol'
import { serializeErr } from '../../shared/logging'

export function serveMachineHost(
  endpoint: Endpoint,
  proc: 'utility' | 'worker',
  exit: (code: number) => void,
): MachineHost {
  const host = runMachineHost(endpoint, {
    timers: systemTimerHost,
    proc,
    // after `disconnect` the transport is closed: end the process (main spawns a fresh one)
    onDisconnected: () => setTimeout(() => exit(0), 0),
  })
  const uncaught = (kind: string) => (err: unknown) => {
    const fields = { err: serializeErr(err), scope: 'run.host' }
    if (proc === 'worker') {
      host.log().error(fields, `${kind} in machine host`)
      return
    }
    host.log().fatal(fields, `${kind} in machine host`)
    // let the forwarder's batch go out before the process ends
    setTimeout(() => exit(1), 50)
  }
  process.on('uncaughtException', uncaught('uncaught exception'))
  process.on('unhandledRejection', uncaught('unhandled rejection'))
  return host
}
