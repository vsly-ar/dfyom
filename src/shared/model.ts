// Invariant-model helpers. Doc: docs/conventions/error-handling/models.md
import { AppError, type Issue, type IssuePath } from './errors/app-error'
import { Err, Ok, type AppResult } from './result'

/** Thrown ONLY inside private model constructors; never escapes `construct`. */
export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation'
  constructor(
    readonly model: string,
    readonly issues: readonly Issue[],
  ) {
    super(
      `${model}: ${issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
    )
  }
}

export interface InvariantChecker {
  /** Records an issue when `ok` is false. Checks all rules, does not stop at the first. */
  check(
    ok: boolean,
    path: IssuePath,
    rule: string,
    message: string,
    params?: Record<string, unknown>,
  ): void
}

/** Run all checks; throw one InvariantViolation listing every failed rule. */
export function invariants(model: string, body: (c: InvariantChecker) => void): void {
  const issues: Issue[] = []
  body({
    check(ok, path, rule, message, params) {
      if (!ok)
        issues.push(
          params === undefined ? { path, rule, message } : { path, rule, message, params },
        )
    },
  })
  if (issues.length > 0) throw new InvariantViolation(model, issues)
}

/**
 * The only way a static factory calls its private constructor.
 * Catches and classifies whatever the constructor throws.
 */
export function construct<T>(model: string, build: () => T): AppResult<T> {
  try {
    return Ok(build())
  } catch (cause) {
    if (cause instanceof InvariantViolation) {
      return Err(
        new AppError('model.invariant', cause.message, {
          issues: cause.issues,
          where: `${model}.create`,
          cause,
        }),
      )
    }
    if (cause instanceof AppError) return Err(cause.withContext(`${model}.create`))
    // Anything else is a bug in the constructor (TypeError, RangeError, ...).
    return Err(
      new AppError('internal.unexpected', `${model} constructor threw unexpectedly`, {
        where: `${model}.create`,
        cause,
      }),
    )
  }
}
