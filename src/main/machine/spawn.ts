// Spawning the machine host as a `worker_threads` worker (headless/CLI) and creating the
// `MachineClient` with log forwarding. The Electron utility process is in electron.ts.
// Doc: docs/modes/run-v0.1.md#processes, #logging
import { Worker } from 'node:worker_threads'
import { MachineClient, type MachineHostFactory } from '../../core/run/host/client'
import type { LogLevel, Logger } from '../../shared/logging'
import type { ForwardReceiver } from '../logging/forward'
import type { RunJournalPort } from '../../core/run/journal'
import { sha256 } from '../persistence/run-journal'

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
  /** DF129: the run journal of real runs (docs/modes/run-recovery.md#what-dfyom-keeps). */
  readonly journal?: RunJournalPort
  /** DF129: keeps the computer awake during real runs (the app's power-save blocker). */
  readonly keepAwake?: (on: boolean) => void
}

/** The app instance's one machine connection (`services.machine`). */
export function createMachineClient(o: MachineClientSetup): MachineClient {
  return new MachineClient({
    factory: o.factory,
    log: o.log,
    logLevel: o.logLevel,
    ...(o.journal === undefined ? {} : { journal: o.journal, hashProgram: sha256 }),
    ...(o.keepAwake === undefined ? {} : { keepAwake: o.keepAwake }),
    onLog: (batch) =>
      void o.forward?.(
        batch,
        o.proc === 'utility' ? { proc: 'utility' } : { proc: 'worker', worker: 'machine-host' },
      ),
  })
}
