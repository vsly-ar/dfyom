/**
 * MCP `CallToolResult` of a session call: outcome, `AppError` and the action digest.
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
  const lines = [JSON.stringify(structured)]
  if (call.kind === 'job') lines.push('Job started; wait with job_wait { jobId }.')
  return {
    isError: false,
    structuredContent: structured,
    content: [{ type: 'text', text: [...lines, ...tail].join('\n') }],
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}
