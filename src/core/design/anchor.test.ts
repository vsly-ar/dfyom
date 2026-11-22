// Placement anchors (v0.2 A2): `center` as the anchor point, size edits, re-anchoring.
// Doc: docs/modes/design-v0.2.md#placement-anchors
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { expectUndoLaw } from '../commands/testing'
import { DESIGN_COMMANDS } from './commands'
import { designSetup, type DesignSetup } from './design.fixture'
import { loadPart, partGeometryInput } from './load'
import { shapeCentre } from './anchor'

const MIN_MIN = { u: 'min', v: 'min' } as const
const CENTRE = { u: 'centre', v: 'centre' } as const

const rect = (center: [string, string], length = '40', width = '20') => ({
  kind: 'rectangle',
  center,
  length,
  width,
  cornerRadius: '3',
})

const src = (q: unknown) => (q as { source: string }).source

/** `[u, v]` sources of an operation's shape center, and the anchor as stored. */
function placed(s: DesignSetup, id: string) {
  const op = s.op(id) as { shape: { center: unknown[]; anchor?: unknown } }
  return { center: op.shape.center.map(src), anchor: op.shape.anchor }
}

/** The geometric centre the geometry gets for an operation. */
function geometryCentre(s: DesignSetup, id: string) {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId))
  const op = input.operations.find((o) => o.id === id) as { shape: { center: readonly number[] } }
  return op.shape.center
}

async function expectUndoRedo(s: DesignSetup, name: string, args: object): Promise<void> {
  const before = s.d.doc
  await s.run(name, args)
  const after = s.d.doc
  expectUndoLaw(before, DESIGN_COMMANDS.find((c) => c.name === name) as never, args)
  await s.undo()
  expect(s.d.doc).toEqual(before)
  await s.redo()
  expect(s.d.doc).toEqual(after)
}

describe('placement anchors', () => {
  it('without anchor the centre is meant and no anchor is stored (v0.1 records unchanged)', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', { partId: s.partId, shape: rect(['50', '30']), depth: '5' })
    expect(placed(s, 'pocket1')).toEqual({ center: ['50', '30'], anchor: undefined })
    expect(geometryCentre(s, 'pocket1')).toEqual([50, 30])
  })

  it('add with an anchor: center gives that point of the bounding rectangle', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect(['10', '10']),
      anchor: MIN_MIN,
      depth: '5',
    })
    expect(placed(s, 'pocket1')).toEqual({ center: ['10', '10'], anchor: MIN_MIN })
    expect(geometryCentre(s, 'pocket1')).toEqual([30, 20])
    // a circle uses its bounding square
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['90', '50'], diameter: '20' },
      anchor: { u: 'max', v: 'max' },
    })
    expect(geometryCentre(s, 'profile1')).toEqual([80, 40])
  })

  it('size edits keep the anchor point fixed (the pocket grows toward +u)', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect(['10', '10']),
      anchor: MIN_MIN,
      depth: '5',
    })
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect(['10', '10'], '60', '30'),
    })
    expect(placed(s, 'pocket1')).toEqual({ center: ['10', '10'], anchor: MIN_MIN })
    expect(geometryCentre(s, 'pocket1')).toEqual([40, 25])
    // also when the shape changes kind (a circle: its bounding square)
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { kind: 'circle', center: ['10', '10'], diameter: '30' },
    })
    expect(geometryCentre(s, 'pocket1')).toEqual([25, 25])
  })

  it('changing the anchor keeps the geometry; one undo step', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect(['10', '10']),
      anchor: MIN_MIN,
      depth: '5',
    })
    await expectUndoRedo(s, 'design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      anchor: { u: 'max', v: 'centre' },
    })
    expect(placed(s, 'pocket1')).toEqual({
      center: ['50', '20'],
      anchor: { u: 'max', v: 'centre' },
    })
    expect(geometryCentre(s, 'pocket1')).toEqual([30, 20])
    // back to the centre: the stored anchor is dropped again
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      anchor: CENTRE,
    })
    expect(placed(s, 'pocket1')).toEqual({ center: ['30', '20'], anchor: undefined })
    expect(geometryCentre(s, 'pocket1')).toEqual([30, 20])
  })

  it('a moved position keeps its unit, tolerance and written decimals', async () => {
    const s = await designSetup()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect(['2"', '30.50 ±0.1'], '1"', '10'),
    })
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      anchor: MIN_MIN,
    })
    expect(placed(s, 'profile1').center).toEqual(['1.5"', '25.50 ±0.1'])
    const op = expectOk(loadPart(s.d.doc, s.partId, 'test')).part.operations[0]!
    if (op.kind !== 'profile') throw new Error('profile expected')
    expect(op.shape.center[1].tolerance.isSome()).toBe(true)
    expect(shapeCentre(op.shape)).toEqual([50.8, 30.5])
  })

  it('a position formula on a moving axis fails with anchorExpression; a fixed axis may be one', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect(['stock.top.z + 50', '30']),
      depth: '5',
    })
    const e = await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'pocket1', anchor: MIN_MIN },
      'model.invariant',
    )
    expect(e.issues).toEqual([
      expect.objectContaining({
        path: ['anchor'],
        rule: 'anchorExpression',
        params: { parameter: 'shape.center.0' },
      }),
    ])
    // only v moves: the u formula stays
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      anchor: { u: 'centre', v: 'min' },
    })
    expect(placed(s, 'pocket1').center).toEqual(['stock.top.z + 50', '20'])
    expect(geometryCentre(s, 'pocket1')).toEqual([50, 30])
  })

  it('a new shape and an anchor in one update: the shape keeps the old anchor, then re-anchors', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect(['10', '10']),
      anchor: MIN_MIN,
      depth: '5',
    })
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: rect(['20', '10'], '20', '20'),
      anchor: CENTRE,
    })
    expect(placed(s, 'pocket1')).toEqual({ center: ['30', '20'], anchor: undefined })
  })

  it('an invalid anchor is input.malformed; drillings take none', async () => {
    const s = await designSetup()
    await s.fail(
      'design.pocket.add',
      { partId: s.partId, shape: rect(['50', '30']), anchor: { u: 'left', v: 'min' }, depth: '5' },
      'input.malformed',
    )
    await s.fail(
      'design.drilling.add',
      { partId: s.partId, center: ['10', '10'], diameter: '6', anchor: MIN_MIN },
      'input.malformed',
    )
  })
})
