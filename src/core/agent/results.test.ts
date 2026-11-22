// Results: CallToolResult of each outcome kind, AppError mapping, CLI exit codes.
// Spec: docs/architecture/llm-api.md#testing (Results (core))
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error'
import { ERROR_CODES, type ErrorCode } from '../../shared/errors/codes'
import { Err, Ok } from '../../shared/result'
import { EXIT, exitCodeOf } from './exit-codes'
import { resultText, TEXT_FULL_CHARS, toToolResult } from './results'
import type { Digest } from './session'

const digest: Digest = {
  line: 'Since your last call: 1 action by ui:win-1 (history.undo), revision 3 → 4.',
  meta: {
    fromSeq: 5,
    toSeq: 6,
    count: 1,
    bySource: { 'ui:win-1': ['history.undo'] },
    revision: { from: 3, to: 4 },
    gap: false,
  },
}

describe('tool results', () => {
  it('maps a command outcome with the digest line and _meta', () => {
    const r = toToolResult({
      name: 'design.pocket.add',
      kind: 'command',
      result: Ok({ value: { operationId: 'op-1' }, revision: 4 }),
      digest,
    })
    expect(r).toEqual({
      isError: false,
      structuredContent: { value: { operationId: 'op-1' }, revision: 4 },
      content: [
        { type: 'text', text: `{"value":{"operationId":"op-1"},"revision":4}\n${digest.line}` },
      ],
      _meta: { 'dfyom/actions': digest.meta },
    })
  })

  it('maps a query outcome without a digest', () => {
    const r = toToolResult({
      name: 'plan.list',
      kind: 'query',
      result: Ok({ value: [], revision: 2 }),
    })
    expect(r).toEqual({
      isError: false,
      structuredContent: { value: [], revision: 2 },
      content: [{ type: 'text', text: '{"value":[],"revision":2}' }],
    })
  })

  it('maps a started job with the job_wait hint', () => {
    const r = toToolResult({
      name: 'plan.toolpath.generate',
      kind: 'job',
      result: Ok({ value: { jobId: 'job-1' }, revision: 2 }),
    })
    expect(r.structuredContent).toEqual({ value: { jobId: 'job-1' }, revision: 2 })
    expect(r.content[0]?.text).toBe(
      '{"value":{"jobId":"job-1"},"revision":2}\nJob started; wait with job_wait { jobId }.',
    )
  })

  it('repeats a large result as an outline in the text (structuredContent has all of it)', () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({
      id: `op-${i}`,
      nested: { deep: { x: i } },
    }))
    const structured = { value: { items, name: 'p' }, revision: 7 }
    const r = toToolResult({ name: 'plan.get', kind: 'query', result: Ok(structured) })
    expect(r.structuredContent).toEqual(structured)
    const text = r.content[0]!.text
    expect(text.length).toBeLessThan(TEXT_FULL_CHARS + 100)
    expect(text).toContain('"revision":7')
    expect(text).toContain('… 1997 more')
    expect(text).toMatch(/outline of \d+ chars; the full result is in structuredContent/)
    expect(resultText({ small: true })).toBe('{"small":true}')
  })

  it('maps an AppError with issues to a tool execution error (no stack)', () => {
    const e = new AppError('command.conflict', 'the project changed', {
      where: 'dispatch',
      issues: [{ path: ['depth'], rule: 'positive', message: 'must be > 0', params: { min: 0 } }],
    })
    const r = toToolResult({ name: 'x.y.z', kind: 'command', result: Err(e), digest })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({
      error: {
        code: 'command.conflict',
        message: 'the project changed',
        issues: [{ path: ['depth'], rule: 'positive', message: 'must be > 0', params: { min: 0 } }],
        frames: [{ where: 'dispatch' }],
      },
      retryable: true,
    })
    expect(r.content[0]?.text).toBe(
      [
        'command.conflict: the project changed',
        '- depth: must be > 0 (positive)',
        'Re-query the project and retry.',
        digest.line,
      ].join('\n'),
    )
  })
})

describe('CLI exit codes', () => {
  const expected: Partial<Record<ErrorCode, number>> = {
    'internal.unexpected': 1,
    'input.malformed': 2,
    'command.unknown': 2,
    'quantity.syntax': 2,
    'quantity.unit': 2,
    'expression.reference': 2,
    'expression.cycle': 2,
    'expression.dimension': 2,
    'expression.domain': 2,
    'model.invariant': 2,
    'command.conflict': 3,
    'persist.locked': 3,
    'permission.denied': 4,
    'op.aborted': 5,
    'op.timeout': 5,
    'persist.io': 6,
    'machine.alarm': 6,
    'plan.status': 6,
  }
  it.each(Object.keys(ERROR_CODES) as ErrorCode[])('%s has an exit code', (code) => {
    const exit = exitCodeOf(code)
    expect(Object.values(EXIT)).toContain(exit)
    expect(exit).not.toBe(0)
    if (expected[code] !== undefined) expect(exit).toBe(expected[code])
    else expect(exit).toBe(EXIT.other)
  })
})
