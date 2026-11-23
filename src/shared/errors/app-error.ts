// The app's single error type. Doc: docs/conventions/error-handling/app-error.md
import { ERROR_CODES, type ErrorCode, type Severity } from './codes'

export type IssuePath = readonly (string | number)[]

/** One violated rule, e.g. a field-level validation failure. */
export interface Issue {
  readonly path: IssuePath
  readonly rule: string
  readonly message: string
  readonly params?: Readonly<Record<string, unknown>>
}

/** One enrichment step added while the error travels up the call chain. */
export interface ContextFrame {
  readonly where: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** Plain, serializable form: IPC, workers, agent API, logs. */
export interface AppErrorData {
  readonly code: ErrorCode
  readonly message: string
  readonly issues: readonly Issue[]
  readonly frames: readonly ContextFrame[]
  readonly cause?: AppErrorData | { readonly name: string; readonly message: string }
  readonly stack?: string
}

export interface AppErrorOptions {
  readonly issues?: readonly Issue[]
  readonly where?: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

export class AppError extends Error {
  override readonly name = 'AppError'
  readonly code: ErrorCode
  readonly issues: readonly Issue[]
  /** Innermost first: frames[0] is where the error was created. */
  readonly frames: readonly ContextFrame[]

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.issues = options.issues ?? []
    this.frames =
      options.where === undefined
        ? []
        : [
            options.data === undefined
              ? { where: options.where }
              : { where: options.where, data: options.data },
          ]
  }

  get severity(): Severity {
    return ERROR_CODES[this.code].severity
  }

  get userMessage(): string {
    return ERROR_CODES[this.code].userMessage
  }

  /** Returns a copy with one more context frame; keeps the original stack. */
  withContext(where: string, data?: Readonly<Record<string, unknown>>): AppError {
    const copy = new AppError(this.code, this.message, { issues: this.issues, cause: this.cause })
    const frame: ContextFrame = data === undefined ? { where } : { where, data }
    ;(copy as { frames: readonly ContextFrame[] }).frames = [...this.frames, frame]
    if (this.stack !== undefined) copy.stack = this.stack
    return copy
  }

  /** Returns a copy whose issue paths are prefixed (nested model validation). */
  prefixIssues(...prefix: IssuePath): AppError {
    return this.mapIssues((i) => ({ ...i, path: [...prefix, ...i.path] }))
  }

  /** Returns a copy with every issue rewritten (paths mapped back to what the user edits). */
  mapIssues(f: (issue: Issue) => Issue): AppError {
    const copy = new AppError(this.code, this.message, {
      issues: this.issues.map(f),
      cause: this.cause,
    })
    ;(copy as { frames: readonly ContextFrame[] }).frames = this.frames
    if (this.stack !== undefined) copy.stack = this.stack
    return copy
  }

  toJSON(): AppErrorData {
    const c = this.cause
    const cause =
      c instanceof AppError
        ? c.toJSON()
        : c instanceof Error
          ? { name: c.name, message: c.message }
          : c === undefined
            ? undefined
            : { name: typeof c, message: String(c) }
    return {
      code: this.code,
      message: this.message,
      issues: this.issues,
      frames: this.frames,
      ...(cause === undefined ? {} : { cause }),
      ...(this.stack === undefined ? {} : { stack: this.stack }),
    }
  }

  /**
   * `toJSON()` without `stack`, nested causes included: the form for data that leaves the app
   * (agent and CLI results, job outcomes, evaluation status). Logs keep the stack.
   */
  toWireData(): AppErrorData {
    return withoutStack(this.toJSON())
  }

  static fromJSON(d: AppErrorData): AppError {
    const e = new AppError(d.code, d.message, { issues: d.issues, cause: d.cause })
    ;(e as { frames: readonly ContextFrame[] }).frames = d.frames
    if (d.stack !== undefined) e.stack = d.stack
    return e
  }
}

/** `AppErrorData` without `stack`, at every level of `cause`. */
export function withoutStack(d: AppErrorData): AppErrorData {
  const { stack: _stack, cause, ...rest } = d
  if (cause === undefined) return rest
  return { ...rest, cause: 'code' in cause ? withoutStack(cause) : cause }
}

/**
 * A message naming the first issue (field and rule text) and how many more there are, for
 * refusals agents read (docs/architecture/llm-api.md#a7-refusals-that-say-what-to-do).
 */
export function issueSummary(issues: readonly Issue[]): string {
  const first = issues[0]
  if (first === undefined) return 'invalid value'
  const path = first.path.length > 0 ? first.path.join('.') : '(value)'
  const more = issues.length > 1 ? ` (+ ${issues.length - 1} more)` : ''
  return `${path}: ${first.message}${more}`
}
