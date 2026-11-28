// A Line's inline Straight / Arc paths (DF147 SL2, engraved-patterns.md § Simple Line): the circle
// through three points and the arc's read-outs, the element placed as a named shape's, and the
// commands: stored in the operation (expressions kept), edited, undone, refused when beside another
// path, a point long or a straight "arc".
// Doc: docs/modes/engraved-patterns.md#implementation-sl1sl2
import { describe, expect, it } from 'vitest'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup } from './design.fixture'
import { arcReadout, circleThrough } from './line-inline'

const region2d = nodeRegion2d()

const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}

describe('inline geometry', () => {
  it('the circle through three points, its direction and the arc read-outs', () => {
    const c = circleThrough([20, 30], [50, 45], [80, 30])!
    expect(c.centre[0]).toBeCloseTo(50, 12)
    expect(c.centre[1]).toBeCloseTo(7.5, 12)
    expect(c.radius).toBeCloseTo(37.5, 12)
    expect(c.ccw).toBe(false)
    expect(circleThrough([80, 30], [50, 45], [20, 30])!.ccw).toBe(true)
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeUndefined()
    // a half circle, then the same points the long way round
    expect(arcReadout([0, 0], [10, 10], [20, 0])!.sweep).toBeCloseTo(180, 9)
    const long = arcReadout([0, 0], [10, -24.142135623730951], [20, 0])!
    expect(long.radius).toBeGreaterThan(10)
    expect(arcReadout([0, 0], [10, 2], [20, 0])!.sweep).toBeLessThan(90)
  })
})

describe('design.line.add / update with an inline path', () => {
  it('stores a segment (expressions kept) and an arc; undoable', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ segment: { start: ['0', '22'], end: ['stock.side[1].x', '22'] } }],
      depth: '0.5',
    })
    const seg = (s.op('line1') as unknown as { paths: { segment: { end: unknown[] } }[] }).paths
    expect(seg).toHaveLength(1)
    expect(seg[0]!.segment.end.map(exact)).toEqual([100, 22])
    expect(seg[0]!.segment.end[0]).toMatchObject({ source: 'stock.side[1].x' })
    await s.run('design.line.update', {
      partId: s.partId,
      operationId: 'line1',
      paths: [{ arc: { start: ['20', '30'], through: ['50', '45'], end: ['80', '30'] } }],
    })
    const arc = (s.op('line1') as unknown as { paths: { arc: { through: unknown[] } }[] }).paths
    expect(arc[0]!.arc.through.map(exact)).toEqual([50, 45])
    await s.undo()
    expect(s.op('line1')).toMatchObject({ paths: [{ segment: {} }] })
  })

  it('a Clones copy moves the inline points by its offset', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ arc: { start: ['10', '10'], through: ['25', '15'], end: ['40', '10'] } }],
    })
    const out = (await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['line1'] },
      rows: [{ kind: 'offset', count: 1, du: '0', dv: '20' }],
    })) as { operationIds: string[] }
    const copy = s.part().operations.find((o) => o.id === out.operationIds.at(-1))
    const arc = (copy as unknown as { paths: { arc: Record<string, unknown[]> }[] }).paths[0]!.arc
    expect(arc['start']!.map(exact)).toEqual([10, 30])
    expect(arc['through']!.map(exact)).toEqual([25, 35])
    expect(arc['end']!.map(exact)).toEqual([40, 30])
  })

  it('refuses an inline path beside another, a point-long segment and a straight "arc"', async () => {
    const s = await designSetup({ services: { region2d } })
    const { shapeId } = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          closed: false,
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['20', '0'] }],
        },
      ],
    })) as { shapeId: string }
    const rules = async (paths: unknown[]) =>
      (await s.fail('design.line.add', { partId: s.partId, paths }, 'model.invariant')).issues.map(
        (i) => [i.path.join('.'), i.rule],
      )
    expect(
      await rules([
        { segment: { start: ['0', '22'], end: ['50', '22'] } },
        { shapeId, center: ['50', '50'] },
      ]),
    ).toContainEqual(['paths.0', 'inlineAlone'])
    expect(await rules([{ segment: { start: ['10', '22'], end: ['10', '22'] } }])).toContainEqual([
      'paths.0.segment.end',
      'lineTooShort',
    ])
    expect(
      await rules([{ arc: { start: ['10', '10'], through: ['20', '20'], end: ['30', '30'] } }]),
    ).toContainEqual(['paths.0.arc.through', 'arcCollinear'])
  })
})
