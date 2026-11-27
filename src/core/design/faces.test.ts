// Face model (v0.2 task A1): face targets for every kind, the surface table per direction,
// `.x/.y/.z` formula names, constraints along the face normal, v0.1 records unchanged.
// Doc: docs/modes/design-v0.2.md#faces-and-face-targets
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import type { DfmWarning } from '../geometry/model'
import { buildTestPart, designSetup, type DesignSetup } from './design.fixture'
import { toGeometryInput } from './geometry-input'
import { loadPart } from './load'
import { operationToDTO, partFromDTO } from './operation'
import { PartDtoSchema } from './part.dto'
import { SurfaceTable } from './surfaces'

const rect = (cx: string, cy: string, length: string, width: string, cornerRadius = '1') => ({
  kind: 'rectangle',
  center: [cx, cy],
  length,
  width,
  cornerRadius,
})

const loaded = (s: DesignSetup) => expectOk(loadPart(s.d.doc, s.partId, 'test'))

/**
 * Stock 100 × 60 × T. facing1 on the left side (depth 1), pocket1 on the right side (depth 5),
 * drill1 (flat, depth 3) on the bottom, profile1 from the front (tabs 2).
 */
async function multiFace(thickness = '20') {
  const s = await designSetup({ thickness })
  const partId = s.partId
  await s.run('design.facing.add', { partId, on: 'stock.side[3]', depth: '1' })
  await s.run('design.pocket.add', {
    partId,
    on: 'stock.side[1]',
    shape: rect('30', '10', '10', '6'),
    depth: '5',
  })
  await s.run('design.drilling.add', {
    partId,
    on: 'stock.bottom',
    center: ['50', '30'],
    diameter: '6',
    bottom: 'flat',
    depth: '3',
  })
  await s.run('design.profile.add', {
    partId,
    on: 'stock.side[0]',
    shape: rect('50', '10', '20', '8'),
    slotWidth: '3',
  })
  return s
}

describe('surface table per direction', () => {
  it('holds the six stock faces with direction and level (n · p)', async () => {
    const s = await designSetup()
    const { part, stock } = loaded(s)
    const table = SurfaceTable.build(part.operations, stock)
    const rows = table
      .before(0)
      .map((e) => [e.id, e.direction, e.level.value.toNumber(), e.faceZ.toNumber()])
    expect(rows).toEqual([
      ['stock.top', '+z', 0, 0],
      ['stock.bottom', '-z', 20, 0],
      ['stock.side[0]', '-y', 0, 0],
      ['stock.side[1]', '+x', 100, 0],
      ['stock.side[2]', '+y', 60, 0],
      ['stock.side[3]', '-x', 0, 0],
    ])
    expect(table.before(0).every((e) => e.onTarget)).toBe(true)
  })

  it('floors, drill bottoms and tab tops take the direction of `on`; deeper is lower', async () => {
    const s = await multiFace()
    const { part, stock } = loaded(s)
    const table = SurfaceTable.build(part.operations, stock)
    const row = (id: string) => {
      const e = table.get(id).unwrap()
      return [e.direction, e.level.value.toNumber(), e.faceZ.toNumber(), e.onTarget]
    }
    expect(row('facing1.floor')).toEqual(['-x', -1, -1, true])
    expect(row('pocket1.floor')).toEqual(['+x', 95, -5, true])
    expect(row('drill1.bottom')).toEqual(['-z', 17, -3, false])
    // tab tops: the opposite stock face (the back, level 0 − 60 along −y) + 2 mm
    expect(row('profile1.tab[0].top')).toEqual(['-y', -58, -58, true])
    expect(table.extent('-y').toNumber()).toBe(60)
    expect(table.extent('+x').toNumber()).toBe(100)
  })
})

