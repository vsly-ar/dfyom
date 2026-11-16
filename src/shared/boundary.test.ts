import { describe, expect, it } from 'vitest'
import { atBoundary, summarizeArgs } from './boundary'
import type { AppError } from './errors/app-error'
import { Ok } from './result'
import { addChamferToPart } from './testing/chamfer.fixture'
import { expectErrCode } from './testing/result'

describe('atBoundary', () => {
  it('adds the entry frame with args and reports exactly once', async () => {
    const reported: AppError[] = []
    const r = await atBoundary(
      { kind: 'agent', name: 'design.chamfer.apply', args: { partId: 'p1', angleDeg: 95 } },
      () => addChamferToPart('p1', { angleDeg: 95, sizeMm: 1 }),
      (e) => reported.push(e),
    )
    const e = expectErrCode(r, 'model.invariant')
    expect(reported).toEqual([e])
    expect(e.frames.map((f) => f.where)).toEqual([
      'Chamfer.create',
      'addChamferToPart',
      'agent:design.chamfer.apply',
    ])
    expect(e.toJSON().frames.at(-1)?.data).toEqual({ args: { partId: 'p1', angleDeg: 95 } })
  })

  it('does not report Ok results', async () => {
    let calls = 0
    const r = await atBoundary(
      { kind: 'cli', name: 'x' },
      async () => Ok(1),
      () => calls++,
    )
    expect(r.unwrap()).toBe(1)
    expect(calls).toBe(0)
  })

  it('turns a stray throw into internal.unexpected', async () => {
    const r = await atBoundary(
      { kind: 'ui', name: 'x' },
      () => {
        throw new Error('boom')
      },
      () => {},
    )
    expectErrCode(r, 'internal.unexpected')
  })
})

describe('summarizeArgs', () => {
  it('keeps small args, truncates large ones, survives cycles', () => {
    expect(summarizeArgs({ a: 1 })).toEqual({ a: 1 })
    expect(summarizeArgs('x'.repeat(5000))).toMatch(/truncated 5002 chars/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(summarizeArgs(cyclic)).toBe('[unserializable]')
  })
})
