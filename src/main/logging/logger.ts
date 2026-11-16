// Root pino logger of the writing process (main, later CLI/headless): file sink, rotation,
// retention, redaction, crash hooks. Doc: docs/conventions/logging.md
// No Electron import here: the folder and flags are passed in, so headless/CLI reuse it.
import { join } from 'node:path'
import pino from 'pino'
import pinoRoll, { type RollStream } from 'pino-roll'
import { AppError } from '../../shared/errors/app-error'
import { serializeErr, type LogLevel, type Logger } from '../../shared/logging'
import { cleanupLogs, LOG_RETENTION, type RetentionResult } from './retention'

/** Keys censored anywhere from the top level to 3 levels deep. */
export const REDACT_KEYS = ['token', 'password', 'secret', 'authorization', 'cookie', 'apiKey']
export const REDACT_CENSOR = '[redacted]'

export function redactPaths(keys: readonly string[] = REDACT_KEYS, depth = 3): string[] {
  const paths: string[] = []
  for (let d = 0; d <= depth; d++)
    for (const k of keys) paths.push([...Array(d).fill('*'), k].join('.'))
  return paths
}

/** pino options shared by every pino logger that writes or pretty-prints in this process. */
export function rootPinoOptions(base: {
  level: LogLevel
  instance: string
  app: string
}): pino.LoggerOptions {
  return {
    level: base.level,
    base: { pid: process.pid, instance: base.instance, app: base.app },
    serializers: { err: (e: unknown) => serializeErr(e, pino.stdSerializers.err) },
    redact: { paths: redactPaths(), censor: REDACT_CENSOR },
  }
}

/** `2026-11-16T10:20:30.123Z` → `2026-11-16T10-20-30Z` (safe on every file system). */
export function fileStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-')
}

export interface MainLoggerOptions {
  readonly dir: string
  readonly level: LogLevel
  readonly instance: string
  readonly app: string
  /** Root `proc` binding: `main`, later `cli`. */
  readonly proc: string
  readonly startedAt?: Date
  /** Extra stream for terminal output (pino-pretty on stderr in dev). Never stdout. */
  readonly extraStream?: pino.DestinationStream
  readonly rotateBytes?: number
}

export interface MainLogging {
  /** Root logger with `proc` bound. */
  readonly log: Logger
  /** Logger without `proc`, for writing forwarded entries (they bring their own `proc`). */
  readonly base: pino.Logger
  /** Current file. */
  file(): string
  /** Synchronously flush buffered lines (before exit). */
  flushSync(): void
  close(): Promise<void>
}

/** Cleans the folder, opens `<startedAt>-<instance>.<n>.log`, returns the root logger. */
export async function createMainLogging(options: MainLoggerOptions): Promise<MainLogging> {
  const startedAt = options.startedAt ?? new Date()
  const startup = await cleanupLogs({ dir: options.dir, now: startedAt.getTime() })

  const stream: RollStream = await pinoRoll({
    file: join(options.dir, `${fileStamp(startedAt)}-${options.instance}`),
    extension: '.log',
    size: `${options.rotateBytes ?? LOG_RETENTION.rotateBytes}b`,
    mkdir: true,
  })

  const opts = rootPinoOptions(options)
  const destination =
    options.extraStream === undefined
      ? stream
      : pino.multistream([
          { stream, level: options.level },
          { stream: options.extraStream, level: options.level },
        ])
  const base = pino(opts, destination)
  const log = base.child({ proc: options.proc })
  const self = log.child({ scope: 'logging' })

  const reportCleanup = (r: RetentionResult): void => {
    if (r.deleted.length > 0) self.debug({ count: r.deleted.length }, 'old log files deleted')
    if (r.failed.length > 0) self.warn({ failed: r.failed }, 'log cleanup failed')
  }
  reportCleanup(startup)

  // SonicBoom opens asynchronously and emits 'ready' on open and after each reopen (= rotation).
  if (!stream.file) {
    await new Promise<void>((resolve, reject) => {
      stream.once('ready', resolve)
      stream.once('error', reject)
    })
  }
  stream.on('ready', () => {
    void cleanupLogs({
      dir: options.dir,
      now: Date.now(),
      keep: stream.file ? [stream.file] : [],
    }).then(reportCleanup)
  })
  stream.on('error', (err) => {
    // The sink itself failed: nowhere left to log, so stderr (never stdout).
    process.stderr.write(`[dfyom] log file error: ${err.message}\n`)
  })

  return {
    log,
    base,
    file: () => stream.file ?? '',
    flushSync: () => {
      try {
        stream.flushSync()
      } catch {
        // Nothing buffered or a write in flight; best effort before exit.
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.once('close', resolve)
        stream.end()
      }),
  }
}

/** Fallback when the file sink can't be opened: same options, stderr only. */
export function createStderrLogging(options: Omit<MainLoggerOptions, 'dir'>): MainLogging {
  const base = pino(rootPinoOptions(options), pino.destination({ fd: 2, sync: true }))
  return {
    log: base.child({ proc: options.proc }),
    base,
    file: () => '',
    flushSync: () => {},
    close: async () => {},
  }
}

/**
 * Uncaught exceptions and unhandled rejections → `internal.unexpected` at `fatal`,
 * flushed, then `exit(1)`.
 */
export function installCrashHandlers(
  logging: Pick<MainLogging, 'log' | 'flushSync'>,
  exit: (code: number) => void,
  target: Pick<NodeJS.Process, 'on'> = process,
): void {
  const handle = (name: string) => (cause: unknown) => {
    const err = new AppError('internal.unexpected', name, { cause, where: `process:${name}` })
    logging.log.fatal({ err: err.toJSON(), entry: { kind: 'system', name } }, err.message)
    logging.flushSync()
    exit(1)
  }
  target.on('uncaughtException', handle('uncaughtException'))
  target.on('unhandledRejection', handle('unhandledRejection'))
}