describe('formula names (.x / .y / .z)', () => {
  it('resolve the part-frame coordinate on the axis of the normal; another axis is unknown', async () => {
    const s = await multiFace('20 ±0.2')
    const { part, stock } = loaded(s)
    const r = SurfaceTable.build(part.operations, stock).resolver(4)
    const v = (name: string) => r.resolve(name).unwrap().canonical
    expect(v('stock.side[1].x')).toBe(100)
    expect(v('stock.side[0].y')).toBe(0)
    expect(v('stock.side[2].y')).toBe(60)
    expect(v('pocket1.floor.x')).toBe(95) // L − depth on +x
    expect(v('facing1.floor.x')).toBe(1) // depth on −x
    expect(v('stock.bottom.z')).toBe(-20)
    // drill bottom on −z: z = −(T − 3) with T = 20 ±0.2, limits swap sign
    expect(v('drill1.bottom.z')).toBe(-17)
    expect(v('drill1.bottom.z.max')).toBeCloseTo(-16.8)
    expect(v('drill1.bottom.z.min')).toBeCloseTo(-17.2)
    expect(v('profile1.tab[0].top.y')).toBe(58)
    for (const unknown of ['stock.side[1].z', 'pocket1.floor.z', 'stock.top.x', 'stock.side[0].x'])
      expect(r.resolve(unknown).isNone(), unknown).toBe(true)
  })

  it('formulas use bracketed ids and recalculate through `.x` nodes', async () => {
    const s = await multiFace()
    const partId = s.partId
    await s.run('design.pocket.add', {
      partId,
      on: 'stock.side[1]',
      shape: rect('45', '10', '6', '6'),
      depth: 'stock.side[1].x - pocket1.floor.x + 2',
    })
    const depth = () =>
      Number((s.op('pocket2') as { depth: { exact: { num: string } } }).depth.exact.num)
    expect(depth()).toBe(7)
    await s.run('design.pocket.update', { partId, operationId: 'pocket1', depth: '10' })
    expect(depth()).toBe(12)
    // a name on the wrong axis is an unknown reference
    const e = await s.fail(
      'design.pocket.update',
      { partId, operationId: 'pocket2', depth: '-pocket1.floor.z' },
      'expression.reference',
    )
    expect(e.issues[0]).toMatchObject({ path: ['depth'], rule: 'unknownReference' })
  })
})

describe('`on` for every kind and constraints along the normal', () => {
  it('facing and profile take a stock face; default stock.top is left out of the record', async () => {
    const s = await multiFace()
    expect(s.op('facing1')).toMatchObject({ on: 'stock.side[3]' })
    expect(s.op('profile1')).toMatchObject({ on: 'stock.side[0]' })
    await s.run('design.facing.add', { partId: s.partId })
    expect('on' in s.op('facing2')).toBe(false)
    // pocket default: the last *top* facing's floor (facing1 is on the left side)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect('50', '30', '10', '10'),
      depth: '2',
    })
    expect(s.op('pocket2')).toMatchObject({ on: 'facing2.floor' })
    await s.run('design.facing.update', {
      partId: s.partId,
      operationId: 'facing2',
      on: 'stock.bottom',
    })
    expect(s.op('facing2')).toMatchObject({ on: 'stock.bottom' })
  })

  it('a facing or profile on a floor is model.invariant onSurface listing the stock faces', async () => {
    const s = await multiFace()
    const e = await s.fail(
      'design.profile.add',
      { partId: s.partId, on: 'pocket1.floor', shape: rect('50', '30', '20', '10') },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['on'],
      rule: 'onSurface',
      params: {
        allowed: [
          'stock.top',
          'stock.bottom',
          'stock.side[0]',
          'stock.side[1]',
          'stock.side[2]',
          'stock.side[3]',
        ],
      },
    })
    // DF138 F4 (X3): the refusal names the next step: the floor's stock face and its depth
    expect(e.issues[0]!.message).toContain(
      "a profile starts from the stock; use on stock.side[1] and add pocket1.floor's depth below it (5 mm) to depth",
    )
  })

  it('depth limits use the stock extent along n (T, L or W)', async () => {
    const s = await designSetup()
    const partId = s.partId
    // facing depth < L on ±x
    await s.run('design.facing.add', { partId, on: 'stock.side[1]', depth: '30' })
    const facing = await s.fail(
      'design.facing.add',
      { partId, on: 'stock.side[3]', depth: '100' },
      'model.invariant',
    )
    expect(facing.issues[0]).toMatchObject({
      path: ['depth'],
      rule: 'lessThanStockThickness',
      params: { max: 100 },
    })
    // pocket on the front (−y): floor above the back face, depth < 60
    await s.run('design.pocket.add', {
      partId,
      on: 'stock.side[0]',
      shape: rect('50', '10', '10', '6'),
      depth: '40',
    })
    const pocket = await s.fail(
      'design.pocket.add',
      { partId, on: 'stock.side[0]', shape: rect('50', '10', '10', '6'), depth: '60' },
      'model.invariant',
    )
    expect(pocket.issues[0]).toMatchObject({
      path: ['depth'],
      rule: 'aboveStockBottom',
      message: 'must end before the opposite stock face',
      params: { max: 60 },
    })
    // on the side facing floor (x = 70): depth < 70
    const onFloor = await s.fail(
      'design.drilling.add',
      {
        partId,
        on: 'facing1.floor',
        center: ['30', '10'],
        diameter: '5',
        bottom: 'flat',
        depth: '70',
      },
      'model.invariant',
    )
    expect(onFloor.issues[0]).toMatchObject({ path: ['depth'], params: { max: 70 } })
    // tab thickness < the extent along n: 30 fits along y (60), not along z (20)
    await s.run('design.profile.add', {
      partId,
      on: 'stock.side[0]',
      shape: rect('50', '10', '20', '8'),
      tabs: { thickness: '30' },
    })
    const tabs = await s.fail(
      'design.profile.add',
      { partId, shape: rect('50', '30', '60', '40'), tabs: { thickness: '30' } },
      'model.invariant',
    )
    expect(tabs.issues[0]).toMatchObject({ path: ['tabs', 'thickness'], params: { max: 20 } })
  })

  it('results warn that the part needs several setups (dfm.setups)', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId })
    const r = (await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'stock.side[1]',
      center: ['30', '10'],
      diameter: '5',
    })) as { warnings: DfmWarning[] }
    expect(r.warnings.find((w) => w.code === 'dfm.setups')).toMatchObject({
      operation: 'drill1',
      params: { count: 2, directions: ['top', 'right'] },
    })
  })
})

