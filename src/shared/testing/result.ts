// Test helpers for AppResult. Doc: docs/conventions/error-handling/helpers.md#testing
import { expect } from 'vitest'
import type { AppError } from '../errors/app-error'
import type { ErrorCode } from '../errors/codes'
import type { AppResult } from '../result'

/** Returns the Ok value; fails the test with the full error data if Err. */
export function expectOk<T>(r: AppResult<T>): T {
  if (r.isErr())
    expect.fail(`expected Ok, got Err:\n${JSON.stringify(r.unwrapErr().toJSON(), null, 2)}`)
  return r.unwrap()
}

/** Returns the AppError; fails the test if Ok or if the code differs. */
export function expectErrCode<T>(r: AppResult<T>, code: ErrorCode): AppError {
  if (r.isOk()) expect.fail(`expected Err(${code}), got Ok(${JSON.stringify(r.unwrap())})`)
  const e = r.unwrapErr()
  // serialise the error data only on a mismatch: doing it per call made loops of thousands of
  // assertions (the manifold heap test) spend most of their time here
  expect(e.code, e.code === code ? undefined : JSON.stringify(e.toJSON(), null, 2)).toBe(code)
  return e
}
