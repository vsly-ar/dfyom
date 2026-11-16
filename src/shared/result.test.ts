import { describe, expect, it } from 'vitest'
import { AppError } from './errors/app-error'
import {
  collect,
  ctx,
  fail,
  fromWire,
  Ok,
  Option,
  Some,
  toWire,
  tryAsync,
  tryCatch,
} from './result'
import { expectErrCode, expectOk } from './testing/result'

describe('fail / ctx', () => {
  it('creates and enriches errors', () => {
    const e = expectErrCode(
      fail('persist.io', 'x', { where: 'read' }).mapErr(ctx('load', { id: 1 })),
      'persist.io',
    )
    expect(e.frames.map((f) => f.where)).toEqual(['read', 'load'])
  })
})

describe('tryCatch / tryAsync', () => {
  it('wraps throws and passes AppErrors through unchanged', () => {
    const r = tryCatch(() => JSON.parse('{nope') as unknown, 'input.malformed', 'bad json')
    expect(expectErrCode(r, 'input.malformed').cause).toBeInstanceOf(SyntaxError)
    const original = new AppError('persist.io', 'x')
    const passed = tryCatch(
      () => {
        throw original
      },
      'internal.unexpected',
      'y',
    )
    expect(passed.unwrapErr()).toBe(original)
    expect(expectOk(tryCatch(() => 1, 'internal.unexpected', 'y'))).toBe(1)
  })

  it('maps AbortError to op.aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await tryAsync(
      () => new Promise((_, rej) => rej(ac.signal.reason)),
      'external.failure',
      'job failed',
    )
    expectErrCode(r, 'op.aborted')
    expectErrCode(
      await tryAsync(() => Promise.reject(new Error('x')), 'external.failure', 'm'),
      'external.failure',
    )
  })
})

describe('collect', () => {
  const inv = (p: string) =>
    fail('model.invariant', p, { issues: [{ path: [p], rule: 'r', message: 'm' }] })

  it('merges all invariant issues', () => {
    const e = expectErrCode(collect([Ok(1), inv('a'), inv('b')]), 'model.invariant')
    expect(e.issues.map((i) => i.path[0])).toEqual(['a', 'b'])
    expect(expectOk(collect([Ok(1), Ok(2)]))).toEqual([1, 2])
  })

  it('short-circuits on other codes', () => {
    expectErrCode(collect([inv('a'), fail('persist.io', 'x'), inv('b')]), 'persist.io')
  })
})

describe('wire format', () => {
  it('oxide values do NOT survive cloning (why ResultWire exists)', () => {
    expect(JSON.stringify(Some(5))).toBe('{}')
    expect(structuredClone(Ok(1))).toEqual({})
  })

  it('round-trips Ok and Err through structuredClone', () => {
    expect(expectOk(fromWire(structuredClone(toWire(Ok({ a: 1 })))))).toEqual({ a: 1 })
    const err = fail('model.invariant', 'x', {
      issues: [{ path: ['angleDeg'], rule: 'range', message: 'm' }],
    })
    const back = expectErrCode(fromWire(structuredClone(toWire(err))), 'model.invariant')
    expect(back).toBeInstanceOf(AppError)
    expect(back.issues[0]?.path).toEqual(['angleDeg'])
  })
})

describe('Option pitfalls', () => {
  it('Option.from treats 0 as None – never use it for numbers', () => {
    expect(Option.from(0).isNone()).toBe(true)
    expect(Option.nonNull(0).isSome()).toBe(true)
  })
})
