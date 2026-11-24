import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createRegistry } from '../commands/registry'
import { expectUndoLaw } from '../commands/testing'
import { newProjectDoc } from '../project/document'
import { DESIGN_COMMANDS, DESIGN_QUERIES } from './commands'
import { designSetup, type DesignSetup } from './design.fixture'

const rect = (length: string, width: string, extra: object = {}) => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  ...extra,
})
const circle = (diameter: string) => ({ kind: 'circle', center: ['50', '30'], diameter })

/** The source of a quantity DTO, for compact assertions. */
const src = (q: unknown) => (q as { source: string }).source

/** Runs a command, then checks that undo restores the previous and redo the new document. */
async function expectUndoRedo(s: DesignSetup, name: string, args: object): Promise<unknown> {
  const before = s.d.doc
  const value = await s.run(name, args)
  const after = s.d.doc
  expectUndoLaw(before, DESIGN_COMMANDS.find((c) => c.name === name) as never, args)
  await s.undo()
  expect(s.d.doc).toEqual(before)
  await s.redo()
  expect(s.d.doc).toEqual(after)
  return value
}

describe('design commands: registry', () => {
  it('registers part, per-kind add/update and shared remove/move as document commands', () => {
    const reg = expectOk(createRegistry({ commands: DESIGN_COMMANDS, queries: DESIGN_QUERIES }))
    for (const kind of ['facing', 'pocket', 'drilling', 'profile'])
      for (const verb of ['add', 'update'])
        expect(reg.command(`design.${kind}.${verb}`).unwrap().kind).toBe('document')
    for (const name of ['design.part.add', 'design.operation.remove', 'design.operation.move'])
      expect(reg.command(name).unwrap().kind).toBe('document')
    expect(DESIGN_QUERIES.map((q) => q.name)).toEqual([
      'design.part.list',
      'design.part.get',
      'design.operation.list',
      'design.warning.list',
    ])
  })
})

