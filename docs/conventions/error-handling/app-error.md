# AppError

Status: draft – ready for review · Part of [error handling](README.md) · Code blocks are the [reference design](README.md#reference-design)

The single error type: shape, error-code registry, enrichment rules, serialization.

## Shape

| Field                     | Purpose                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `code: ErrorCode`         | Classification from the central registry ([below](#error-code-registry)). Drives severity, user message, retry, CLI exit code.           |
| `message: string`         | Developer/LLM-facing English text, specific (`"total chamfer size 6 mm exceeds 5 mm"`).                                                  |
| `issues: Issue[]`         | Rule violations, each `{ path, rule, message, params? }` – field-level, machine-readable (forms highlight `path`; agents read `params`). |
| `frames: ContextFrame[]`  | Enrichment, **innermost first**: `{ where, data? }`.                                                                                     |
| `cause?: unknown`         | Original error (third-party exception, `InvariantViolation`, nested `AppError`).                                                         |
| `stack`                   | Captured where the error was **first created**; preserved by enrichment.                                                                 |
| `severity`, `userMessage` | Derived getters from the registry.                                                                                                       |

`AppError extends Error`, so stack traces, `cause`, React error boundaries and logging libraries work natively. It is immutable: `withContext()` and `prefixIssues()` return copies.

```ts
// → src/shared/errors/app-error.ts
export type IssuePath = readonly (string | number)[]
export interface Issue {
  readonly path: IssuePath
  readonly rule: string
  readonly message: string
  readonly params?: Readonly<Record<string, unknown>>
}
export interface ContextFrame {
  readonly where: string
  readonly data?: Readonly<Record<string, unknown>>
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

  /** Copy with one more frame; keeps the original stack. */
  withContext(where: string, data?: Readonly<Record<string, unknown>>): AppError {
    const copy = new AppError(this.code, this.message, { issues: this.issues, cause: this.cause })
    const frame: ContextFrame = data === undefined ? { where } : { where, data }
    ;(copy as { frames: readonly ContextFrame[] }).frames = [...this.frames, frame]
    if (this.stack !== undefined) copy.stack = this.stack
    return copy
  }

  /** Copy with issue paths prefixed – used by composite models (models.md#composite-models). */
  prefixIssues(...prefix: IssuePath): AppError {
    /* same copy pattern, issues mapped */
  }

  toJSON(): AppErrorData {
    /* plain object; cause → AppErrorData | { name, message } */
  }
  static fromJSON(d: AppErrorData): AppError {
    /* inverse */
  }
}
```

## Error code registry

One `as const` object is the **single list of codes**. Codes are `area.reason`, stable (agents and tests depend on them), and added here before use – never invented inline.

```ts
// → src/shared/errors/codes.ts
export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export interface ErrorCodeInfo {
  readonly severity: Severity // log level at the boundary
  readonly userMessage: string // default UI text; call sites may be more specific
  readonly retryable: boolean
}

export const ERROR_CODES = {
  'model.invariant': {
    severity: 'warn',
    userMessage: 'Some values are not valid.',
    retryable: false,
  },
  'input.malformed': {
    severity: 'warn',
    userMessage: 'The data has an unexpected format.',
    retryable: false,
  },
  'persist.migration': {
    severity: 'error',
    userMessage: 'This file could not be upgraded to the current version.',
    retryable: false,
  },
  'persist.io': {
    severity: 'error',
    userMessage: 'The file could not be read or written.',
    retryable: true,
  },
  'op.aborted': { severity: 'info', userMessage: 'The operation was cancelled.', retryable: true },
  'external.failure': {
    severity: 'error',
    userMessage: 'An external component failed.',
    retryable: true,
  },
  'internal.unexpected': {
    severity: 'error',
    userMessage: 'Something went wrong. This is a bug.',
    retryable: false,
  },
} as const satisfies Record<string, ErrorCodeInfo>

export type ErrorCode = keyof typeof ERROR_CODES
```

Expected future areas (add when the feature's doc is written): `machine.*` (disconnected, alarm, limit), `device.*` (MCU/sensor), `plan.*` (collision, unreachable, tool not found), `geometry.*`, `script.*`, `agent.*` (permission denied).

## Enrichment rules

- **Create** at the lowest level that detects the problem, with `where` = `Module.function` and the data needed to understand it.
- **Enrich** only with information the lower level did not have (ids, the user's intent, which item in a loop). Don't add a frame that just repeats the function name with no data.
- **Data must be small and serializable** – ids, numbers, short strings. No geometry blobs, no class instances. `atBoundary` truncates args above 2 000 chars.
- **No secrets** in frames (credentials, tokens).
- **Change the code only when the meaning changes** (e.g. `persist.io` "file not found" while loading a library may become a domain-specific code). Keep the original as `cause`.

## Serialization

`AppError.toJSON()` → `AppErrorData` (plain object, `structuredClone`- and JSON-safe). Results crossing a boundary use a wire union:

```ts
// → src/shared/result.ts
export type ResultWire<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppErrorData }

export function toWire<T>(r: AppResult<T>): ResultWire<T> {
  return r.isOk() ? { ok: true, value: r.unwrap() } : { ok: false, error: r.unwrapErr().toJSON() }
}
export function fromWire<T>(w: ResultWire<T>): AppResult<T> {
  return w.ok ? Ok(w.value) : Err(AppError.fromJSON(w.error))
}
```

Used for: IPC handlers (main ↔ renderer), worker messages, the agent API response, CLI `--json` output. `T` itself must be a DTO, not a model instance (see [migrations.md](migrations.md) for `toDTO()`).
