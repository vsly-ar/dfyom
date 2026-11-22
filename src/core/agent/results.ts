/**
 * MCP `CallToolResult` of a session call: outcome (text: compact JSON or an outline), `AppError`
 * and the action digest.
 * Doc: docs/architecture/llm-api.md#results
 */
import type { AppError, AppErrorData } from '../../shared/errors/app-error'
import { ERROR_CODES } from '../../shared/errors/codes'
import type { SessionCallResult } from './session'

export interface ToolCallResult {
  readonly content: { readonly type: 'text'; readonly text: string }[]
  readonly structuredContent: Record<string, unknown>
  readonly isError: boolean
  readonly _meta?: Record<string, unknown>
}

/** The error as agents see it: no stack (noise for a model), `retryable` from `ERROR_CODES`. */
export function agentError(e: AppError): { error: AppErrorData; retryable: boolean } {
  const { stack: _stack, ...error } = e.toJSON()
  return { error, retryable: ERROR_CODES[e.code].retryable }
}

/** `code: message`, then one line per issue (path, message, rule). */
export function errorText(e: AppError): string {
  const lines = [`${e.code}: ${e.message}`]
  for (const i of e.issues) {
    const path = i.path.length > 0 ? i.path.join('.') : '(args)'
    lines.push(`- ${path}: ${i.message} (${i.rule})`)
  }
  if (e.code === 'command.conflict') lines.push('Re-query the project and retry.')
  return lines.join('\n')
}

/** Results up to this size are repeated in full as text; larger ones as an outline. */
export const TEXT_FULL_CHARS = 2000

/**
 * The text content of a result: the JSON when it is small, else an outline of it (nested
 * objects and long lists elided) noting that the full result is in `structuredContent`
 * (docs/architecture/llm-api.md#result-size).
 */
export function resultText(structured: object): string {
  const json = JSON.stringify(structured)
  if (json.length <= TEXT_FULL_CHARS) return json
  for (let depth = 6; depth >= 1; depth--) {
    const text = JSON.stringify(outline(structured, depth))
    if (text.length <= TEXT_FULL_CHARS || depth === 1)
      return `${text}\n(outline of ${json.length} chars; the full result is in structuredContent)`
  }
  return json
}

const LIST_ITEMS = 3

function outline(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) {
    if (depth === 0) return `[${v.length} items]`
    const head = v.slice(0, LIST_ITEMS).map((x) => outline(x, depth - 1))
    return v.length > LIST_ITEMS ? [...head, `… ${v.length - LIST_ITEMS} more`] : head
  }
  if (typeof v !== 'object' || v === null) return v
  if (depth === 0) return `{${Object.keys(v).length} keys}`
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, outline(x, depth - 1)]))
}

export function toToolResult(call: SessionCallResult): ToolCallResult {
  const digest = call.digest
  const meta = digest === undefined ? undefined : { 'dfyom/actions': digest.meta }
  const tail = digest === undefined ? [] : [digest.line]
  if (call.result.isErr()) {
    const e = call.result.unwrapErr()
    return {
      isError: true,
      structuredContent: agentError(e),
      content: [{ type: 'text', text: [errorText(e), ...tail].join('\n') }],
      ...(meta === undefined ? {} : { _meta: meta }),
    }
  }
  const outcome = call.result.unwrap()
  const structured = {
    value: outcome.value,
    revision: outcome.revision,
    ...(outcome.applied === undefined ? {} : { applied: outcome.applied }),
  }
  const lines = [resultText(structured)]
  if (call.kind === 'job') lines.push('Job started; wait with job_wait { jobId }.')
  return {
    isError: false,
    structuredContent: structured,
    content: [{ type: 'text', text: [...lines, ...tail].join('\n') }],
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}
