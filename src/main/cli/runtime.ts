/**
 * The headless runtime of `dfyom mcp`, `dfyom batch` and one-shot calls: CLI logging, the
 * compute pool, the machine host (`worker_threads`), the export port and the app host.
 * Doc: docs/architecture/llm-api.md#processes-and-hosting, docs/modes/run-v0.1.md#processes
 *
 * No Electron import (decision 15): run by `node` in tests and by the app's binary with
 * `ELECTRON_RUN_AS_NODE` when packaged.
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { version } from '../../../package.json'
import {
  createLogReporter,
  LOG_LEVEL_ENV,
  resolveLogLevel,
  type Logger,
} from '../../shared/logging'
import type { ErrorReporter } from '../../shared/boundary'
import { Err, Ok, type AsyncAppResult } from '../../shared/result'
import type { MachineClient } from '../../core/run/host/client'
import { createAppHost, type AppHost } from '../host/app-host'
import { createForwardReceiver } from '../logging/forward'
import {
  createMainLogging,
  createStderrLogging,
  installCrashHandlers,
  type MainLogging,
} from '../logging/logger'
import { createMachineClient, workerHostFactory } from '../machine/spawn'
import { createExportFiles } from '../persistence/export-file'
import { createNodeWorkerPool } from '../workers/node'

export const APP_VERSION: string = version

/** Bundled entry files of the workers (`?modulePath` in the build, temp bundles in tests). */
export interface WorkerEntries {
  readonly worker: string
  readonly machine: string
}

export interface HeadlessOptions {
  readonly dataDir: string
  readonly entries: WorkerEntries
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  /** Exits the process on an uncaught error (after logging it at `fatal`). */
  readonly exit: (code: number) => void
}

export interface Headless {
  readonly host: AppHost
  readonly log: Logger
  readonly report: ErrorReporter
  readonly machine: MachineClient
  /** Abort jobs, close projects (unsaved stays recoverable), stop the machine host and workers, flush logs. */
  shutdown(): Promise<void>
}

/** CLI logging: `<data-dir>/logs/`, origin `cli`, a `warn`+ copy on stderr (never stdout). */
export async function startCliLogging(
  dataDir: string,
  o: Pick<HeadlessOptions, 'argv' | 'env'>,
): Promise<{ logging: MainLogging; instance: string; level: ReturnType<typeof resolveLogLevel> }> {
  const level = resolveLogLevel({ env: o.env[LOG_LEVEL_ENV], argv: o.argv, isDev: false })
  const instance = randomUUID()
  const common = { level: level.level, instance, app: APP_VERSION, proc: 'cli' }
  let logging: MainLogging
  try {
    await mkdir(join(dataDir, 'logs'), { recursive: true })
    logging = await createMainLogging({
      ...common,
      dir: join(dataDir, 'logs'),
      extraStream: pino.destination({ fd: 2, sync: true }),
      extraLevel: 'warn',
    })
  } catch {
    logging = createStderrLogging({ ...common, level: 'warn' })
  }
  return { logging, instance, level }
}

export async function startHeadless(o: HeadlessOptions): AsyncAppResult<Headless> {
  const { logging, instance, level } = await startCliLogging(o.dataDir, o)
  const { log } = logging
  installCrashHandlers(logging, o.exit)
  if (level.ignored.length > 0)
    log.warn({ ignored: level.ignored }, 'invalid log level override ignored')
  const report = createLogReporter(log.child({ scope: 'boundary' }))
  const forward = createForwardReceiver(logging, report)
  const workers = createNodeWorkerPool({
    entryPath: o.entries.worker,
    log,
    logLevel: level.level,
    forward,
  })
  const machine = createMachineClient({
    factory: workerHostFactory(o.entries.machine),
    log,
    logLevel: level.level,
    forward,
    proc: 'worker',
  })
  const host = await createAppHost({
    appData: o.dataDir,
    appVersion: APP_VERSION,
    instanceId: instance,
    log,
    report,
    workers,
    machine,
    exportFiles: createExportFiles(),
  })
  if (host.isErr()) {
    workers.terminate()
    machine.close()
    logging.flushSync()
    return Err(host.unwrapErr())
  }
  log.info({ dataDir: o.dataDir, logLevel: level.level }, 'headless instance started')
  let down: Promise<void> | undefined
  return Ok({
    host: host.unwrap(),
    log,
    report,
    machine,
    shutdown: () =>
      (down ??= (async () => {
        await host.unwrap().shutdown()
        // The host stops a running job under control (hold, reset), then disconnects.
        await machine.shutdown(3000)
        workers.terminate()
        log.info('headless instance stopped')
        logging.flushSync()
      })()),
  })
}
