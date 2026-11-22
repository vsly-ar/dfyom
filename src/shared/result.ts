// The app's only import site of oxide.ts; app code imports Result/Option from here.
// Doc: docs/conventions/error-handling/helpers.md
import { Err, None, Ok, Option, Result, Some } from 'oxide.ts'
import { AppError, type AppErrorData, type AppErrorOptions, type Issue } from './errors/app-error'
import type { ErrorCode } from './errors/codes'

export { Err, None, Ok, Option, Result, Some }

export type AppResult<T> = Result<T, AppError>
export type AsyncAppResult<T> = Promise<AppResult<T>>

/** Shorthand for Err(new AppError(...)). */
export function fail(
  code: ErrorCode,
  message: string,
  options?: AppErrorOptions,
): Result<never, AppError> {
  return Err(new AppError(code, message, options))
}

/** Curried enricher for `.mapErr(ctx('Part.addChamfer', { partId }))`. */
export function ctx(
  where: string,
  data?: Readonly<Record<string, unknown>>,
): (e: AppError) => AppError {
  return (e) => e.withContext(where, data)
}

/** Wrap a throwing (third-party) call. AppErrors thrown inside pass through unchanged. */
export function tryCatch<T>(fn: () => T, code: ErrorCode, message: string): AppResult<T> {
  try {
    return Ok(fn())
  } catch (cause) {
    return Err(cause instanceof AppError ? cause : new AppError(code, message, { cause }))
  }
}

/** Async variant; also maps AbortError to 'op.aborted'. */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  code: ErrorCode,
  message: string,
): AsyncAppResult<T> {
  try {
    return Ok(await fn())
  } catch (cause) {
    if (cause instanceof AppError) return Err(cause)
    if (cause instanceof Error && cause.name === 'AbortError') {
      return Err(new AppError('op.aborted', message, { cause }))
    }
    return Err(new AppError(code, message, { cause }))
  }
}

/**
 * Like Result.all, but does not stop at the first error: all 'model.invariant'
 * issues are merged so a form can show every invalid field at once.
 * Any other error code short-circuits (returned as-is).
 */
export function collect<T>(results: readonly AppResult<T>[]): AppResult<T[]> {
  const values: T[] = []
  const issues: Issue[] = []
  for (const r of results) {
    if (r.isOk()) {
      values.push(r.unwrap())
      continue
    }
    const e = r.unwrapErr()
    if (e.code !== 'model.invariant') return Err(e)
    issues.push(...e.issues)
  }
  return issues.length === 0
    ? Ok(values)
    : fail('model.invariant', `${issues.length} invalid value(s)`, { issues })
}

/** Wire format for Results crossing IPC / worker / agent boundaries (oxide values do not survive cloning). */
export type ResultWire<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppErrorData }

export function toWire<T>(r: AppResult<T>): ResultWire<T> {
  return r.isOk() ? { ok: true, value: r.unwrap() } : { ok: false, error: r.unwrapErr().toJSON() }
}

/**
 * `toWire` without the error's `stack`: for results that leave the app or are kept as data (job
 * outcomes, the action log, agent and CLI results). Doc: docs/conventions/error-handling/app-error.md#serialization
 */
export function toDataWire<T>(r: AppResult<T>): ResultWire<T> {
  return r.isOk()
    ? { ok: true, value: r.unwrap() }
    : { ok: false, error: r.unwrapErr().toWireData() }
}

export function fromWire<T>(w: ResultWire<T>): AppResult<T> {
  return w.ok ? Ok(w.value) : Err(AppError.fromJSON(w.error))
}
