// Headless snap and measure (hardening A6): the candidates the viewport's measure would snap to,
// ranked as the snap engine ranks, and point distances and angles.
// Doc: docs/architecture/llm-api.md#a6-designmeasure-headless-snap-and-measure
import { beforeAll, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { inProcessWorkers } from '../commands/jobs'
import { agentSource } from '../commands/testing'
import type { QueryContext } from '../commands/context'
import { evaluatePart, type PartEvaluation } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { angleAt, measureBetween } from '../geometry/measure'
import type { SolidKernel } from '../geometry/solid-port'
import { buildTestPart, designSetup, type DesignSetup } from './design.fixture'
import type { EvaluationService } from './evaluation'
import { partGeometryInput } from './load'
import { designMeasure } from './measure'

let kernel: SolidKernel
let s: DesignSetup
let mesh: PartEvaluation

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
  s = await designSetup()
  await buildTestPart(s)
  const input = expectOk(partGeometryInput(s.d.doc, s.partId))
  mesh = expectOk(kernel.withSolids((solids) => evaluatePart(input, solids)))
})

const evaluations = (done: boolean): EvaluationService => ({
  state: () => (done ? { status: 'done', evaluation: mesh } : { status: 'pending' }),
  evaluate: () => Promise.reject(new Error('not used')),
})

const ctx = (done: boolean): QueryContext => ({
  source: agentSource(),
  services: { workers: inProcessWorkers, evaluations: evaluations(done) },
})

const measure = (args: object, done = true) =>
  designMeasure.run(s.d.doc, designMeasure.args.parse({ partId: s.partId, ...args }), ctx(done))

describe('point measures (core, shared with the viewport)', () => {
  it('gives the distance with its components and the angle at a vertex', () => {
    expect(measureBetween([0, 0, 0], [3, 4, 0])).toEqual({ distance: 5, deltas: [3, 4, 0] })
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 2, 0])).toBeCloseTo(90)
    expect(angleAt([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBeCloseTo(180)
    expect(angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeUndefined()
  })
})

describe('design.measure: snap', () => {
  it('without the evaluation lists the document targets only: part zero first', () => {
    const r = expectOk(measure({ near: [0.2, 0, 0], radius: 1 }, false))
    expect(r.evaluation).toBe('pending')
    expect(r.candidates).toEqual([{ kind: 'partZero', at: [0, 0, 0], distance: 0.2 }])
  })

  it('finds a hole centre at the mouth of a drilling, with its operation as ref', () => {
    const r = expectOk(measure({ near: [15, 15, -0.4], radius: 1 }, false))
    expect(r.candidates?.[0]).toMatchObject({ kind: 'holeCentre', ref: 'drill1' })
    expect(r.candidates?.[0]?.at[0]).toBe(15)
    expect(r.candidates?.[0]?.at[1]).toBe(15)
  })

  it('with the evaluation adds face centres, vertices and the nearest feature edge', () => {
    const floor = expectOk(measure({ near: [50, 30, -8.4], radius: 0.5 }))
    expect(floor.evaluation).toBe('done')
    expect(floor.candidates?.[0]).toMatchObject({
      kind: 'faceCentre',
      ref: 'pocket1.floor',
      at: [50, 30, -8.5],
    })
    // the pocket's straight rim at x = 30, on the facing floor (z = −0.5)
    const rim = expectOk(measure({ near: [30.3, 30, -0.3], radius: 1 }))
    const edge = rim.candidates?.find((c) => c.kind === 'edge')
    expect(edge?.at).toEqual([30, 30, -0.5])
    // a stock corner is also a mesh vertex: points rank before edges, then the nearest
    const corner = expectOk(measure({ near: [100, 60, -19.5], radius: 1 }))
    const kinds = corner.candidates!.map((c) => c.kind)
    expect(kinds[0]).toMatch(/vertex|corner/)
    expect(kinds.indexOf('edge')).toBeGreaterThan(kinds.lastIndexOf('vertex'))
  })

  it('cuts the list at ten and says how many it left out', () => {
    const r = expectOk(measure({ near: [50, 30, -10], radius: 50 }))
    expect(r.candidates).toHaveLength(10)
    expect(r.more).toBeGreaterThan(0)
  })
})

describe('design.measure: measure', () => {
  it('measures between coordinates and refs', () => {
    expect(expectOk(measure({ points: ['partZero', [3, 4, 0]] }))).toMatchObject({
      distance: 5,
      delta: [3, 4, 0],
      points: [
        [0, 0, 0],
        [3, 4, 0],
      ],
    })
    const holes = expectOk(measure({ points: ['drill1', 'drill2'] }, false))
    expect(holes.distance).toBe(70)
    expect(expectOk(measure({ points: ['pocket1.floor', [50, 30, 0]] })).distance).toBe(8.5)
  })

  it('gives the angle at the middle point', () => {
    const r = expectOk(measure({ points: ['drill2', 'drill1', 'drill3'] }, false))
    expect(r.angle).toBe(90)
    expect(r.distances).toEqual([70, 30])
  })

  it('refuses with the field, the rule and a next step', () => {
    const both = expectErrCode(
      measure({ near: [0, 0, 0], points: ['partZero', [1, 0, 0]] }),
      'input.malformed',
    )
    expect(both.issues[0]?.rule).toBe('nearOrPoints')
    const neither = expectErrCode(measure({}), 'input.malformed')
    expect(neither.issues[0]?.rule).toBe('nearOrPoints')
    const unknown = expectErrCode(measure({ points: ['partZero', 'nope'] }), 'input.malformed')
    expect(unknown.issues[0]).toMatchObject({ path: ['points', 1], rule: 'unknownRef' })
    expect(unknown.message).toContain('design_measure { near }')
    const pending = expectErrCode(
      measure({ points: ['pocket1.floor', 'partZero'] }, false),
      'input.malformed',
    )
    expect(pending.issues[0]).toMatchObject({ path: ['points', 0], rule: 'notEvaluated' })
    expect(pending.message).toContain('design_part_evaluate')
    const flat = expectErrCode(
      measure({ points: ['partZero', 'partZero', [1, 0, 0]] }),
      'input.malformed',
    )
    expect(flat.issues[0]?.rule).toBe('noAngle')
  })
})
