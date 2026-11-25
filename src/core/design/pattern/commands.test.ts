// The pattern feature (patterns P1) through its commands: the owned shape and pocket, defaults,
// update and remove, issues at the pattern's fields, a named shape as the cell, DFM
// (`dfm.patternEmpty`, `dfm.patternHeavy`), the shape tools leaving owned shapes alone, undo and
// persistence.
// Spec: docs/modes/patterns.md#model, docs/modes/patterns.md#implementation-p1
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { docToFiles, loadProjectFiles } from '../../project/layout'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { regionArea } from '../../geometry/2d/model'
import { designSetup, type DesignSetup } from '../design.fixture'
import { loadPart, partGeometryInput } from '../load'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })

interface Result {
  featureId: string
  operationIds: string[]
  cells?: number
  warnings: { code: string; severity: string; operation: string; parameter?: string }[]
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...args,
  })) as Result

const honeycomb = {
  lattice: 'hex',
  cell: {
    kind: 'polygon',
    sides: '6',
    diameter: '8',
    across: 'flats',
    cornerRadius: '0.5',
    rotation: '30',
  },
}

describe('design.pattern.add', () => {
  it('owns a read-only cells shape and one pocket placing it on the face frame', async () => {
    const s = await setup()
    const out = await add(s)
    // the defaults: staggered Ø 8 circles, gap 2, margin 5, 1 deep on the top
    expect(out).toMatchObject({ featureId: 'pattern1', operationIds: ['pattern1_pocket'] })
    expect(out.cells).toBe(43)
    expect(out.warnings).toEqual([])
    const part = s.part()
    expect(part.shapes).toEqual([
      {
        id: 'pattern1_cells',
        name: 'Pattern 1 · cells',
        items: [],
        owner: 'pattern1',
        pattern: {
          cell: { item: { kind: 'circle', op: 'add', center: [0, 0], diameter: 8 } },
          cellRotation: 0,
          lattice: 'staggered',
          angle: 0,
          spacing: { gap: 2 },
          boundary: { min: [0, 0], max: [100, 60] },
          margin: 5,
        },
      },
    ])
    const pocket = s.op('pattern1_pocket') as { shape: object; on: string; featureId: string }
    expect(pocket.on).toBe('stock.top')
    expect(pocket.shape).toMatchObject({
      kind: 'named',
      shapeId: 'pattern1_cells',
      anchor: { u: 'min', v: 'min' },
    })
    // the cells stay where the layout put them (the frame anchors at the face origin)
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const op = g.operations[0]!
    if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
    expect(op.shape.center).toEqual([50, 30])
    expect(op.shape.contour.region.pieces).toHaveLength(43)
    expect(regionArea(op.shape.contour.region)).toBeCloseTo(43 * Math.PI * 16, 6)
  })

  it('a honeycomb of rounded hexagons, every field as entered', async () => {
    const s = await setup()
    const out = await add(s, { ...honeycomb, margin: '4', depth: '1.5', name: 'Honeycomb' })
    expect(out.cells).toBeGreaterThan(40)
    expect(s.part().features?.[0]).toMatchObject({ kind: 'pattern', name: 'Honeycomb' })
    expect(s.op('pattern1_pocket')).toMatchObject({ name: 'Honeycomb · pocket' })
  })

  it('a named closed shape as the cell; editing the shape moves the pattern with it', async () => {
    const s = await setup()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '6', width: '3', cornerRadius: '0' },
      ],
    })
    const out = await add(s, { cell: { kind: 'shape', shapeId: 'shape1' }, lattice: 'square' })
    // 8 × 5 mm pitch about the centre of 90 × 50
    expect(out.cells).toBe(11 * 9)
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '8', width: '3', cornerRadius: '0' },
      ],
    })
    const g = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const op = g.operations.find((o) => o.id === 'pattern1_pocket')!
    if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
    expect(op.shape.contour.region.pieces).toHaveLength(9 * 9)
    // the shape is in use: removing it is refused
    const e = await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'shape1' },
      'design.referenced',
    )
    expect(e.frames[0]?.data).toMatchObject({ dependants: ['pattern1_pocket', 'pattern1'] })
  })

  it('refusals land at the pattern fields', async () => {
    const s = await setup()
    const overlap = await s.fail(
      'design.pattern.add',
      { partId: s.partId, ...honeycomb, spacing: { pitch: ['6', '6'] } },
      'model.invariant',
    )
    expect(overlap.issues.map((i) => [i.path, i.rule])).toEqual([[['spacing'], 'patternOverlap']])
    const many = await s.fail(
      'design.pattern.add',
      { partId: s.partId, cell: { kind: 'circle', diameter: '0.5' }, spacing: { gap: '0.5' } },
      'model.invariant',
    )
    expect(many.issues[0]).toMatchObject({ path: ['spacing'], rule: 'patternTooMany' })
    const depth = await s.fail(
      'design.pattern.add',
      { partId: s.partId, depth: '0' },
      'model.invariant',
    )
    expect(depth.issues[0]).toMatchObject({ path: ['depth'], rule: 'positive' })
    const unknown = await s.fail(
      'design.pattern.add',
      { partId: s.partId, cell: { kind: 'shape', shapeId: 'shape9' } },
      'input.malformed',
    )
    expect(unknown.issues[0]).toMatchObject({ path: ['cell', 'shapeId'], rule: 'unknownShape' })
    expect(s.part().features).toBeUndefined()
    expect(s.part().shapes).toBeUndefined()
  })
})

