// Renderer logger: pino's browser build, every entry at or above the instance level is
// batched and forwarded to main, which writes the file. Doc: docs/conventions/logging.md
import pino from 'pino'
import { AppError } from '../../shared/errors/app-error'
import {
  createLogForwarder,
  isLogLevel,
  logAppError,
  serializeErr,
  type LogRecord,
  type Logger,
} from '../../shared/logging'
import type { PreloadApi } from '../../shared/preload-api'

/** pino browser `logEvent` → flat, structured-clone-safe record (bindings, fields, `err` serialized). */
export function toLogRecord(level: string, event: pino.LogEvent): LogRecord {
  const fields: Record<string, unknown> = {}
  for (const b of event.bindings) Object.assign(fields, b)
  const [first, ...rest] = event.messages as unknown[]
  let msg = ''
  if (typeof first === 'string') msg = first
  else {
    if (typeof first === 'object' && first !== null) Object.assign(fields, first)
    if (typeof rest[0] === 'string') msg = rest[0]
  }
  if ('err' in fields) fields['err'] = serializeErr(fields['err'])
  const lvl = isLogLevel(level) ? level : 'info'
  try {
    return { ...(JSON.parse(JSON.stringify(fields)) as Record<string, unknown>), level: lvl, msg }
  } catch {
    return { level: lvl, msg, unserializable: true }
  }
}

/** Root renderer logger; call once per window. Also logs uncaught errors (at `error`). */
export function createRendererLogger(api: PreloadApi['log'], isDev: boolean): Logger {
  const forwarder = createLogForwarder({ send: api.send })
  const root = pino({
    level: api.level,
    browser: {
      asObject: true,
      // DevTools console in dev only; the file in main is the place to look.
      ...(isDev ? {} : { write: () => {} }),
      transmit: {
        level: api.level,
        send: (level, event) => forwarder.push(toLogRecord(level, event)),
      },
    },
  })
  const log: Logger = root

  const crash = (name: string, cause: unknown): void =>
    logAppError(
      log,
      new AppError('internal.unexpected', name, { cause, where: `window:${name}` }),
      {
        kind: 'ui',
        name,
      },
    )
  window.addEventListener('error', (e) => crash('error', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => crash('unhandledrejection', e.reason))
  window.addEventListener('pagehide', () => forwarder.flush())
  return log
}
