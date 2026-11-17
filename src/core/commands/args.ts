/**
 * Command and query args: shape check that also rejects unknown keys at any depth.
 * Doc: docs/architecture/commands.md#dispatcher-pipeline
 *
 * Zod objects strip unknown keys; a mistyped optional key (`dept` for `depth`) would then be
 * silently ignored and its default used. Every key of the raw args must therefore survive in
 * the parsed value (defaults may add keys; only stripped ones are unknown).
 */
import type { z } from 'zod'
import type { Issue } from '../../shared/errors/app-error'
import { parseWith } from '../../shared/parse'
import { fail, type AppResult } from '../../shared/result'

export function parseArgs<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  where: string,
): AppResult<z.output<S>> {
  const parsed = parseWith(schema, raw, where)
  if (parsed.isErr()) return parsed
  const issues: Issue[] = []
  unknownKeys(raw, parsed.unwrap(), [], issues)
  if (issues.length === 0) return parsed
  return fail('input.malformed', `${issues.length} unknown argument(s)`, { issues, where })
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function unknownKeys(
  raw: unknown,
  parsed: unknown,
  path: (string | number)[],
  issues: Issue[],
): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((r, i) => unknownKeys(r, parsed[i], [...path, i], issues))
    return
  }
  if (!isRecord(raw) || !isRecord(parsed)) return
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key))
      issues.push({
        path: [...path, key],
        rule: 'unrecognized_keys',
        message: `unknown argument "${key}"`,
      })
    else unknownKeys(raw[key], parsed[key], [...path, key], issues)
  }
}
