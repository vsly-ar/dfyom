import { describe, expect, it } from 'vitest'
import { atBoundary } from './boundary'
import { AppError } from './errors/app-error'
import {
  createEntryLogger,
  createLogForwarder,
  createLogReporter,
  flagValue,
  logAppError,
  resolveLogLevel,
  serializeErr,
  timed,
  type LogRecord,
} from './logging'
import { Err, Ok } from './result'
import { createTestLogger } from './testing/logger'

describe('resolveLogLevel', () => {
  it('defaults to info packaged and debug in dev', () => {
    expect(resolveLogLevel({ isDev: false })).toEqual({ level: 'info', ignored: [] })
    expect(resolveLogLevel({ isDev: true }).level).toBe('debug')
  })

  it('takes the env var, and the flag over the env var', () => {
    expect(resolveLogLevel({ isDev: false, env: 'TRACE' }).level).toBe('trace')
    expect(resolveLogLevel({ isDev: false, env: 'trace', argv: ['--log-level=warn'] }).level).toBe(
      'warn',
    )
    expect(resolveLogLevel({ isDev: true, argv: ['app', '--log-level', 'error'] }).level).toBe(
      'error',
    )
  })

  it('ignores invalid values and reports them', () => {
    const r = resolveLogLevel({ isDev: false, env: 'loud', argv: ['--log-level=verbose'] })
    expect(r).toEqual({ level: 'info', ignored: ['verbose', 'loud'] })
  })

  it('flagValue uses the last occurrence', () => {
    expect(flagValue(['--x=1', '--x', '2'], '--x')).toBe('2')
    expect(flagValue(['--xy=1'], '--x')).toBeUndefined()
  })
})

describe('serializeErr', () => {
  it('serializes AppError via toJSON, keeping code and frames', () => {
    const e = new AppError('persist.io', 'disk full', { where: 'persist.save', data: { n: 1 } })
    const s = serializeErr(e) as ReturnType<AppError['toJSON']>
    expect(s.code).toBe('persist.io')
    expect(s.frames).toEqual([{ where: 'persist.save', data: { n: 1 } }])
  })

  it('uses the fallback for other errors and passes non-errors through', () => {
    expect(serializeErr(new TypeError('x'), (e) => ({ t: e.name }))).toEqual({ t: 'TypeError' })
    expect(serializeErr(new Error('y'))).toMatchObject({ type: 'Error', message: 'y' })
    expect(serializeErr({ code: 'plain' })).toEqual({ code: 'plain' })
  })
})

describe('logAppError and the boundary reporter', () => {
  it('logs once at the code severity with err and entry', () => {
    const log = createTestLogger()
    logAppError(log, new AppError('quantity.unit', 'bad unit'), { kind: 'ui', name: 'x.y' })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({
      level: 'warn',
      err: { code: 'quantity.unit' },
      entry: { kind: 'ui', name: 'x.y' },
    })
  })

  it('atBoundary with the log reporter logs a failure exactly once', async () => {
    const log = createTestLogger()
    const report = createLogReporter(log)
    await atBoundary(
      { kind: 'agent', name: 'a.b' },
      () => Err(new AppError('persist.io', 'nope')),
      report,
    )
    await atBoundary({ kind: 'agent', name: 'a.b' }, () => Ok(1), report)
    expect(log.entries.map((e) => [e.level, (e['err'] as { code: string }).code])).toEqual([
      ['error', 'persist.io'],
    ])
  })
})

describe('createEntryLogger / createTestLogger', () => {
  it('filters by level, merges child bindings and serializes err', () => {
    const records: LogRecord[] = []
    const log = createEntryLogger({ level: 'info', write: (r) => records.push(r) })
    const child = log.child({ scope: 'persist.save' })
    child.debug('hidden')
    child.info({ err: new AppError('op.aborted', 'stop'), n: 2 }, 'saved')
    expect(log.isLevelEnabled('debug')).toBe(false)
    expect(records).toEqual([
      expect.objectContaining({ level: 'info', scope: 'persist.save', n: 2, msg: 'saved' }),
    ])
    expect((records[0]?.['err'] as { code: string }).code).toBe('op.aborted')
  })

  it('test logger children share entries', () => {
    const log = createTestLogger()
    log.child({ scope: 'a' }).warn('w')
    expect(log.at('warn')).toEqual([{ scope: 'a', level: 'warn', msg: 'w' }])
    log.clear()
    expect(log.entries).toEqual([])
  })
})

describe('timed', () => {
  it('logs ms at debug and returns the result; warn above budget', async () => {
    const log = createTestLogger()
    let t = 0
    const now = (): number => t
    expect(timed(log, 'sync', () => ((t += 5), 42), { now })).toBe(42)
    await expect(
      timed(log, 'async', async () => ((t += 50), 'ok'), { now, budgetMs: 10, fields: { n: 1 } }),
    ).resolves.toBe('ok')
    expect(log.entries).toEqual([
      { level: 'debug', msg: 'sync', ms: 5 },
      { level: 'warn', msg: 'async', ms: 50, n: 1 },
    ])
  })

  it('logs and rethrows when fn throws', () => {
    const log = createTestLogger()
    expect(() =>
      timed(log, 'boom', () => {
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(log.entries).toHaveLength(1)
  })
})

describe('createLogForwarder', () => {
  function harness(opts: { maxPerSecond?: number } = {}) {
    let t = 0
    const timers: { fn: () => void; at: number }[] = []
    const batches: (readonly LogRecord[])[] = []
    const fwd = createLogForwarder({
      send: (b) => batches.push(b),
      now: () => t,
      setTimer: (fn, ms) => {
        const h = { fn, at: t + ms }
        timers.push(h)
        return h
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      },
      ...opts,
    })
    const advance = (ms: number): void => {
      t += ms
      for (const h of [...timers].sort((a, b) => a.at - b.at)) {
        if (h.at <= t && timers.includes(h)) {
          timers.splice(timers.indexOf(h), 1)
          h.fn()
        }
      }
    }
    return { fwd, batches, advance }
  }
  const rec = (i: number): LogRecord => ({ level: 'info', msg: 'm', i })

  it('sends after 100 ms', () => {
    const { fwd, batches, advance } = harness()
    fwd.push(rec(1))
    fwd.push(rec(2))
    advance(99)
    expect(batches).toHaveLength(0)
    advance(1)
    expect(batches).toEqual([[rec(1), rec(2)]])
  })

  it('sends at 50 entries without waiting', () => {
    const { fwd, batches } = harness()
    for (let i = 0; i < 120; i++) fwd.push(rec(i))
    expect(batches.map((b) => b.length)).toEqual([50, 50])
    fwd.flush()
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20])
  })

  it('drops beyond the per-second limit and reports one warn with the count', () => {
    const { fwd, batches, advance } = harness()
    for (let i = 0; i < 1_250; i++) fwd.push(rec(i))
    advance(1_000)
    const all = batches.flat()
    expect(all.filter((r) => r.msg === 'm')).toHaveLength(1_000)
    expect(all.filter((r) => r.level === 'warn')).toEqual([
      { level: 'warn', msg: 'log entries dropped', scope: 'logging', dropped: 250 },
    ])
    // New window accepts entries again.
    fwd.push(rec(9))
    fwd.flush()
    expect(batches.at(-1)).toEqual([rec(9)])
  })

  it('flush reports pending drops immediately', () => {
    const { fwd, batches } = harness({ maxPerSecond: 2 })
    for (let i = 0; i < 5; i++) fwd.push(rec(i))
    fwd.flush()
    expect(batches.flat().at(-1)).toMatchObject({ level: 'warn', dropped: 3 })
  })
})
