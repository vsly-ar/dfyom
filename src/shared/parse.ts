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
  // the first issue in the message: field, rule and what was expected (llm-api.md#a7)
  const first = issues[0]
  const head =
    first === undefined
      ? 'malformed value'
      : `${first.path.length > 0 ? first.path.join('.') : '(value)'}: ${first.message}`
  const more = issues.length > 1 ? ` (+ ${issues.length - 1} more)` : ''
  return Err(new AppError('input.malformed', `${where}: ${head}${more}`, { issues, where }))
}
