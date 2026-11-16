// Zod → AppResult. Doc: docs/conventions/error-handling/helpers.md#parsing-untrusted-data-zod
import type { z } from 'zod'
import { AppError, type Issue } from './errors/app-error'
import { Err, Ok, type AppResult } from './result'

/** Shape check of untrusted data (files, IPC, agent input) → AppResult. Domain invariants stay in models. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  where: string,
): AppResult<z.output<S>> {
  const r = schema.safeParse(raw)
  if (r.success) return Ok(r.data)
  const issues: Issue[] = r.error.issues.map((i) => ({
    path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
    rule: i.code,
    message: i.message,
  }))
  return Err(
    new AppError('input.malformed', `${issues.length} malformed value(s)`, { issues, where }),
  )
}
