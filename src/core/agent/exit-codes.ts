/**
 * CLI exit codes by error code. Doc: docs/architecture/llm-api.md#cli (the mapping
 * docs/conventions/error-handling/boundaries.md leaves to it).
 */
import type { ErrorCode } from '../../shared/errors/codes'

export const EXIT = {
  ok: 0,
  internal: 1,
  /** Usage, `command.unknown`, `input.malformed` and other input/model codes. */
  input: 2,
  /** Retryable conflicts: `command.conflict`, `persist.locked`. */
  conflict: 3,
  permission: 4,
  /** `op.aborted`, `op.timeout`. */
  aborted: 5,
  /** Any other `AppError` (domain, persistence, machine). */
  other: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Every `ERROR_CODES` key has an entry: the `Record` makes a new code a type error here. */
const BY_CODE: Record<ErrorCode, ExitCode> = {
  'model.invariant': EXIT.input,
  'quantity.syntax': EXIT.input,
  'quantity.unit': EXIT.input,
  'expression.reference': EXIT.input,
  'expression.cycle': EXIT.input,
  'expression.dimension': EXIT.input,
  'expression.domain': EXIT.input,
  'input.malformed': EXIT.input,
  'command.unknown': EXIT.input,
  'command.conflict': EXIT.conflict,
  'persist.locked': EXIT.conflict,
  'permission.denied': EXIT.permission,
  'op.aborted': EXIT.aborted,
  'op.timeout': EXIT.aborted,
  'internal.unexpected': EXIT.internal,
  'persist.migration': EXIT.other,
  'persist.io': EXIT.other,
  'persist.verify': EXIT.other,
  'persist.recovery': EXIT.other,
  'external.failure': EXIT.other,
  'geometry.evaluation': EXIT.other,
  'design.referenced': EXIT.other,
  'machine.connection': EXIT.other,
  'machine.error': EXIT.other,
  'machine.alarm': EXIT.other,
  'run.notConnected': EXIT.other,
  'run.busy': EXIT.other,
  'run.state': EXIT.other,
  'run.program': EXIT.other,
  'run.softLimit': EXIT.other,
  'plan.status': EXIT.other,
  'plan.order': EXIT.other,
  'plan.setup': EXIT.other,
  'plan.check': EXIT.other,
  'post.noMachine': EXIT.other,
}

export function exitCodeOf(code: ErrorCode): ExitCode {
  return BY_CODE[code] ?? EXIT.internal
}
