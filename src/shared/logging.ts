// Logger port and pure helpers, shared by every process. Doc: docs/conventions/logging.md
// Environment-neutral: no pino, Node or DOM imports here; each process implements the port.
import type { EntryPoint, ErrorReporter } from './boundary'
import { AppError } from './errors/app-error'

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** pino's numeric level values. */
export const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** Structured fields of one entry. Top-level names: docs/conventions/logging.md#fields */
export type LogFields = Readonly<Record<string, unknown>>

export interface LogFn {
  (msg: string): void
  (fields: LogFields, msg: string): void
}

/** Structural subset of pino's logger, so a pino logger satisfies it directly. */
export interface Logger {
  readonly trace: LogFn
  readonly debug: LogFn
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly fatal: LogFn
  child(bindings: LogFields): Logger
  isLevelEnabled(level: LogLevel): boolean
}

const noop = (): void => {}

export const noopLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => noopLogger,
  isLevelEnabled: () => false,
}

// ---------------------------------------------------------------------------
// Level resolution

export const LOG_LEVEL_ENV = 'DFYOM_LOG_LEVEL'
export const LOG_LEVEL_FLAG = '--log-level'

export interface LevelInputs {
  /** Value of DFYOM_LOG_LEVEL, if set. */
  readonly env?: string | undefined
  /** Command-line arguments; `--log-level=x` or `--log-level x`. */
  readonly argv?: readonly string[]
  /** Unpackaged run (`npm run dev`, preview) → default `debug`. */
  readonly isDev: boolean
}

export interface ResolvedLevel {
  readonly level: LogLevel
  /** Override values that were not a level name, to be logged once as `warn`. */
  readonly ignored: readonly string[]
}

/** Default `info` (packaged) / `debug` (dev); the flag wins over the env var; invalid values are ignored. */
export function resolveLogLevel({ env, argv = [], isDev }: LevelInputs): ResolvedLevel {
  const ignored: string[] = []
  const pick = (raw: string | undefined): LogLevel | undefined => {
    if (raw === undefined || raw === '') return undefined
    const v = raw.trim().toLowerCase()
    if (isLogLevel(v)) return v
    ignored.push(raw)
    return undefined
  }
  const fromFlag = pick(flagValue(argv, LOG_LEVEL_FLAG))
  const fromEnv = pick(env)
  return { level: fromFlag ?? fromEnv ?? (isDev ? 'debug' : 'info'), ignored }
}

/** Last occurrence of `--name=value` or `--name value` in argv. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === name) value = argv[i + 1]
    else if (a?.startsWith(`${name}=`)) value = a.slice(name.length + 1)
  }
  return value
}

// ---------------------------------------------------------------------------
// Errors

export interface SerializedError {
  readonly type: string
  readonly message: string
  readonly stack?: string
  readonly cause?: unknown
}

/** Minimal stand-in for pino's standard error serializer where pino isn't available. */
export function basicErrorSerializer(err: Error): SerializedError {
  return {
    type: err.name,
    message: err.message,
    ...(err.stack === undefined ? {} : { stack: err.stack }),
    ...(err.cause === undefined ? {} : { cause: serializeErr(err.cause) }),
  }
}

/**
 * Serializer for the `err` key: AppError → `toJSON()`, other Error → `fallback`
 * (pino's standard serializer in pino-backed loggers), anything else unchanged.
 */
export function serializeErr(
  value: unknown,
  fallback: (err: Error) => unknown = basicErrorSerializer,
): unknown {
  if (value instanceof AppError) return value.toJSON()
  if (value instanceof Error) return fallback(value)
  return value
}

/** The one place an AppError is logged: at its code's severity, with the entry point. */
export function logAppError(log: Logger, err: AppError, entry: EntryPoint): void {
  log[err.severity](
    { err: err.toJSON(), entry: { kind: entry.kind, name: entry.name } },
    err.message,
  )
}

/** Boundary reporter that logs (and only logs); UI/agent/CLI reporters call this plus their routing. */
export function createLogReporter(log: Logger): ErrorReporter {
  return (err, entry) => logAppError(log, err, entry)
}

// ---------------------------------------------------------------------------
// Timing

export interface TimedOptions {
  /** Above this many ms the entry is a `warn` instead of `debug`. */
  readonly budgetMs?: number
  readonly fields?: LogFields
  readonly now?: () => number
}

