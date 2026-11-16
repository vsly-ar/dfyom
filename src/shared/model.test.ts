import { describe, expect, it } from 'vitest'
import { AppError } from './errors/app-error'
import { construct } from './model'
import { Chamfer, EdgeTreatment, previewChamferArea } from './testing/chamfer.fixture'
import { expectErrCode, expectOk } from './testing/result'

describe('invariant models', () => {
  it('creates valid models and freezes them', () => {
    expect(Object.isFrozen(expectOk(Chamfer.create({ angleDeg: 45, sizeMm: 1 })))).toBe(true)
  })

  it('accepts valid boundaries and rejects invalid ones', () => {
    expectOk(Chamfer.create({ angleDeg: 89.9, sizeMm: 0.001 }))
    for (const angleDeg of [0, 90, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = expectErrCode(Chamfer.create({ angleDeg, sizeMm: 1 }), 'model.invariant')
      expect(e.issues.map((i) => i.rule)).toEqual(['range'])
    }
  })

  it('reports ALL violated invariants as issues', () => {
    const e = expectErrCode(Chamfer.create({ angleDeg: 120, sizeMm: -1 }), 'model.invariant')
    expect(e.issues.map((i) => i.path.join('.'))).toEqual(['angleDeg', 'sizeMm'])
    expect(e.issues[0]?.params).toEqual({ min: 0, max: 90, actual: 120 })
    expect(e.frames[0]?.where).toBe('Chamfer.create')
  })

  it('with() re-validates and leaves the original unchanged', () => {
    const c = expectOk(Chamfer.create({ angleDeg: 45, sizeMm: 1 }))
    expectErrCode(c.with({ sizeMm: 0 }), 'model.invariant')
    expect(expectOk(c.with({ sizeMm: 2 })).sizeMm).toBe(2)
    expect(c.sizeMm).toBe(1)
  })

  it('composite collects child issues with prefixed paths, then checks cross-field rules', () => {
    const bad = EdgeTreatment.create({
      chamfers: [
        { angleDeg: 45, sizeMm: 1 },
        { angleDeg: 0, sizeMm: 0 },
      ],
      maxTotalMm: 5,
    })
    expect(expectErrCode(bad, 'model.invariant').issues.map((i) => i.path.join('.'))).toEqual([
      'chamfers.1.angleDeg',
      'chamfers.1.sizeMm',
    ])
    const tooBig = EdgeTreatment.create({
      chamfers: [
        { angleDeg: 45, sizeMm: 3 },
        { angleDeg: 45, sizeMm: 3 },
      ],
      maxTotalMm: 5,
    })
    expect(expectErrCode(tooBig, 'model.invariant').issues[0]?.rule).toBe('maxTotal')
  })

  it('classifies constructor throws', () => {
    const bug = expectErrCode(
      construct('Broken', () => {
        throw new TypeError('x is undefined')
      }),
      'internal.unexpected',
    )
    expect(bug.cause).toBeInstanceOf(TypeError)
    const app = expectErrCode(
      construct('Io', () => {
        throw new AppError('persist.io', 'x')
      }),
      'persist.io',
    )
    expect(app.frames.map((f) => f.where)).toEqual(['Io.create'])
  })
})

describe('call-chain enrichment', () => {
  it('adds frames innermost-first', () => {
    const e = expectErrCode(
      previewChamferArea('p1', { angleDeg: 95, sizeMm: 1 }),
      'model.invariant',
    )
    expect(e.frames.map((f) => f.where)).toEqual(['Chamfer.create', 'addChamferToPart'])
    expect(e.frames[1]?.data).toEqual({ partId: 'p1' })
  })
})
