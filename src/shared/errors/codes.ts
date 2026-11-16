// Error code registry. Doc: docs/conventions/error-handling/app-error.md#error-code-registry
export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ErrorCodeInfo {
  /** Log level used when this error reaches a boundary handler. */
  readonly severity: Severity
  /** Short, user-facing default text (UI may override per call site). */
  readonly userMessage: string
  /** May the same action succeed if simply retried? */
  readonly retryable: boolean
}

/** Single registry of error codes. Add new codes here; never invent codes inline. */
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
  // Command layer: docs/architecture/commands.md#dispatcher-pipeline
  'command.unknown': {
    severity: 'warn',
    userMessage: 'This command does not exist.',
    retryable: false,
  },
  'command.conflict': {
    severity: 'info',
    userMessage: 'The project changed in the meantime. Please try again.',
    retryable: true,
  },
  'permission.denied': {
    severity: 'warn',
    userMessage: 'This action is not allowed.',
    retryable: false,
  },
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