/** Runs `fn`, logs `msg` with `ms`, returns `fn`'s result unchanged (a promise is awaited for timing). */
export function timed<T>(log: Logger, msg: string, fn: () => T, options: TimedOptions = {}): T {
  const now = options.now ?? Date.now
  const start = now()
  const done = (): void => {
    const ms = now() - start
    const level = options.budgetMs !== undefined && ms > options.budgetMs ? 'warn' : 'debug'
    log[level]({ ...options.fields, ms }, msg)
  }
  let result: T
  try {
    result = fn()
  } catch (e) {
    done()
    throw e
  }
  if (isPromiseLike(result)) return Promise.resolve(result).finally(done) as T
  done()
  return result
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

// ---------------------------------------------------------------------------
// Entries and forwarding (renderer, utility process, workers → main)

/** One forwarded entry: flat like a pino line, minus `time`/`pid` (main stamps those). */
export interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly [field: string]: unknown
}

/** IPC channel for renderer batches (`ipcRenderer.send`, fire-and-forget). */
export const LOG_IPC_CHANNEL = 'dfyom:log'

/** Window argument (`webPreferences.additionalArguments`) carrying the instance level to the preload. */
export const RENDERER_LOG_LEVEL_ARG = '--dfyom-log-level'

/** Keys main sets itself; forwarded values for them are discarded. */
export const RESERVED_LOG_KEYS: readonly string[] = [
  'level',
  'time',
  'msg',
  'pid',
  'hostname',
  'proc',
  'instance',
  'app',
  'win',
]

export interface EntryLoggerOptions {
  readonly level: LogLevel
  readonly bindings?: LogFields
  readonly write: (record: LogRecord) => void
}

/**
 * Logger that turns each enabled call into a flat `LogRecord` (bindings, then fields, `err`
 * serialized). Used by the test logger and by processes that forward entries without pino.
 */
export function createEntryLogger({ level, bindings = {}, write }: EntryLoggerOptions): Logger {
  const min = LOG_LEVEL_VALUES[level]
  const enabled = (l: LogLevel): boolean => LOG_LEVEL_VALUES[l] >= min
  const method =
    (l: LogLevel): LogFn =>
    (a: LogFields | string, b?: string) => {
      if (!enabled(l)) return
      const fields = typeof a === 'string' ? {} : a
      const msg = typeof a === 'string' ? a : (b ?? '')
      const merged: Record<string, unknown> = { ...bindings, ...fields }
      if ('err' in merged) merged['err'] = serializeErr(merged['err'])
      write({ ...merged, level: l, msg })
    }
  return {
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (more) => createEntryLogger({ level, bindings: { ...bindings, ...more }, write }),
    isLevelEnabled: enabled,
  }
}

export interface ForwarderOptions {
  /** Delivers one batch to the writing process (IPC, MessagePort, worker message). */
  readonly send: (batch: readonly LogRecord[]) => void
  /** Flush when this many entries are queued. Default 50. */
  readonly maxBatch?: number
  /** Flush at most this long after the first queued entry. Default 100 ms. */
  readonly maxDelayMs?: number
  /** Entries accepted per one-second window; the rest are dropped and counted. Default 1 000. */
  readonly maxPerSecond?: number
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface LogForwarder {
  push(record: LogRecord): void
  /** Sends queued entries now (also reports pending drops). */
  flush(): void
}

/** Batches entries (≤ maxDelayMs or maxBatch) and drops beyond maxPerSecond with one `warn`. */
export function createLogForwarder(options: ForwarderOptions): LogForwarder {
  const maxBatch = options.maxBatch ?? 50
  const maxDelayMs = options.maxDelayMs ?? 100
  const maxPerSecond = options.maxPerSecond ?? 1_000
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let queue: LogRecord[] = []
  let timer: unknown
  let windowStart = now()
  let inWindow = 0
  let dropped = 0

  const reportDrops = (): void => {
    if (dropped === 0) return
    queue.push({ level: 'warn', msg: 'log entries dropped', scope: 'logging', dropped })
    dropped = 0
  }

  const rollWindow = (t: number): void => {
    if (t - windowStart < 1_000) return
    reportDrops()
    windowStart = t
    inWindow = 0
  }

  const send = (force: boolean): void => {
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
    rollWindow(now())
    if (force) reportDrops()
    if (queue.length === 0) return
    const batch = queue
    queue = []
    options.send(batch)
  }
  const onTimer = (): void => {
    timer = undefined
    send(false)
    // Drops are reported when their window closes, even if nothing else is logged.
    if (dropped > 0 && timer === undefined)
      timer = setTimer(onTimer, Math.max(0, 1_000 - (now() - windowStart)))
  }

  return {
    push(record) {
      rollWindow(now())
      if (inWindow >= maxPerSecond) {
        dropped++
        if (timer === undefined)
          timer = setTimer(onTimer, Math.max(0, 1_000 - (now() - windowStart)))
        return
      }
      inWindow++
      queue.push(record)
      if (queue.length >= maxBatch) send(false)
      else if (timer === undefined) timer = setTimer(onTimer, maxDelayMs)
    },
    flush: () => send(true),
  }
}
