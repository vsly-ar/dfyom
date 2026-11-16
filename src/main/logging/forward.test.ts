import { describe, expect, it } from 'vitest'
import { createLogReporter } from '../../shared/logging'
import { createForwardReceiver, type ForwardLimits } from './forward'
import type { MainLogging } from './logger'
import { ID, lines, openLogging, useTempDir } from './test-support'

const tmp = useTempDir()

/** Manual clock and timers for the token bucket and the drop summary. */
function clock() {
  let t = 0
  const timers: { fn: () => void; at: number }[] = []
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): void => void timers.push({ fn, at: t + ms }),
    advance(ms: number): void {
      t += ms
      for (const h of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(h), 1)
        h.fn()
      }
    },
  }
}

const receiver = (logging: MainLogging, c = clock(), limits: Partial<ForwardLimits> = {}) =>
  createForwardReceiver(logging, createLogReporter(logging.log), {
    now: c.now,
    setTimer: c.setTimer,
    ...limits,
  })

const DROPPED = 'forwarded log entries dropped'

describe('createForwardReceiver', () => {
  it('nests forwarded fields under fwd, stamps the origin, redacts', async () => {
    const logging = await openLogging(tmp.dir)
    await receiver(logging)(
      [
        {
          level: 'warn',
          msg: 'w',
          scope: 'boundary',
          entry: { kind: 'agent', name: 'forged' },
          err: { code: 'forged' },
          proc: 'main',
          instance: 'forged',
          a: { headers: { Authorization: 'x' } },
        },
        { level: 'debug', msg: 'below level' },
      ],
      { proc: 'renderer', win: 3 },
    )
    await logging.close()
    const out = await lines(logging.file())
    expect(out).toHaveLength(1)
    const r = out[0] ?? {}
    expect(r).toMatchObject({ level: 40, msg: 'w', proc: 'renderer', win: 3, instance: ID })
    expect(r['fwd']).toEqual({
      scope: 'boundary',
      entry: { kind: 'agent', name: 'forged' },
      err: { code: 'forged' },
      proc: 'main',
      instance: 'forged',
      a: { headers: { Authorization: '[redacted]' } },
    })
    // Nothing forwarded reaches the top level.
    expect(Object.keys(r).sort()).toEqual(
      ['app', 'fwd', 'instance', 'level', 'msg', 'pid', 'proc', 'time', 'win'].sort(),
    )
  })

  it('cuts deep fields, replaces oversized fields, truncates long messages', async () => {
    const logging = await openLogging(tmp.dir)
    await receiver(logging, clock(), { maxEntryBytes: 1_000, maxDepth: 3, maxMsgChars: 10 })(
      [
        { level: 'info', msg: 'x'.repeat(50), a: { b: { c: { d: 1 } } } },
        { level: 'info', msg: 'big', blob: 'y'.repeat(5_000) },
      ],
      { proc: 'renderer' },
    )
    await logging.close()
    const [deep, big] = await lines(logging.file())
    expect(deep?.['msg']).toBe('xxxxxxxxxx…')
    expect(deep?.['fwd']).toEqual({ a: { b: { c: '[depth]' } } })
    expect(big?.['fwd']).toEqual({ truncated: true, bytes: expect.any(Number) as number })
  })

  it('caps the bytes written per batch and logs one drop summary', async () => {
    const logging = await openLogging(tmp.dir)
    const c = clock()
    const receive = receiver(logging, c, { maxBatchBytes: 3_000, maxEntryBytes: 2_000 })
    const big = { level: 'info', msg: 'm', blob: 'z'.repeat(1_500) }
    await receive([big, big, big, big], { proc: 'renderer', win: 1 })
    c.advance(1_000)
    await logging.close()
    const out = await lines(logging.file())
    expect(out.filter((r) => r['msg'] === 'm')).toHaveLength(1)
    expect(out.filter((r) => r['msg'] === DROPPED)).toEqual([
      expect.objectContaining({
        level: 40,
        proc: 'main',
        dropped: 3,
        from: { proc: 'renderer', win: 1 },
      }),
    ])
  })

  it('rate-limits each sender with a token bucket, malformed batches included', async () => {
    const logging = await openLogging(tmp.dir)
    const c = clock()
    const receive = receiver(logging, c, { perSecond: 5, burst: 5 })
    for (let i = 0; i < 4; i++)
      await receive([{ level: 'info', msg: 'ok' }], { proc: 'renderer', win: 1 })
    for (let i = 0; i < 10; i++) await receive('garbage', { proc: 'renderer', win: 1 })
    // Another sender has its own bucket. An entry without fields has no `fwd`.
    await receive([{ level: 'info', msg: 'other' }], { proc: 'renderer', win: 2 })
    c.advance(1_000)
    await logging.close()
    const out = await lines(logging.file())
    expect(out.filter((r) => r['msg'] === 'ok')).toHaveLength(4)
    const other = out.filter((r) => r['msg'] === 'other')
    expect(other).toHaveLength(1)
    expect(other[0]).not.toHaveProperty('fwd')
    const malformed = out.filter(
      (r) => (r['err'] as { code?: string } | undefined)?.code === 'input.malformed',
    )
    expect(malformed).toHaveLength(1)
    expect(out.filter((r) => r['msg'] === DROPPED)).toEqual([
      expect.objectContaining({ dropped: 9, from: { proc: 'renderer', win: 1 } }),
    ])
  })

  it('reports a malformed batch as input.malformed', async () => {
    const logging = await openLogging(tmp.dir)
    await receiver(logging)([{ level: 'loud', msg: 1 }], { proc: 'renderer' })
    await logging.close()
    const out = await lines(logging.file())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      level: 40,
      proc: 'main',
      err: { code: 'input.malformed' },
      entry: { kind: 'system', name: 'logging.forward' },
    })
  })
})
