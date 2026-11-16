import { describe, expect, it } from 'vitest'
import { AppError } from './app-error'

describe('AppError', () => {
  it('derives severity and userMessage from the registry', () => {
    const e = new AppError('op.aborted', 'cancelled')
    expect(e.severity).toBe('info')
    expect(e.userMessage).toBe('The operation was cancelled.')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('AppError')
  })

  it('withContext returns a copy with one more frame and the original stack', () => {
    const e = new AppError('persist.io', 'cannot read', { where: 'readFile', data: { path: 'a' } })
    const top = e.withContext('loadProject', { id: 'p1' })
    expect(top.frames).toEqual([
      { where: 'readFile', data: { path: 'a' } },
      { where: 'loadProject', data: { id: 'p1' } },
    ])
    expect(top.stack).toBe(e.stack)
    expect(e.frames).toHaveLength(1)
  })

  it('prefixIssues prefixes paths and keeps frames', () => {
    const e = new AppError('model.invariant', 'bad', {
      issues: [{ path: ['sizeMm'], rule: 'positive', message: 'x' }],
      where: 'Chamfer.create',
    })
    const p = e.prefixIssues('chamfers', 1)
    expect(p.issues[0]?.path).toEqual(['chamfers', 1, 'sizeMm'])
    expect(p.frames).toEqual(e.frames)
    expect(e.issues[0]?.path).toEqual(['sizeMm'])
  })

  it('round-trips through JSON, including nested and foreign causes', () => {
    const inner = new AppError('persist.io', 'disk', { cause: new TypeError('boom') })
    const e = new AppError('persist.migration', 'outer', { cause: inner, where: 'migrate' })
    const json = JSON.parse(JSON.stringify(e)) as ReturnType<AppError['toJSON']>
    expect(json.cause).toMatchObject({
      code: 'persist.io',
      cause: { name: 'TypeError', message: 'boom' },
    })
    const back = AppError.fromJSON(json)
    expect(back).toBeInstanceOf(AppError)
    expect(back.code).toBe('persist.migration')
    expect(back.frames).toEqual([{ where: 'migrate' }])
    expect(back.stack).toBe(e.stack)
  })
})
