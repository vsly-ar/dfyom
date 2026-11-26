// design.shape.* commands and queries through a dispatcher with the real 2D port: defaults,
// formulas over stock faces, invariants with item paths, item edits, remove, convert, queries,
// undo, and the pending keys of shapes. Doc: docs/modes/design-v0.3.md#commands-and-queries-v03
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { pendingChanges } from '../commands/apply'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'
import type { ShapeDTO } from './shape.dto'

const region2d = nodeRegion2d()
const ui = uiSource()

const setup = () => designSetup({ services: { region2d } })
const shapes = (s: DesignSetup): ShapeDTO[] => s.part().shapes ?? []
const rect = { kind: 'rectangle', center: ['0', '0'], length: '40', width: '20' }
const query = (s: DesignSetup, name: string, args: object) =>
  expectOk(s.d.query(name, args, ui)).value as Record<string, unknown>

describe('design.shape.add', () => {
  it('adds shape1 with defaults and returns warnings', async () => {
    const s = await setup()
    const r = (await s.run('design.shape.add', { partId: s.partId, items: [rect] })) as {
      shapeId: string
      warnings: unknown[]
    }
    expect(r.shapeId).toBe('shape1')
    expect(r.warnings).toEqual([])
    const [shape] = shapes(s)
    expect(shape!.name).toBe('Shape 1')
    const item = shape!.items[0]!
    expect(item.op).toBe('add')
    expect(item.kind === 'rectangle' && item.cornerRadius.source).toBe('3 mm')
    expect(item.kind === 'rectangle' && 'rotation' in item).toBe(false)
    const second = (await s.run('design.shape.add', {
      partId: s.partId,
      name: 'Cavity',
      items: [{ kind: 'circle', center: ['0', '0'], diameter: '10' }],
    })) as { shapeId: string }
    expect(second.shapeId).toBe('shape2')
    await s.undo()
    expect(shapes(s)).toHaveLength(1)
  })

  it('parses formulas over stock faces only', async () => {
    const s = await setup()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ ...rect, length: 'stock.side[1].x - 20' }],
    })
    const item = shapes(s)[0]!.items[0]!
    expect(item.kind === 'rectangle' && item.length.exact).toEqual({ num: '80', den: '1' })
    await s.run('design.facing.add', { partId: s.partId, depth: '1' })
    const e = await s.fail(
      'design.shape.add',
      { partId: s.partId, items: [{ ...rect, length: 'facing1.floor.z + 50' }] },
      'expression.reference',
    )
    expect(e.issues[0]!.path).toEqual(['items', 0, 'length'])
  })

  it('refuses invalid shapes with item paths and writes nothing', async () => {
    const s = await setup()
    const e = await s.fail(
      'design.shape.add',
      {
        partId: s.partId,
        items: [
          rect,
          {
            kind: 'path',
            op: 'subtract',
            start: ['0', '0'],
            segments: [
              { kind: 'line', to: ['5', '5'] },
              { kind: 'line', to: ['5', '0'] },
              { kind: 'line', to: ['0', '5'] },
            ],
          },
        ],
      },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['items.1', 'shapeSelfIntersects'],
    ])
    const e2 = await s.fail(
      'design.shape.add',
      { partId: s.partId, items: [{ ...rect, width: '-1' }] },
      'model.invariant',
    )
    expect(e2.issues[0]!.path).toEqual(['items', 0, 'width'])
    expect(s.part().shapes).toBeUndefined()
  })

  it('fails without a 2D port', async () => {
    const s = await designSetup()
    await s.fail('design.shape.add', { partId: s.partId, items: [rect] }, 'internal.unexpected')
  })
})

