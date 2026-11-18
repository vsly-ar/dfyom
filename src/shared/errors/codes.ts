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
  // Quantity literals (task 2.1): docs/architecture/quantities.md#error-codes
  'quantity.syntax': {
    severity: 'warn',
    userMessage: 'The value could not be read.',
    retryable: false,
  },
  'quantity.unit': {
    severity: 'warn',
    userMessage: 'The unit is unknown or does not fit this field.',
    retryable: false,
  },
  // Expressions (task 2.2): docs/architecture/quantities.md#error-codes
  'expression.reference': {
    severity: 'warn',
    userMessage: 'The formula refers to an unknown value.',
    retryable: false,
  },
  'expression.cycle': {
    severity: 'warn',
    userMessage: 'The formulas refer to each other in a loop.',
    retryable: false,
  },
  'expression.dimension': {
    severity: 'warn',
    userMessage: 'The units in the formula do not fit together or this field.',
    retryable: false,
  },
  'expression.domain': {
    severity: 'warn',
    userMessage: 'The formula divides by zero.',
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
  // Persistence (task 3.1): docs/architecture/persistence.md#error-codes
  'persist.locked': {
    severity: 'warn',
    userMessage: 'This project is open in another DFYOM window or instance.',
    retryable: true,
  },
  'persist.verify': {
    severity: 'error',
    userMessage: 'The saved file could not be verified; the previous file was kept.',
    retryable: true,
  },
  // Agent API (task 3.10): docs/architecture/llm-api.md#app-scope-and-project-scope
  'persist.recovery': {
    severity: 'info',
    userMessage:
      'This project has unsaved changes from an earlier session. Restore or discard them first.',
    retryable: false,
  },
  'op.aborted': { severity: 'info', userMessage: 'The operation was cancelled.', retryable: true },
  // Workers (task 2.9): docs/architecture/workers.md#worker-death-timeouts-and-restart
  'op.timeout': {
    severity: 'warn',
    userMessage: 'The computation took too long and was stopped.',
    retryable: false,
  },
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
  // Geometry evaluation (task 2.6): docs/architecture/geometry.md#evaluation-checks
  'geometry.evaluation': {
    severity: 'error',
    userMessage: 'The part geometry could not be computed. This is a bug.',
    retryable: false,
  },
  // Design (task 2.5): docs/modes/design.md#commands-and-queries-v01
  'design.referenced': {
    severity: 'warn',
    userMessage: 'Later operations refer to this operation. Change or remove them first.',
    retryable: false,
  },
  // Machine connection (task 3.8): docs/architecture/grbl.md#transport-and-sender
  'machine.connection': {
    severity: 'error',
    userMessage: 'The connection to the machine is closed or lost.',
    retryable: true,
  },
  // Run mode (task 3.9): docs/modes/run-v0.1.md#stop-errors-and-alarms
  'machine.error': {
    severity: 'warn',
    userMessage: 'The machine rejected a line of the program; the run was stopped.',
    retryable: false,
  },
  'machine.alarm': {
    severity: 'warn',
    userMessage: 'The machine raised an alarm and stopped.',
    retryable: false,
  },
  'run.notConnected': {
    severity: 'info',
    userMessage: 'Connect to a machine first.',
    retryable: false,
  },
  'run.busy': {
    severity: 'info',
    userMessage: 'The machine is busy with another connection or run.',
    retryable: true,
  },
  'run.state': {
    severity: 'info',
    userMessage: "This is not possible in the machine's current state.",
    retryable: true,
  },
  'run.program': {
    severity: 'error',
    userMessage: 'The program contains lines the machine cannot receive.',
    retryable: false,
  },
  'run.softLimit': {
    severity: 'warn',
    userMessage:
      'The program would leave the machine travel at the current work zero. Move the work zero.',
    retryable: false,
  },
  // Plans (task 2.13): docs/modes/plan-v0.1.md#commands-and-queries-v01
  'plan.status': {
    severity: 'warn',
    userMessage: "This is not possible in the plan's current status.",
    retryable: false,
  },
  'plan.order': {
    severity: 'warn',
    userMessage: 'An operation would come before the operation whose surface it starts from.',
    retryable: false,
  },
  // Plan mode (task 2.10): docs/modes/plan-v0.1.md#toolpath-generators-task-210
  'plan.check': {
    severity: 'warn',
    userMessage: 'The tool or the cutting values do not fit this operation.',
    retryable: false,
  },
  // Post-processor (task 2.11): docs/architecture/grbl.md#export-checks
  'post.noMachine': {
    severity: 'warn',
    userMessage: 'Choose a machine for this plan before exporting gCode.',
    retryable: false,
  },
  'internal.unexpected': {
    severity: 'error',
    userMessage: 'Something went wrong. This is a bug.',
    retryable: false,
  },
} as const satisfies Record<string, ErrorCodeInfo>

export type ErrorCode = keyof typeof ERROR_CODES
