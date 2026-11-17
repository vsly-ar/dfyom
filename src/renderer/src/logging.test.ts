import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error'
import { toLogRecord } from './logging'

const event = (messages: unknown[], bindings: object[] = []) => ({
  ts: 0,
  messages,
  bindings,
  level: { label: 'warn', value: 40 },
})

describe('toLogRecord', () => {
  it('merges bindings and fields, takes the message, serializes err', () => {
    const r = toLogRecord(
      'warn',
      event([{ err: new AppError('op.aborted', 'stop'), n: 1 }, 'saved'], [{ scope: 'ui' }]),
    )
    expect(r).toMatchObject({ level: 'warn', msg: 'saved', scope: 'ui', n: 1 })
    expect((r['err'] as { code: string }).code).toBe('op.aborted')
  })

  it('handles a message-only call and unclonable values', () => {
    expect(toLogRecord('info', event(['hi']))).toEqual({ level: 'info', msg: 'hi' })
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(toLogRecord('info', event([{ cyclic }, 'x']))).toEqual({
      level: 'info',
      msg: 'x',
      unserializable: true,
    })
  })
})