describe('design.part.add / update', () => {
  it('takes a stock snapshot and creates an empty part; undo removes both', async () => {
    const s = await designSetup()
    expect(s.part()).toEqual({
      id: s.partId,
      name: 'Bracket',
      stock: 'snapshot-2',
      operations: [],
    })
    expect(s.d.doc.snapshots['snapshot-2']).toMatchObject({
      kind: 'stock',
      libraryItemId: 'stock-1',
      takenAt: '2026-11-17T10:00:00.000Z',
    })
    await s.undo()
    expect(s.d.doc.parts).toEqual({})
    expect(s.d.doc.snapshots).toEqual({})
  })

  it('a second part is added beside the first (S0); an unknown stock fails with input.malformed', async () => {
    const s = await designSetup()
    const { partId } = (await s.run('design.part.add', {
      name: 'Two',
      stockLibraryItemId: 'stock-1',
    })) as { partId: string }
    expect(Object.keys(s.d.doc.parts)).toEqual([s.partId, partId])
    await s.undo()
    const u = await s.fail(
      'design.part.add',
      { name: 'X', stockLibraryItemId: 'nope' },
      'input.malformed',
    )
    expect(u.issues[0]).toMatchObject({ path: ['stockLibraryItemId'], rule: 'unknownItem' })
  })

  it('own stock (DF13): takes the block values, linked to no library item, never stale', async () => {
    const s = await designSetup()
    await s.undo()
    const { partId } = (await s.run('design.part.add', {
      name: 'Own',
      stock: {
        name: 'Block 120 × 80 × 12',
        shape: 'block',
        length: '120',
        width: '80',
        thickness: '12',
        material: { name: 'Birch plywood', class: 'sheetGood' },
      },
    })) as { partId: string }
    const snap = s.d.doc.snapshots[s.d.doc.parts[partId]!.stock]!
    expect(snap.libraryItemId).toBeUndefined()
    expect(snap.values).toMatchObject({ kind: 'stock', material: { class: 'sheetGood' } })
    expect(src((snap.values as { length: unknown }).length)).toBe('120')
    const up = await s.fail('design.snapshot.update', { snapshotId: snap.id }, 'input.malformed')
    expect(up.issues[0]?.rule).toBe('ownStock')
  })

  it('own stock: exactly one source; bad sizes are issues under stock', async () => {
    const s = await designSetup()
    await s.undo()
    const both = await s.fail('design.part.add', { name: 'X' }, 'input.malformed')
    expect(both.issues[0]?.rule).toBe('stockSource')
    const e = await s.fail(
      'design.part.add',
      {
        name: 'X',
        stock: {
          name: 'B',
          shape: 'block',
          length: '0',
          width: '80',
          thickness: '12',
          material: { name: 'Pine', class: 'softwood' },
        },
      },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['stock', 'length'], rule: 'positive' })
  })

  it('updates name and general tolerance; null clears; a negative deviation is invalid', async () => {
    const s = await designSetup()
    await expectUndoRedo(s, 'design.part.update', {
      partId: s.partId,
      name: 'Plate',
      generalTolerance: { length: '0.1 mm', angle: '0.5°' },
    })
    expect(s.part().name).toBe('Plate')
    expect(src(s.part().generalTolerance?.length)).toBe('0.1 mm')
    await s.run('design.part.update', { partId: s.partId, generalTolerance: { length: null } })
    expect(s.part().generalTolerance).toEqual({ angle: expect.anything() })
    const e = await s.fail(
      'design.part.update',
      { partId: s.partId, generalTolerance: { length: '-0.1' } },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ path: ['generalTolerance', 'length'], rule: 'nonNegative' })
  })

  it('queries list, get and the operation list', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId })
    const ui = { kind: 'ui', id: 'window-1' } as const
    expect(expectOk(s.d.query('design.part.list', {}, ui)).value).toEqual({
      parts: [{ id: s.partId, name: 'Bracket' }],
    })
    const got = expectOk(s.d.query('design.part.get', { partId: s.partId }, ui)).value as {
      stock: { kind: string }
    }
    expect(got.stock.kind).toBe('stock')
    const ops = expectOk(s.d.query('design.operation.list', { partId: s.partId }, ui)).value
    expect(ops).toEqual({ operations: s.part().operations })
    expectErrCode(s.d.query('design.part.get', { partId: 'nope' }, ui), 'input.malformed')
  })
})

