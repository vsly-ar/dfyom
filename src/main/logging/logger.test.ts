import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error'
import { createLogReporter } from '../../shared/logging'
import { createForwardReceiver } from './forward'
import { createMainLogging, fileStamp, installCrashHandlers, redactPaths } from './logger'
import { cleanupLogs, type RetentionFs } from './retention'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfyom-log-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const lines = async (file: string): Promise<Record<string, unknown>[]> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const open = (extra: { rotateBytes?: number } = {}) =>
  createMainLogging({
    dir,
    level: 'info',
    instance: 'i-1',
    app: '0.0.0',
    proc: 'main',
    startedAt: new Date('2026-11-16T10:20:30.123Z'),
    ...extra,
  })

describe('createMainLogging', () => {
  it('writes JSON lines with the root fields to <startedAt>-<instance>.<n>.log', async () => {
    const logging = await open()
    expect(logging.file()).toBe(join(dir, '2026-11-16T10-20-30Z-i-1.1.log'))
    logging.log.child({ scope: 'test' }).info({ n: 1 }, 'hello')
    logging.log.debug('below level')
    await logging.close()
    const file = join(dir, '2026-11-16T10-20-30Z-i-1.1.log')
    expect(await readdir(dir)).toEqual(['2026-11-16T10-20-30Z-i-1.1.log'])
    const out = await lines(file)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      level: 30,
      msg: 'hello',
      proc: 'main',
      instance: 'i-1',
      app: '0.0.0',
      scope: 'test',
      n: 1,
    })
    expect(typeof out[0]?.['time']).toBe('number')
    expect(out[0]?.['pid']).toBe(process.pid)
  })

  it('serializes AppError via toJSON and other errors via pino', async () => {
    const logging = await open()
    logging.log.error({ err: new AppError('persist.io', 'disk full', { where: 'save' }) }, 'a')
    logging.log.error({ err: new TypeError('bad') }, 'b')
    await logging.close()
    const [a, b] = await lines(logging.file())
    expect(a?.['err']).toMatchObject({ code: 'persist.io', frames: [{ where: 'save' }] })
    expect(b?.['err']).toMatchObject({ type: 'TypeError', message: 'bad' })
  })

  it('redacts secrets from the top level to 3 levels deep', async () => {
    const logging = await open()
    logging.log.info(
      {
        token: 't',
        a: { password: 'p', b: { apiKey: 'k', c: { cookie: 'c', d: { secret: 's' } } } },
        ok: 'visible',
      },
      'r',
    )
    await logging.close()
    const [r] = await lines(logging.file())
    expect(r).toMatchObject({
      token: '[redacted]',
      ok: 'visible',
      a: { password: '[redacted]', b: { apiKey: '[redacted]', c: { cookie: '[redacted]' } } },
    })
    // Beyond 3 levels pino has no wildcard: documented limit.
    expect(JSON.stringify(r)).toContain('"secret":"s"')
    expect(redactPaths(['k'], 2)).toEqual(['k', '*.k', '*.*.k'])
  })

  it('rotates by size and keeps writing to the next numbered file', async () => {
    const logging = await open({ rotateBytes: 2_000 })
    for (let i = 0; i < 60; i++) logging.log.info({ i, pad: 'x'.repeat(50) }, 'line')
    await new Promise((r) => setTimeout(r, 100))
    for (let i = 0; i < 5; i++) logging.log.info({ i }, 'after')
    await logging.close()
    const files = (await readdir(dir)).sort()
    expect(files.length).toBeGreaterThan(1)
    expect(files.every((f) => /^2026-11-16T10-20-30Z-i-1\.\d+\.log$/.test(f))).toBe(true)
  })

  it('cleans the folder at startup', async () => {
    const old = join(dir, 'old.log')
    await writeFile(old, 'x')
    const t = new Date('2026-10-01T00:00:00Z')
    await utimes(old, t, t)
    const logging = await open()
    await logging.close()
    expect(await readdir(dir)).not.toContain('old.log')
  })

  it('fileStamp is file-system safe', () => {
    expect(fileStamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03-04-05Z')
  })
})

describe('installCrashHandlers', () => {
  it('logs internal.unexpected at fatal, flushes, exits 1', async () => {
    const logging = await open()
    const handlers = new Map<string, (e: unknown) => void>()
    const exits: number[] = []
    installCrashHandlers(logging, (c) => exits.push(c), {
      on: ((ev: string, fn: (e: unknown) => void) => handlers.set(ev, fn)) as never,
    })
    handlers.get('unhandledRejection')?.(new Error('boom'))
    expect(exits).toEqual([1])
    await logging.close()
    const [r] = await lines(logging.file())
    expect(r).toMatchObject({ level: 60, err: { code: 'internal.unexpected' } })
  })
})

describe('forward receiver', () => {
  it('writes forwarded entries with origin, strips reserved keys, redacts', async () => {
    const logging = await open()
    const receive = createForwardReceiver(logging.base, createLogReporter(logging.log))
    await receive(
      [
        { level: 'warn', msg: 'w', scope: 'ui', proc: 'main', instance: 'forged', token: 'x' },
        { level: 'debug', msg: 'below level' },
      ],
      { proc: 'renderer', win: 3 },
    )
    await logging.close()
    const out = await lines(logging.file())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      level: 40,
      msg: 'w',
      scope: 'ui',
      proc: 'renderer',
      win: 3,
      instance: 'i-1',
      token: '[redacted]',
    })
    // No duplicate keys from the forwarded entry.
    const raw = await readFile(logging.file(), 'utf8')
    expect(raw.match(/"proc"/g)).toHaveLength(1)
  })

  it('reports a malformed batch once as input.malformed', async () => {
    const logging = await open()
    const receive = createForwardReceiver(logging.base, createLogReporter(logging.log))
    await receive([{ level: 'loud', msg: 1 }], { proc: 'renderer' })
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

describe('cleanupLogs', () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-11-16T00:00:00Z')
  const make = async (name: string, ageDays: number, size: number): Promise<string> => {
    const p = join(dir, name)
    await writeFile(p, Buffer.alloc(size))
    const t = new Date(now - ageDays * day)
    await utimes(p, t, t)
    return p
  }

  it('deletes files older than 14 days, then oldest first down to the size cap', async () => {
    await make('a.log', 20, 10)
    await make('b.log', 5, 100)
    await make('c.log', 3, 100)
    const active = await make('d.log', 2, 100)
    await make('notes.txt', 30, 10)
    const r = await cleanupLogs({ dir, now, maxTotalBytes: 150, keep: [active] })
    expect(r.deleted.map((p) => p.slice(dir.length + 1))).toEqual(['a.log', 'b.log', 'c.log'])
    expect((await readdir(dir)).sort()).toEqual(['d.log', 'notes.txt'])
    expect((await stat(active)).size).toBe(100)
  })

  it('never deletes kept files and reports unlink failures', async () => {
    const kept = await make('old-active.log', 30, 10)
    await make('locked.log', 30, 10)
    const fs: RetentionFs = {
      readdir: (d) => readdir(d),
      stat: (p) => stat(p),
      unlink: async () => {
        throw new Error('EBUSY')
      },
    }
    const r = await cleanupLogs({ dir, now, keep: [kept], fs })
    expect(r.deleted).toEqual([])
    expect(r.failed).toEqual([{ file: join(dir, 'locked.log'), error: 'Error: EBUSY' }])
  })

  it('reports a missing folder instead of throwing', async () => {
    const r = await cleanupLogs({ dir: join(dir, 'nope'), now })
    expect(r.failed).toHaveLength(1)
  })
})
