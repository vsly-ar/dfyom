// Electron wiring of main-process logging: folder, level, dev pretty output, renderer IPC.
// Doc: docs/conventions/logging.md
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import type pino from 'pino'
import type { ErrorReporter } from '../../shared/boundary'
import {
  createLogReporter,
  LOG_IPC_CHANNEL,
  LOG_LEVEL_ENV,
  resolveLogLevel,
  type LogLevel,
  type Logger,
} from '../../shared/logging'
import { createForwardReceiver, type ForwardReceiver } from './forward'
import { createMainLogging, createStderrLogging, installCrashHandlers } from './logger'

export interface AppLogging {
  readonly log: Logger
  /** Boundary reporter for main-process entry points (logs once at the code's severity). */
  readonly report: ErrorReporter
  /** Instance level; passed to renderers so they forward the same entries. */
  readonly level: LogLevel
  readonly instance: string
  /** Writes batches forwarded by other threads/processes (compute workers). */
  readonly forward: ForwardReceiver
}

/** pino-pretty (dev dependency) on stderr; only loaded in unpackaged runs. */
async function prettyStream(): Promise<pino.DestinationStream> {
  const { default: pretty } = await import('pino-pretty')
  return pretty({ destination: 2, colorize: true, sync: true })
}

export async function startLogging(): Promise<AppLogging> {
  const isDev = !app.isPackaged
  const { level, ignored } = resolveLogLevel({
    env: process.env[LOG_LEVEL_ENV],
    argv: process.argv,
    isDev,
  })
  const instance = randomUUID()
  const common = { level, instance, app: app.getVersion(), proc: 'main' }

  let extraStream: pino.DestinationStream | undefined
  if (isDev) extraStream = await prettyStream().catch(() => undefined)

  let logging
  let sinkError: unknown
  try {
    logging = await createMainLogging({
      ...common,
      dir: app.getPath('logs'),
      ...(extraStream === undefined ? {} : { extraStream }),
    })
  } catch (e) {
    sinkError = e
    logging = createStderrLogging(common)
  }
  const { log } = logging
  installCrashHandlers(logging, (code) => app.exit(code))

  const report = createLogReporter(log.child({ scope: 'boundary' }))
  const receive = createForwardReceiver(logging, report)
  ipcMain.on(LOG_IPC_CHANNEL, (event, batch: unknown) => {
    // Only a window's main frame may log (no subframes, no navigated-away frames).
    const frame = event.senderFrame
    const main = event.sender.mainFrame
    if (frame === null || frame.processId !== main.processId || frame.routingId !== main.routingId)
      return
    const win = BrowserWindow.fromWebContents(event.sender)?.id
    if (win === undefined) return
    void receive(batch, { proc: 'renderer', win })
  })

  app.on('will-quit', () => {
    log.info('app stopping')
    logging.flushSync()
  })

  const self = log.child({ scope: 'logging' })
  if (sinkError !== undefined) self.error({ err: sinkError }, 'log file could not be opened')
  if (ignored.length > 0) self.warn({ ignored }, 'invalid log level override ignored')
  log.info({ logLevel: level, file: logging.file(), packaged: !isDev }, 'app started')

  return { log, report, level, instance, forward: receive }
}