describe('operations: add with defaults, update, undo/redo', () => {
  it('facing: default depth 0.5 mm, id facing1, name "Facing 1"', async () => {
    const s = await designSetup()
    const r = await expectUndoRedo(s, 'design.facing.add', { partId: s.partId })
    expect(r).toEqual({
      operationId: 'facing1',
      toolLocked: false,
      warnings: [],
      placed: {
        face: 'stock.top',
        min: [0, 0],
        max: [100, 60],
        box: { min: [0, 0, -0.5], max: [100, 60, 0] },
      },
    })
    expect(s.op('facing1')).toMatchObject({ kind: 'facing', name: 'Facing 1' })
    expect(s.op('facing1')).toMatchObject({ depth: { source: '0.5 mm', defaultUnit: 'mm' } })
    await expectUndoRedo(s, 'design.facing.update', {
      partId: s.partId,
      operationId: 'facing1',
      depth: '1/32"',
      name: 'Skim',
    })
    expect(s.op('facing1')).toMatchObject({ name: 'Skim', depth: { source: '1/32"' } })
  })

  it('inch projects take the inch defaults', async () => {
    const s = await designSetup({ units: 'inch' })
    await s.run('design.facing.add', { partId: s.partId })
    await s.run('design.profile.add', { partId: s.partId, shape: rect('3', '2') })
    expect(s.op('facing1')).toMatchObject({ depth: { source: '1/64"', defaultUnit: 'in' } })
    expect(s.op('profile1')).toMatchObject({
      shape: { cornerRadius: { source: '1/8"' }, length: { defaultUnit: 'in' } },
      slotWidth: { source: '1/4"' },
      tabs: { count: { source: '4' }, width: { source: '1/4"' }, thickness: { source: '1/16"' } },
    })
  })

  it('pocket: on defaults to the last facing floor, cornerRadius 3 mm, floorRadius 0', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', { partId: s.partId, shape: rect('40', '25'), depth: '5' })
    expect(s.op('pocket1')).toMatchObject({ on: 'stock.top', floorRadius: { source: '0' } })
    await s.run('design.facing.add', { partId: s.partId })
    await expectUndoRedo(s, 'design.pocket.add', {
      partId: s.partId,
      shape: circle('20'),
      depth: '3',
    })
    expect(s.op('pocket2')).toMatchObject({ on: 'facing1.floor', shape: { kind: 'circle' } })
    expect(src((s.op('pocket1') as { shape: { cornerRadius: unknown } }).shape.cornerRadius)).toBe(
      '3 mm',
    )
    await expectUndoRedo(s, 'design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket2',
      on: 'stock.top',
      shape: rect('30', '20', { cornerRadius: '5' }),
      floorRadius: '2',
    })
    expect(s.op('pocket2')).toMatchObject({
      on: 'stock.top',
      shape: { length: { source: '30' }, cornerRadius: { source: '5' } },
      floorRadius: { source: '2' },
      depth: { source: '3' },
    })
    // facing1 comes after pocket1, so pocket1 cannot start from its floor
    const later = await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'pocket1', on: 'facing1.floor' },
      'model.invariant',
    )
    expect(later.issues[0]).toMatchObject({ path: ['on'], rule: 'onSurface' })
  })

  it('drilling: through by default; switching bottoms drops or defaults depth and pointAngle', async () => {
    const s = await designSetup()
    const r = await expectUndoRedo(s, 'design.drilling.add', {
      partId: s.partId,
      center: ['10', '10'],
      diameter: '6',
    })
    expect(r).toMatchObject({ operationId: 'drill1', toolLocked: false, warnings: [] })
    expect(r).toHaveProperty('placed.face', 'stock.top')
    expect(s.op('drill1')).toEqual(expect.objectContaining({ bottom: 'through', on: 'stock.top' }))
    expect(s.op('drill1')).not.toHaveProperty('depth')
    const id = { partId: s.partId, operationId: 'drill1' }
    await expectUndoRedo(s, 'design.drilling.update', { ...id, bottom: 'drillPoint', depth: '8' })
    expect(s.op('drill1')).toMatchObject({ depth: { source: '8' }, pointAngle: { source: '118°' } })
    await s.run('design.drilling.update', { ...id, bottom: 'flat' })
    expect(s.op('drill1')).toMatchObject({ bottom: 'flat', depth: { source: '8' } })
    expect(s.op('drill1')).not.toHaveProperty('pointAngle')
    await s.run('design.drilling.update', { ...id, bottom: 'through' })
    expect(s.op('drill1')).not.toHaveProperty('depth')
    const e = await s.fail('design.drilling.update', { ...id, bottom: 'flat' }, 'model.invariant')
    expect(e.issues[0]).toMatchObject({ path: ['depth'], rule: 'required' })
  })

  it('profile: outside, slot 6 mm, 4 tabs 6 × 2 mm by default; tabs merge on update', async () => {
    const s = await designSetup()
    await expectUndoRedo(s, 'design.profile.add', { partId: s.partId, shape: rect('84', '44') })
    expect(s.op('profile1')).toMatchObject({
      side: 'outside',
      slotWidth: { source: '6 mm' },
      tabs: { count: { source: '4' }, width: { source: '6 mm' }, thickness: { source: '2 mm' } },
    })
    await expectUndoRedo(s, 'design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      side: 'inside',
      tabs: { count: '2' },
    })
    expect(s.op('profile1')).toMatchObject({
      side: 'inside',
      tabs: { count: { source: '2' }, width: { source: '6 mm' } },
    })
  })

  it('ids count per kind; removing the last one frees its number', async () => {
    const s = await designSetup()
    for (let i = 0; i < 2; i++) await s.run('design.facing.add', { partId: s.partId })
    await s.run('design.pocket.add', { partId: s.partId, shape: rect('10', '10'), depth: '1' })
    expect(s.part().operations.map((o) => o.id)).toEqual(['facing1', 'facing2', 'pocket1'])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'pocket1' })
    await s.run('design.pocket.add', { partId: s.partId, shape: rect('10', '10'), depth: '1' })
    expect(s.part().operations.map((o) => o.id)).toEqual(['facing1', 'facing2', 'pocket1'])
  })
})