describe('editing shapes', () => {
  it('update replaces items and renames; item.update edits one item', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      name: 'Frame',
      items: [rect, { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '6' }],
    })
    expect(shapes(s)[0]!.name).toBe('Frame')
    expect(shapes(s)[0]!.items).toHaveLength(2)
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 1,
      diameter: '8',
    })
    const c = shapes(s)[0]!.items[1]!
    expect(c.kind === 'circle' && c.diameter.source).toBe('8')
    expect(c.op).toBe('subtract')
    // fields of another kind, a missing item, an item that no longer fits
    const e = await s.fail(
      'design.shape.item.update',
      { partId: s.partId, shapeId: 'shape1', index: 1, length: '5' },
      'input.malformed',
    )
    expect(e.issues[0]!.rule).toBe('notForKind')
    await s.fail(
      'design.shape.item.update',
      { partId: s.partId, shapeId: 'shape1', index: 2, diameter: '5' },
      'input.malformed',
    )
    const e3 = await s.fail(
      'design.shape.item.update',
      { partId: s.partId, shapeId: 'shape1', index: 1, diameter: '100' },
      'model.invariant',
    )
    expect(e3.issues[0]!.rule).toBe('shapeEmpty')
    const e4 = await s.fail(
      'design.shape.item.update',
      { partId: s.partId, shapeId: 'shape1', index: 0, cornerRadius: '11', round: false },
      'model.invariant',
    )
    expect(e4.issues[0]!.path).toEqual(['items', 0, 'cornerRadius'])
  })

  it('item.update of a path keeps stored fields and parses the new segments', async () => {
    const s = await setup()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          segments: [
            { kind: 'line', to: ['20', '0'] },
            { kind: 'arc', to: ['20', '10'], radius: '5' },
            { kind: 'line', to: ['0', '10'] },
          ],
          fillets: [{ vertex: 0, radius: '2' }],
        },
      ],
    })
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      segments: [
        { kind: 'line', to: ['30', '0'] },
        { kind: 'tangentArc', to: ['30', '10'] },
        { kind: 'line', to: ['0', '10'] },
      ],
    })
    const p = shapes(s)[0]!.items[0]!
    expect(p.kind === 'path' && p.fillets?.[0]!.radius.source).toBe('2')
    expect(p.kind === 'path' && p.closed).toBe(true)
    const got = query(s, 'design.shape.get', { partId: s.partId, shapeId: 'shape1' })
    const resolved = got['resolved'] as { area: number; smallestInsideRadius: number }
    expect(resolved.area).toBeCloseTo(300 + 12.5 * Math.PI - (4 - Math.PI), 6)
    expect(resolved.smallestInsideRadius).toBe(0) // the sharp corner at (0, 10)
  })

  it('remove deletes the shape; unknown ids are input.malformed', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.fail('design.shape.remove', { partId: s.partId, shapeId: 'shape2' }, 'input.malformed')
    await s.run('design.shape.remove', { partId: s.partId, shapeId: 'shape1' })
    expect(s.part().shapes).toBeUndefined()
    await s.undo()
    expect(shapes(s)).toHaveLength(1)
  })

  it('convert makes a shape of an inline rectangle or circle', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '40',
        width: '25',
        cornerRadius: '4',
      },
      depth: '5',
    })
    const r = (await s.run('design.shape.convert', {
      partId: s.partId,
      operationId: 'pocket1',
    })) as {
      shapeId: string
    }
    expect(r.shapeId).toBe('shape1')
    const item = shapes(s)[0]!.items[0]!
    expect(item.kind).toBe('rectangle')
    expect(item.kind === 'rectangle' && item.length.source).toBe('40')
    expect(item.kind === 'rectangle' && item.center[0].exact).toEqual({ num: '0', den: '1' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['10', '10'], diameter: '5' })
    const e = await s.fail(
      'design.shape.convert',
      { partId: s.partId, operationId: 'drill1' },
      'input.malformed',
    )
    expect(e.issues[0]!.rule).toBe('operationKind')
  })
})

describe('queries', () => {
  it('list and get return the resolved shape', async () => {
    const s = await setup()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [rect, { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '6' }],
    })
    const list = query(s, 'design.shape.list', { partId: s.partId })['shapes'] as Record<
      string,
      unknown
    >[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'shape1', items: 2, usedBy: [], kind: 'region' })
    expect(list[0]!['area'] as number).toBeCloseTo(800 - (4 - Math.PI) * 9 - 9 * Math.PI, 6)
    const got = query(s, 'design.shape.get', { partId: s.partId, shapeId: 'shape1' })
    const resolved = got['resolved'] as { pieces: { holes: unknown[] }[]; bounds: unknown }
    expect(resolved.pieces[0]!.holes).toHaveLength(1)
    expect(resolved.bounds).toEqual({ min: [-20, -10], max: [20, 10] })
  })
})

describe('pending keys of shapes', () => {
  it('(part, shape) for add and item lists, (part, shape, item, field) for fields', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '10' },
      depth: '2',
    })
    await s.run('project.apply', {})
    const base = s.d.doc
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    const keys = () =>
      pendingChanges(s.d.doc, base).map((c) => [c.shapeId, c.field, c.label, c.operationId])
    expect(keys()).toEqual([['shape1', 'added', 'Shape 1 added', undefined]])
    const applied = s.d.doc
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      length: '30',
    })
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      length: '31',
    })
    expect(pendingChanges(s.d.doc, applied).map((c) => [c.shapeId, c.field, c.label])).toEqual([
      ['shape1', 'items.0.length', 'Shape 1: item 1 length'],
    ])
    // editing back to the applied value removes the key; a rename is not pending
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      length: '40.0',
    })
    await s.run('design.shape.update', { partId: s.partId, shapeId: 'shape1', name: 'Cavity' })
    expect(pendingChanges(s.d.doc, applied)).toEqual([])
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [rect, { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '6' }],
    })
    expect(pendingChanges(s.d.doc, applied).map((c) => c.field)).toEqual(['items'])
    // a shape key targets the operations using the shape only (none yet): Apply chooses no tool
    const out = (await s.run('project.apply', {})) as { changes: number; toolChanges: unknown[] }
    expect(out.changes).toBe(1)
    expect(out.toolChanges).toEqual([])
    await s.run('design.shape.remove', { partId: s.partId, shapeId: 'shape1' })
    const pending = query(s, 'project.pending.get', {})['changes'] as Record<string, unknown>[]
    expect(pending.map((c) => [c['shapeId'], c['field']])).toEqual([['shape1', 'removed']])
  })
})
