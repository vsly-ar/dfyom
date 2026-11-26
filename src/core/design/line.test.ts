// The Line operation's commands (engraved-patterns.md E1): design.line.add with a constant depth
// (a string) or a ramp ({ start, end }), the default depth, an unknown shape refused at its path,
// updates of the depth and the paths, and undo.
// Doc: docs/modes/engraved-patterns.md#implementation-e1
import { describe, expect, it } from 'vitest'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'

const region2d = nodeRegion2d()

const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}

const WAVE = [
  {
    kind: 'path',
    closed: false,
    start: ['0', '0'],
    segments: [
      { kind: 'line', to: ['20', '0'] },
      { kind: 'arc', to: ['40', '0'], radius: '10', cw: false },
    ],
  },
]

async function withShape(): Promise<DesignSetup & { shapeId: string }> {
  const s = await designSetup({ services: { region2d } })
  const { shapeId } = (await s.run('design.shape.add', {
    partId: s.partId,
    name: 'Wave',
    items: WAVE,
  })) as { shapeId: string }
  return Object.assign(s, { shapeId })
}

describe('design.line.add / update', () => {
  it('a constant depth from a string, on the top face; undoable', async () => {
    const s = await withShape()
    const out = (await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId: s.shapeId, center: ['50', '50'] }],
      depth: '0.8',
    })) as { operationId: string }
    expect(out.operationId).toBe('line1')
    const op = s.op('line1') as Record<string, unknown>
    expect(op).toMatchObject({ kind: 'line', on: 'stock.top', name: 'Line 1' })
    expect(exact(op['depth'])).toBeCloseTo(0.8, 9)
    await s.undo()
    expect(s.part().operations).toEqual([])
  })

  it('a ramp from { start, end }; the default depth 0.5 mm when none is given', async () => {
    const s = await withShape()
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId: s.shapeId, center: ['50', '50'] }],
      depth: { start: '0.2', end: '1.5' },
    })
    const d = (s.op('line1') as unknown as { depth: { start: unknown; end: unknown } }).depth
    expect([exact(d.start), exact(d.end)]).toEqual([0.2, 1.5])
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId: s.shapeId, center: ['50', '20'] }],
    })
    expect(exact((s.op('line2') as unknown as { depth: unknown }).depth)).toBe(0.5)
  })

  it('refuses an unknown shape at its path', async () => {
    const s = await withShape()
    const e = await s.fail(
      'design.line.add',
      {
        partId: s.partId,
        paths: [
          { shapeId: s.shapeId, center: ['50', '50'] },
          { shapeId: 'shape99', center: ['50', '20'] },
        ],
      },
      'input.malformed',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'paths.1.shapeId',
      'unknownShape',
    ])
  })

  it('updates the depth (ramp → constant) and moves a path', async () => {
    const s = await withShape()
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ shapeId: s.shapeId, center: ['50', '50'] }],
      depth: { start: '0.2', end: '1' },
    })
    await s.run('design.line.update', { partId: s.partId, operationId: 'line1', depth: '1.2' })
    expect(exact((s.op('line1') as unknown as { depth: unknown }).depth)).toBeCloseTo(1.2, 9)
    await s.run('design.line.update', {
      partId: s.partId,
      operationId: 'line1',
      paths: [{ shapeId: s.shapeId, center: ['40', '30'] }],
    })
    const p = (s.op('line1') as unknown as { paths: { center: unknown[] }[] }).paths
    expect(p.map((x) => x.center.map(exact))).toEqual([[40, 30]])
    await s.undo()
    const back = (s.op('line1') as unknown as { paths: { center: unknown[] }[] }).paths
    expect(back.map((x) => x.center.map(exact))).toEqual([[50, 50]])
  })
})
