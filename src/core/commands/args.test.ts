// parseArgs: unknown keys at any depth, with a hint naming the closest valid key.
// Spec: docs/architecture/llm-api.md#a5-unknown-arguments-and-projectclose
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { closest, parseArgs } from './args'

const Wait = z.object({
  jobId: z.string(),
  timeoutSeconds: z.number().default(30),
})

const Shape = z.object({
  partId: z.string(),
  items: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('circle'), center: z.array(z.number()), diameter: z.string() }),
      z.object({ kind: z.literal('rectangle'), length: z.string(), width: z.string() }),
    ]),
  ),
  options: z.object({ depth: z.string().optional() }).optional(),
})

describe('parseArgs', () => {
  it('accepts known keys and defaults', () => {
    expect(expectOk(parseArgs(Wait, { jobId: 'j1' }, 'job.wait'))).toEqual({
      jobId: 'j1',
      timeoutSeconds: 30,
    })
  })

  it('names the closest valid key of an unknown one', () => {
    for (const wrong of ['timeout', 'timeoutMs', 'timeoutSecond', 'TimeoutSeconds']) {
      const e = expectErrCode(parseArgs(Wait, { jobId: 'j1', [wrong]: 5 }, 'job.wait'), 'input.malformed')
      expect(e.message).toBe(`job.wait: unknown argument "${wrong}"; did you mean "timeoutSeconds"?`)
      expect(e.issues[0]).toMatchObject({
        path: [wrong],
        rule: 'unrecognized_keys',
        params: { key: wrong, suggestion: 'timeoutSeconds', valid: ['jobId', 'timeoutSeconds'] },
      })
    }
  })

  it('gives no suggestion for an unrelated key, but lists the valid ones', () => {
    const e = expectErrCode(parseArgs(Wait, { jobId: 'j', colour: 1 }, 'job.wait'), 'input.malformed')
    expect(e.message).toBe('job.wait: unknown argument "colour"')
    expect(e.issues[0]?.params).toEqual({ key: 'colour', valid: ['jobId', 'timeoutSeconds'] })
  })

  it('walks nested objects, arrays and discriminated unions', () => {
    const e = expectErrCode(
      parseArgs(
        Shape,
        {
          partId: 'p',
          items: [
            { kind: 'circle', center: [0, 0], diameter: '6 mm' },
            { kind: 'rectangle', length: '1', width: '2', widht: '3' },
          ],
          options: { dept: '1' },
        },
        'design.shape.add',
      ),
      'input.malformed',
    )
    expect(e.message).toBe(
      'design.shape.add: unknown argument "widht"; did you mean "width"? (+ 1 more)',
    )
    expect(e.issues.map((i) => [i.path, i.params?.['suggestion']])).toEqual([
      [['items', 1, 'widht'], 'width'],
      [['options', 'dept'], 'depth'],
    ])
    expect(e.issues[0]?.params?.['valid']).toEqual(['kind', 'length', 'width'])
  })

  it('names the first malformed value in the message', () => {
    const e = expectErrCode(parseArgs(Wait, {}, 'job.wait'), 'input.malformed')
    expect(e.message).toMatch(/^job\.wait: jobId: /)
  })
})

describe('closest', () => {
  it('prefers a close spelling, accepts containment, rejects unrelated names', () => {
    expect(closest('key', ['key', 'keys'])).toBe('key')
    expect(closest('dept', ['depth', 'diameter'])).toBe('depth')
    expect(closest('stockId', ['stockLibraryItemId', 'stock'])).toBe('stock')
    expect(closest('x', ['y', 'z'])).toBeUndefined()
    expect(closest('apply', ['jobId', 'timeoutSeconds'])).toBeUndefined()
  })
})
