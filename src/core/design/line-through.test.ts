// A through Line in Design (DF147 SL3, engraved-patterns.md § Cutting the part out along a line):
// `depth: 'through'` stored and undone, its geometry as deep as the material below its face with a
// flat cutter, and refused on a named shape (a cut-out along a shape is a Profile).
// Doc: docs/modes/engraved-patterns.md#implementation-sl3sl4
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup } from './design.fixture'
import { partGeometryInput } from './load'

const region2d = nodeRegion2d()

describe('a through Line (DF147 SL3)', () => {
  it('stores depth through; the geometry goes through the stock with a flat cutter; undoable', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ segment: { start: ['0', '22'], end: ['100', '22'] } }],
      depth: '1',
    })
    await s.run('design.line.update', { partId: s.partId, operationId: 'line1', depth: 'through' })
    expect(s.op('line1')).toMatchObject({ depth: 'through' })
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const line = input.operations.find((o) => o.id === 'line1')!
    const t = input.stock.thickness
    expect(line).toMatchObject({ kind: 'line', through: true, cutter: { kind: 'flat' } })
    expect(line).toMatchObject({ depth: { start: t, end: t } })
    await s.undo()
    expect(s.op('line1')).toMatchObject({ depth: { source: '1' } })
  })

  it('refuses through on a named shape', async () => {
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
    const err = await s.fail(
      'design.line.add',
      { partId: s.partId, paths: [{ shapeId, center: ['50', '50'] }], depth: 'through' },
      'model.invariant',
    )
    expect(err.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual([
      'depth',
      'lineThroughPath',
    ])
  })
})