describe('design.pattern.update and remove', () => {
  it('update keeps the fields not given and rewrites the owned shape', async () => {
    const s = await setup()
    await add(s, honeycomb)
    const out = await update(s, { margin: '10' })
    expect(out.cells).toBeLessThan(43)
    const shape = s.part().shapes![0]!
    expect(shape.pattern).toMatchObject({ lattice: 'hex', margin: 10, cellRotation: 30 })
    expect(s.part().features).toHaveLength(1)
  })

  it('dfm.patternEmpty when no cell fits; dfm.patternHeavy past the chord budget', async () => {
    const s = await setup()
    await add(s)
    const empty = await update(s, { margin: '27' })
    expect(empty.cells).toBe(0)
    expect(empty.warnings).toEqual([
      expect.objectContaining({
        code: 'dfm.patternEmpty',
        severity: 'warning',
        operation: 'pattern1',
        parameter: 'margin',
      }),
    ])
    const heavy = await update(s, {
      margin: '5',
      cell: { kind: 'circle', diameter: '3' },
      spacing: { gap: '1' },
    })
    expect(heavy.warnings.map((w) => [w.code, w.severity])).toContainEqual([
      'dfm.patternHeavy',
      'info',
    ])
  })

  it('remove takes the owned shape and pocket; undo brings them back', async () => {
    const s = await setup()
    await add(s)
    const before = s.d.doc
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'pattern1' })
    expect(s.part().shapes).toBeUndefined()
    expect(s.part().operations).toEqual([])
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })
})

describe('owned shapes and the shape tools', () => {
  it('design.shape.list leaves the owned shape out; numbering skips it', async () => {
    const s = await setup()
    await add(s)
    const list = expectOk(s.d.query('design.shape.list', { partId: s.partId }, uiSource()))
      .value as { shapes: unknown[] }
    expect(list.shapes).toEqual([])
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'circle', center: ['0', '0'], diameter: '3' }],
    })
    expect(s.part().shapes!.map((x) => x.id)).toEqual(['pattern1_cells', 'shape1'])
    // the shape tools take shape<n> ids only
    await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'pattern1_cells' },
      'input.malformed',
    )
  })

  it('persists; a load refuses an orphan owned shape and a pattern without its shape', async () => {
    const s = await setup()
    await add(s, honeycomb)
    expect(expectOk(loadProjectFiles(expectOk(docToFiles(s.d.doc))))).toEqual(s.d.doc)
    const part = s.part()
    const orphan = { ...part, features: [], operations: [] }
    const doc1 = { ...s.d.doc, parts: { [s.partId]: orphan } }
    expect(loadPart(doc1, s.partId, 'test').isErr()).toBe(true)
    const noShape = { ...part, shapes: [] }
    const doc2 = { ...s.d.doc, parts: { [s.partId]: noShape } }
    expect(loadPart(doc2, s.partId, 'test').isErr()).toBe(true)
  })
})