describe('design.operation.remove / move', () => {
  async function three() {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId })
    await s.run('design.pocket.add', { partId: s.partId, shape: rect('20', '20'), depth: '2' })
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'stock.top',
      center: ['5', '5'],
      diameter: '3',
    })
    return s
  }

  it('remove and move with undo/redo', async () => {
    const s = await three()
    await expectUndoRedo(s, 'design.operation.move', {
      partId: s.partId,
      operationId: 'drill1',
      toIndex: 0,
    })
    expect(s.part().operations.map((o) => o.id)).toEqual(['drill1', 'facing1', 'pocket1'])
    await expectUndoRedo(s, 'design.operation.remove', {
      partId: s.partId,
      operationId: 'pocket1',
    })
    expect(s.part().operations.map((o) => o.id)).toEqual(['drill1', 'facing1'])
  })

  it('fail with design.referenced listing the dependants', async () => {
    const s = await three()
    const before = s.d.doc
    const e = await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'facing1' },
      'design.referenced',
    )
    expect(e.issues).toEqual([
      expect.objectContaining({
        path: ['operations', 'pocket1', 'on'],
        rule: 'referenced',
        params: { operationId: 'pocket1', reference: 'facing1.floor' },
      }),
    ])
    expect(e.frames[0]?.data).toEqual({ dependants: ['pocket1'] })
    await s.fail(
      'design.operation.move',
      { partId: s.partId, operationId: 'pocket1', toIndex: 0 },
      'design.referenced',
    )
    expect(s.d.doc).toBe(before) // no partial change, no history entry
    await s.fail(
      'design.operation.move',
      { partId: s.partId, operationId: 'pocket1', toIndex: 3 },
      'input.malformed',
    )
  })

  it('an update that removes a referenced surface fails with design.referenced', async () => {
    const s = await designSetup()
    await s.run('design.profile.add', { partId: s.partId, shape: rect('84', '44') })
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'profile1.tab[3].top',
      shape: rect('5', '5', { cornerRadius: '1' }),
      depth: '1',
    })
    const e = await s.fail(
      'design.profile.update',
      { partId: s.partId, operationId: 'profile1', tabs: { count: '3' } },
      'design.referenced',
    )
    expect(e.issues[0]?.params).toEqual({
      operationId: 'pocket1',
      reference: 'profile1.tab[3].top',
    })
  })
})

