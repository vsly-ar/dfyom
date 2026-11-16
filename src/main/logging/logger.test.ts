import { readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error'
import { fileStamp, installCrashHandlers, redactPaths } from './logger'
import { ID, lines, NAME, openLogging, useTempDir } from './test-support'

const tmp = useTempDir()
const open = (extra: { rotateBytes?: number } = {}) => openLogging(tmp.dir, extra)

describe('createMainLogging', () => {
  it('writes JSON lines with the root fields to <startedAt>-<instance>.<n>.log', async () => {
    const logging = await open()
    expect(logging.file()).toBe(join(tmp.dir, `${NAME}.1.log`))
    logging.log.child({ scope: 'test' }).info({ n: 1 }, 'hello')
    logging.log.debug('below level')
    await logging.close()
    expect(await readdir(tmp.dir)).toEqual([`${NAME}.1.log`])
    const out = await lines(logging.file())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      level: 30,
      msg: 'hello',
      proc: 'main',
      instance: ID,
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

  it('redacts secrets from the top level to 4 levels deep', async () => {
    const logging = await open()
    logging.log.info(
      {
        token: 't',
        a: {
          password: 'p',
          b: { apiKey: 'k', c: { cookie: 'c', d: { secret: 's', e: { token: 'deep' } } } },
        },
        ok: 'visible',
      },
      'r',
    )
    await logging.close()
    const [r] = await lines(logging.file())
    expect(r).toMatchObject({
      token: '[redacted]',
      ok: 'visible',
      a: {
        password: '[redacted]',
        b: { apiKey: '[redacted]', c: { cookie: '[redacted]', d: { secret: '[redacted]' } } },
      },
    })
    // Beyond 4 levels pino has no wildcard: documented limit.
    expect(JSON.stringify(r)).toContain('"token":"deep"')
    expect(redactPaths(['k'], 2)).toEqual(['k', '*.k', '*.*.k'])
  })

  it('redacts lower-case, capitalized and upper-case key variants', async () => {
    const logging = await open()
    logging.log.info(
      {
        Authorization: 'a',
        headers: { Authorization: 'b', COOKIE: 'c' },
        ApiKey: 'k',
        APIKEY: 'k2',
        api_key: 'k3',
        Password: 'p',
      },
      'r',
    )
    await logging.close()
    const [r] = await lines(logging.file())
    expect(r).toMatchObject({
      Authorization: '[redacted]',
      headers: { Authorization: '[redacted]', COOKIE: '[redacted]' },
      ApiKey: '[redacted]',
      APIKEY: '[redacted]',
      api_key: '[redacted]',
      Password: '[redacted]',
    })
  })

  it('rotates by size and keeps writing to the next numbered file', async () => {
    const logging = await open({ rotateBytes: 2_000 })
    for (let i = 0; i < 60; i++) logging.log.info({ i, pad: 'x'.repeat(50) }, 'line')
    await new Promise((r) => setTimeout(r, 100))
    for (let i = 0; i < 5; i++) logging.log.info({ i }, 'after')
    await logging.close()
    const files = await readdir(tmp.dir)
    expect(files.length).toBeGreaterThan(1)
    expect(files.every((f) => f.startsWith(`${NAME}.`) && f.endsWith('.log'))).toBe(true)
  })

  it('cleans old DFYOM files at startup and leaves other files alone', async () => {
    const t = new Date('2026-10-01T00:00:00Z')
    const old = `2026-10-01T00-00-00Z-${ID.replace('0f8e', 'aaaa')}.3.log`
    for (const name of [old, 'other-app.log']) {
      await writeFile(join(tmp.dir, name), 'x')
      await utimes(join(tmp.dir, name), t, t)
    }
    const logging = await open()
    await logging.close()
    const files = await readdir(tmp.dir)
    expect(files).not.toContain(old)
    expect(files).toContain('other-app.log')
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
