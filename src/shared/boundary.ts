// Entry points of every call chain. Doc: docs/conventions/error-handling/boundaries.md#entry-points-ui-agent-cli-automation
import { AppError } from './errors/app-error'
import { Err, type AppResult } from './result'

/** Who started the chain. Every chain starts at exactly one entry point. */
export interface EntryPoint {
  readonly kind: 'ui' | 'agent' | 'cli' | 'automation' | 'system'
  /** Stable action/command id, e.g. 'design.chamfer.apply' — same id for UI and agent. */
  readonly name: string
  readonly args?: unknown
}

export type ErrorReporter = (error: AppError, entry: EntryPoint) => void

const MAX_ARG_CHARS = 2_000

/** Keep logs/agent payloads small: large geometry etc. is truncated, not dropped silently. */
export function summarizeArgs(args: unknown): unknown {
  if (args === undefined) return undefined
  let s: string
  try {
    s = JSON.stringify(args) ?? String(args)
  } catch {
    return '[unserializable]'
  }
  return s.length <= MAX_ARG_CHARS
    ? args
    : `${s.slice(0, MAX_ARG_CHARS)}… [truncated ${s.length} chars]`
}

/**
 * Top of every chain (UI handler, agent tool call, CLI command, automation script).
 * Adds the entry frame, converts stray throws (bugs) into AppErrors, reports once.
 */
export async function atBoundary<T>(
  entry: EntryPoint,
  run: () => AppResult<T> | Promise<AppResult<T>>,
  report: ErrorReporter,
): Promise<AppResult<T>> {
  let result: AppResult<T>
  try {
    result = await run()
  } catch (cause) {
    const e =
      cause instanceof AppError
        ? cause
        : new AppError('internal.unexpected', `unhandled throw in ${entry.name}`, { cause })
    result = Err(e)
  }
  if (result.isOk()) return result
  const enriched = result
    .unwrapErr()
    .withContext(`${entry.kind}:${entry.name}`, { args: summarizeArgs(entry.args) })
  report(enriched, entry)
  return Err(enriched)
}