describe('validation errors (model.invariant, design.md constraints)', () => {
  const cases: [string, string, object, (string | number)[], string][] = [
    ['facing depth 0', 'facing', { depth: '0' }, ['depth'], 'positive'],
    ['facing through the stock', 'facing', { depth: '20' }, ['depth'], 'lessThanStockThickness'],
    [
      'pocket size 0',
      'pocket',
      { shape: rect('0', '10'), depth: '1' },
      ['shape', 'length'],
      'positive',
    ],
    [
      'pocket corner radius > half the width',
      'pocket',
      { shape: rect('20', '10', { cornerRadius: '6' }), depth: '1' },
      ['shape', 'cornerRadius'],
      'cornerRadiusRange',
    ],
    [
      'pocket floor radius > corner radius',
      'pocket',
      { shape: rect('20', '10', { cornerRadius: '2' }), depth: '5', floorRadius: '3' },
      ['floorRadius'],
      'floorRadiusRange',
    ],
    [
      'circle pocket floor radius > depth',
      'pocket',
      { shape: circle('20'), depth: '2', floorRadius: '3' },
      ['floorRadius'],
      'floorRadiusRange',
    ],
    [
      'pocket floor at the stock bottom',
      'pocket',
      { shape: rect('20', '10'), depth: '20' },
      ['depth'],
      'aboveStockBottom',
    ],
    [
      'facing on a floor (stock faces only)',
      'facing',
      { depth: '1', on: 'pocket9.floor' },
      ['on'],
      'onSurface',
    ],
    [
      'pocket on an unknown surface',
      'pocket',
      { shape: rect('20', '10'), depth: '1', on: 'facing9.floor' },
      ['on'],
      'onSurface',
    ],
    [
      'drill diameter 0',
      'drilling',
      { center: ['1', '1'], diameter: '0' },
      ['diameter'],
      'positive',
    ],
    [
      'drill depth for a through hole',
      'drilling',
      { center: ['1', '1'], diameter: '3', depth: '4' },
      ['depth'],
      'notForBottom',
    ],
    [
      'drill flat without depth',
      'drilling',
      { center: ['1', '1'], diameter: '3', bottom: 'flat' },
      ['depth'],
      'required',
    ],
    [
      'drill point angle 50°',
      'drilling',
      { center: ['1', '1'], diameter: '3', bottom: 'drillPoint', depth: '4', pointAngle: '50' },
      ['pointAngle'],
      'range',
    ],
    [
      'drill point angle on a flat bottom',
      'drilling',
      { center: ['1', '1'], diameter: '3', bottom: 'flat', depth: '4', pointAngle: '118' },
      ['pointAngle'],
      'notForBottom',
    ],
    [
      'drill bottom below the stock',
      'drilling',
      { center: ['1', '1'], diameter: '3', bottom: 'flat', depth: '25' },
      ['depth'],
      'aboveStockBottom',
    ],
    [
      'profile slot width 0',
      'profile',
      { shape: rect('20', '10'), slotWidth: '0' },
      ['slotWidth'],
      'positive',
    ],
    [
      'profile 2.5 tabs',
      'profile',
      { shape: rect('20', '10'), tabs: { count: '2.5' } },
      ['tabs', 'count'],
      'integer',
    ],
    [
      'profile −1 tabs',
      'profile',
      { shape: rect('20', '10'), tabs: { count: '-1' } },
      ['tabs', 'count'],
      'nonNegative',
    ],
    [
      'profile tabs longer than the perimeter',
      'profile',
      { shape: circle('10'), tabs: { count: '4', width: '8' } },
      ['tabs', 'width'],
      'tabsFit',
    ],
    [
      'profile tabs as thick as the stock',
      'profile',
      { shape: rect('20', '10'), tabs: { thickness: '20' } },
      ['tabs', 'thickness'],
      'lessThanStockThickness',
    ],
  ]

  it.each(cases)('%s', async (_label, kind, args, path, rule) => {
    const s = await designSetup()
    const before = s.d.doc
    const e = await s.fail(`design.${kind}.add`, { partId: s.partId, ...args }, 'model.invariant')
    expect(e.issues).toContainEqual(expect.objectContaining({ path, rule }))
    expect(s.d.doc).toBe(before)
  })

  it('an inside profile whose slot covers the opening builds no tabs, so tab width is not checked', async () => {
    const s = await designSetup()
    // Ø6 with the default 6 mm slot: 4 × 6 mm tabs would not fit on the 18.8 mm perimeter
    await s.run('design.profile.add', { partId: s.partId, shape: circle('6'), side: 'inside' })
    expect(s.op('profile1')).toMatchObject({ side: 'inside' })
  })

  const updates: [string, string, object, object, (string | number)[], string][] = [
    [
      'facing depth through the stock',
      'facing',
      {},
      { depth: '20' },
      ['depth'],
      'lessThanStockThickness',
    ],
    [
      'pocket corner radius too large',
      'pocket',
      { shape: rect('20', '10'), depth: '1' },
      { shape: rect('20', '10', { cornerRadius: '6' }) },
      ['shape', 'cornerRadius'],
      'cornerRadiusRange',
    ],
    [
      'pocket floor radius > depth',
      'pocket',
      { shape: rect('20', '10'), depth: '2' },
      { floorRadius: '2.5' },
      ['floorRadius'],
      'floorRadiusRange',
    ],
    [
      'drill point angle 200°',
      'drilling',
      { center: ['1', '1'], diameter: '3', bottom: 'drillPoint', depth: '4' },
      { pointAngle: '200' },
      ['pointAngle'],
      'range',
    ],
    [
      'profile tabs as thick as the stock',
      'profile',
      { shape: rect('20', '10') },
      { tabs: { thickness: '20' } },
      ['tabs', 'thickness'],
      'lessThanStockThickness',
    ],
  ]

  it.each(updates)('update: %s', async (_label, kind, add, update, path, rule) => {
    const s = await designSetup()
    const { operationId } = (await s.run(`design.${kind}.add`, { partId: s.partId, ...add })) as {
      operationId: string
    }
    const before = s.d.doc
    const e = await s.fail(
      `design.${kind}.update`,
      { partId: s.partId, operationId, ...update },
      'model.invariant',
    )
    expect(e.issues).toContainEqual(expect.objectContaining({ path, rule }))
    expect(s.d.doc).toBe(before)
  })

  it('reports every invalid field of the operation at once', async () => {
    const s = await designSetup()
    const e = await s.fail(
      'design.profile.add',
      { partId: s.partId, shape: rect('0', '10'), slotWidth: '0', tabs: { thickness: '0' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.path.join('.'))).toEqual([
      'shape.length',
      'slotWidth',
      'tabs.thickness',
    ])
  })

  it('quantity errors carry the parameter path', async () => {
    const s = await designSetup()
    const syntax = await s.fail(
      'design.pocket.add',
      { partId: s.partId, shape: rect('10', '10x'), depth: '1' },
      'quantity.unit',
    )
    expect(syntax.issues[0]?.path).toEqual(['shape', 'width'])
    const unit = await s.fail(
      'design.facing.add',
      { partId: s.partId, depth: '5°' },
      'quantity.unit',
    )
    expect(unit.issues[0]?.path).toEqual(['depth'])
    const center = await s.fail(
      'design.drilling.add',
      { partId: s.partId, center: ['1', '(2'], diameter: '3' },
      'quantity.syntax',
    )
    expect(center.issues[0]?.path).toEqual(['center', 1])
  })

  it('unknown arg keys are input.malformed with the key in the path (top level and nested)', async () => {
    const s = await designSetup()
    const before = s.d.doc
    const top = await s.fail(
      'design.facing.add',
      { partId: s.partId, dept: '3' },
      'input.malformed',
    )
    expect(top.issues).toEqual([expect.objectContaining({ path: ['dept'] })])
    const nested = await s.fail(
      'design.pocket.add',
      { partId: s.partId, shape: { ...rect('10', '10'), radius: '2' }, depth: '1' },
      'input.malformed',
    )
    expect(nested.issues).toEqual([expect.objectContaining({ path: ['shape', 'radius'] })])
    const tabs = await s.fail(
      'design.profile.add',
      { partId: s.partId, shape: rect('20', '10'), tabs: { counts: '2' } },
      'input.malformed',
    )
    expect(tabs.issues).toEqual([expect.objectContaining({ path: ['tabs', 'counts'] })])
    expect(s.d.doc).toBe(before)
  })

  it('design.part.get: a stock id that is an Object.prototype key is a missing snapshot', () => {
    const doc = {
      ...newProjectDoc({ name: 'P', unitSystem: 'mm' }),
      parts: { p1: { id: 'p1', name: 'P', stock: 'toString', operations: [] } },
    }
    const get = DESIGN_QUERIES.find((q) => q.name === 'design.part.get')!
    const ui = { kind: 'ui', id: 'window-1' } as const
    expectErrCode(
      get.run(doc, { partId: 'p1' }, { source: ui, services: {} as never }),
      'input.malformed',
    )
  })

  it('unknown part / operation, wrong kind and malformed args are input.malformed', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId })
    const p = await s.fail('design.facing.add', { partId: 'nope' }, 'input.malformed')
    expect(p.issues[0]?.rule).toBe('unknownPart')
    const k = await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'facing1', depth: '1' },
      'input.malformed',
    )
    expect(k.issues[0]?.rule).toBe('operationKind')
    const o = await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'pocket7' },
      'input.malformed',
    )
    expect(o.issues[0]?.rule).toBe('unknownOperation')
    await s.fail('design.pocket.add', { partId: s.partId, depth: '1' }, 'input.malformed')
  })
})
