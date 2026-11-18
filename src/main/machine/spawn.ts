// Spawning the machine host as a `worker_threads` worker (headless/CLI) and creating the
// `MachineClient` with log forwarding. The Electron utility process is in electron.ts.
// Doc: docs/modes/run-v0.1.md#processes, #logging
import { Worker } from 'node:worker_threads'
import { MachineClient, type MachineHostFactory } from '../../core/run/host/client'
import type { LogLevel, Logger } from '../../shared/logging'
import type { ForwardReceiver } from '../logging/forward'

/** The host in a `worker_threads` worker running `entryPath` (a bundled node-worker entry). */
export function workerHostFactory(entryPath: string): MachineHostFactory {
  return (events) => {
    const worker = new Worker(entryPath, { name: 'machine-host' })
    worker.on('message', (m: unknown) => events.message(m))
    worker.on('error', () => {}) // followed by `exit`
    worker.on('exit', (code) => events.exit(code))
    return {
      post: (message) => worker.postMessage(message),
      terminate: () => void worker.terminate(),
    }
  }
}

export interface MachineClientSetup {
  readonly factory: MachineHostFactory
  readonly log: Logger
  readonly logLevel: LogLevel
  /** Writes the host's forwarded log batches; absent = dropped. */
  readonly forward?: ForwardReceiver
  /** Origin of forwarded entries: `utility` in the app, `worker` headless. */
  readonly proc: 'utility' | 'worker'
}

/** The app instance's one machine connection (`services.machine`). */
export function createMachineClient(o: MachineClientSetup): MachineClient {
  return new MachineClient({
    factory: o.factory,
    log: o.log,
    logLevel: o.logLevel,
    onLog: (batch) =>
      void o.forward?.(
        batch,
        o.proc === 'utility' ? { proc: 'utility' } : { proc: 'worker', worker: 'machine-host' },
      ),
  })
}
