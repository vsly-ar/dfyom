// In-memory logger for tests. Doc: docs/conventions/logging.md#testing
import { createEntryLogger, type LogLevel, type Logger, type LogRecord } from '../logging'

export interface TestLogger extends Logger {
  /** Every recorded entry, in order, with bindings merged and `err` serialized. */
  readonly entries: readonly LogRecord[]
  /** Entries at exactly this level. */
  at(level: LogLevel): readonly LogRecord[]
  clear(): void
}

/** Records entries at or above `level` (default `trace`); children share the same record list. */
export function createTestLogger(level: LogLevel = 'trace'): TestLogger {
  const entries: LogRecord[] = []
  const log = createEntryLogger({ level, write: (r) => entries.push(r) })
  return {
    ...log,
    entries,
    at: (l) => entries.filter((e) => e.level === l),
    clear: () => {
      entries.length = 0
    },
  }
}