describe('geometry input and v0.1 records', () => {
  it('carries the direction and onZ in the face frame; top operations stay as in v0.1', async () => {
    const s = await multiFace()
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      shape: rect('30', '10', '4', '4'),
      depth: '2',
    })
    const { part, stock } = loaded(s)
    const input = expectOk(toGeometryInput(part, stock))
    const byId = Object.fromEntries(input.operations.map((o) => [o.id, o]))
    expect(byId['facing1']).toMatchObject({ direction: '-x', depth: 1 })
    expect(byId['pocket1']).toMatchObject({ direction: '+x', onZ: 0, depth: 5 })
    expect(byId['pocket2']).toMatchObject({ direction: '+x', onZ: -5, depth: 2 })
    expect(byId['drill1']).toMatchObject({ direction: '-z', onZ: 0 })
    expect(byId['profile1']).toMatchObject({ direction: '-y' })
    expect(input.references).toContainEqual({
      operation: 'pocket2',
      parameter: 'on',
      surface: 'pocket1.floor',
    })

    const top = await designSetup()
    await buildTestPart(top)
    const t = loaded(top)
    for (const op of expectOk(toGeometryInput(t.part, t.stock)).operations)
      expect('direction' in op, op.id).toBe(false)
  })

  it('a v0.1 record (no `on` on facing and profile) loads with stock.top and saves unchanged', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    const dto = PartDtoSchema.parse(JSON.parse(JSON.stringify(s.part())))
    expect(dto.operations.filter((o) => 'on' in o).map((o) => o.kind)).toEqual([
      'pocket',
      'drilling',
      'drilling',
      'drilling',
      'drilling',
    ])
    const part = expectOk(partFromDTO(dto))
    expect(part.operations.map((o) => o.on)).toEqual([
      'stock.top',
      'facing1.floor',
      'facing1.floor',
      'facing1.floor',
      'facing1.floor',
      'facing1.floor',
      'stock.top',
    ])
    expect(part.operations.map(operationToDTO)).toEqual(dto.operations)
  })
})
