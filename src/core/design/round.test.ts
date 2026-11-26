// DF120 R1: Round corners in the core: the apply rule with `adjusted`, sizes followed by edits and
// recalculation, the `roundRadius` invariant, shape items and pattern cells.
// Doc: docs/modes/hole-slots-and-round-corners.md#round-corners-df120
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from './design.fixture'
import { loadPart } from './load'
import type { Operation } from './operation'
import { checkOperations } from './validate'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })

const rect = (length: string, width: string, extra: object = {}) => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  ...extra,
})

interface ShapeDto {
  cornerRadius: { source: string; exact: { num: string; den: string } }
  round?: true
}
const shapeOf = (s: DesignSetup, id = 'pocket1') => (s.op(id) as { shape: ShapeDto }).shape
/** The stored radius in mm (exact). */
const radius = (sh: { cornerRadius: { exact: { num: string; den: string } } }) =>
  Number(sh.cornerRadius.exact.num) / Number(sh.cornerRadius.exact.den)

const pocket = (s: DesignSetup, shape: object) =>
  s.run('design.pocket.add', { partId: s.partId, shape, depth: '2' }) as Promise<{
    round?: true
    adjusted?: { path: string; from: string; to: string; rule: string; message: string }[]
  }>
const update = (s: DesignSetup, args: object, id = 'pocket1') =>
  s.run('design.pocket.update', { partId: s.partId, operationId: id, ...args }) as Promise<{
    round?: true
    adjusted?: { message: string }[]
  }>

describe('Round on operation shapes (apply rule)', () => {
  it('3 mm on a 5.5 mm wide pocket applies as Round 2.75 and reports it', async () => {
    const s = await setup()
    const r = await pocket(s, rect('25', '5.5', { cornerRadius: '3' }))
    expect(r.round).toBe(true)
    expect(r.adjusted).toEqual([
      {
        path: 'shape.cornerRadius',
        from: '3 mm',
        to: 'round',
        rule: 'cornerRadiusRound',
        message: '3 mm is more than half the width (2.75 mm): set to Round.',
      },
    ])
    expect(shapeOf(s)).toMatchObject({ round: true, cornerRadius: { source: '2.75 mm' } })
    expect(radius(shapeOf(s))).toBe(2.75)
  })

  it('a width edit moves a Round radius (8 mm wide: 4), also when the old radius is resent', async () => {
    const s = await setup()
    await pocket(s, rect('25', '5.5', { cornerRadius: 'round' }))
    const r = await update(s, { shape: rect('25', '8', { cornerRadius: '2.75' }) })
    expect(r.round).toBe(true)
    expect(r.adjusted).toBeUndefined()
    expect(radius(shapeOf(s))).toBe(4)
    // without a radius the shape stays Round too
    await update(s, { shape: rect('25', '6') })
    expect(shapeOf(s).round).toBe(true)
    expect(radius(shapeOf(s))).toBe(3)
  })

  it('entering a radius on a Round rectangle turns Round off', async () => {
    const s = await setup()
    await pocket(s, rect('25', '6', { round: true }))
    const r = await update(s, { shape: rect('25', '6', { cornerRadius: '1' }) })
    expect(r.round).toBeUndefined()
    expect(shapeOf(s).round).toBeUndefined()
    expect(radius(shapeOf(s))).toBe(1)
    // round: false on a Round rectangle keeps the entered radius
    await update(s, { shape: rect('25', '6', { round: true }) })
    await update(s, { shape: rect('25', '6', { cornerRadius: '3', round: false }) })
    expect(shapeOf(s).round).toBeUndefined()
    expect(radius(shapeOf(s))).toBe(3)
  })

  it('round: false with a too-large radius is refused as before', async () => {
    const s = await setup()
    const e = await s.fail(
      'design.pocket.add',
      {
        partId: s.partId,
        shape: rect('25', '5.5', { cornerRadius: '3', round: false }),
        depth: '2',
      },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['shape', 'cornerRadius'],
      rule: 'cornerRadiusRange',
    })
    expect(s.part().operations).toEqual([])
  })

  it('a size edit that makes the radius too large turns Round on and says so', async () => {
    const s = await setup()
    await pocket(s, rect('25', '10', { cornerRadius: '4' }))
    const r = await update(s, { shape: rect('25', '6', { cornerRadius: '4' }) })
    expect(r.round).toBe(true)
    expect(r.adjusted?.[0]?.message).toBe(
      'R 4 mm does not fit the new width (half is 3 mm): set to Round.',
    )
    expect(radius(shapeOf(s))).toBe(3)
  })

  it('profiles take Round like pockets', async () => {
    const s = await setup()
    const r = (await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('40', '20', { cornerRadius: '12' }),
    })) as { round?: true; adjusted?: unknown[] }
    expect(r.round).toBe(true)
    expect(r.adjusted).toHaveLength(1)
    expect(radius(shapeOf(s, 'profile1'))).toBe(10)
  })

  it('a formula width follows a facing edit, and the Round radius with it', async () => {
    const s = await setup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    // 6 − facing depth: 5.5 wide
    await pocket(s, rect('25', 'facing1.floor.z - stock.top.z + 6', { cornerRadius: 'round' }))
    expect(radius(shapeOf(s))).toBe(2.75)
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '1' })
    expect(shapeOf(s).round).toBe(true)
    expect(radius(shapeOf(s))).toBe(2.5)
  })

  it('records without Round stay as they were (no round key)', async () => {
    const s = await setup()
    await pocket(s, rect('25', '10', { cornerRadius: '2' }))
    expect('round' in shapeOf(s)).toBe(false)
  })

  it('roundRadius guards a hand-edited Round record', async () => {
    const s = await setup()
    await pocket(s, rect('25', '6', { round: true }))
    const l = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const op = l.part.operations[0] as Extract<Operation, { kind: 'pocket' }>
    if (op.shape.kind !== 'rectangle') throw new Error('rectangle expected')
    expect(checkOperations([op], l.stock).isOk()).toBe(true)
    // 2 mm (the depth) is in range but not the Round 3 mm of a 6 mm wide rectangle
    const bad = { ...op, shape: { ...op.shape, cornerRadius: op.depth } }
    const e = checkOperations([bad], l.stock)
    expect(e.isErr() && e.unwrapErr().issues[0]).toMatchObject({ rule: 'roundRadius' })
  })
})

describe('Round on shape items (Shape Editor rectangles)', () => {
  const item = { kind: 'rectangle', center: ['0', '0'], length: '40', width: '20' }
  type Item = { cornerRadius: { exact: { num: string; den: string } }; round?: true }
  const itemOf = (s: DesignSetup) => s.part().shapes![0]!.items[0] as unknown as Item

  it('a too-large radius turns Round on; size edits follow; a new radius turns it off', async () => {
    const s = await setup()
    const r = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ ...item, cornerRadius: '15' }],
    })) as { adjusted?: { path: string }[] }
    expect(r.adjusted?.[0]?.path).toBe('items.0.cornerRadius')
    expect(itemOf(s).round).toBe(true)
    expect(radius(itemOf(s))).toBe(10)
    const upd = { partId: s.partId, shapeId: 'shape1', index: 0 }
    await s.run('design.shape.item.update', { ...upd, width: '12' })
    expect(itemOf(s).round).toBe(true)
    expect(radius(itemOf(s))).toBe(6)
    await s.run('design.shape.item.update', { ...upd, cornerRadius: '2' })
    expect(itemOf(s).round).toBeUndefined()
    expect(radius(itemOf(s))).toBe(2)
    await s.run('design.shape.item.update', { ...upd, cornerRadius: 'round' })
    expect(radius(itemOf(s))).toBe(6)
    const e = await s.fail(
      'design.shape.item.update',
      { ...upd, cornerRadius: '7', round: false },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['items', 0, 'cornerRadius'],
      rule: 'cornerRadiusRange',
    })
  })

  it('design.shape.update keeps a Round item Round when its stored radius is resent', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [{ ...item, round: true }] })
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [{ ...item, width: '16', cornerRadius: '10' }],
    })
    expect(itemOf(s).round).toBe(true)
    expect(radius(itemOf(s))).toBe(8)
  })
})

describe('Round on pattern cells', () => {
  type Cell = { cornerRadius: { exact: { num: string; den: string } }; round?: true }
  const cellOf = (s: DesignSetup) => (s.part().features![0] as unknown as { cell: Cell }).cell

  it('a too-large cell radius turns Round on; a size edit follows it', async () => {
    const s = await setup()
    const r = (await s.run('design.pattern.add', {
      partId: s.partId,
      cell: { kind: 'rectangle', length: '10', width: '4', cornerRadius: '3' },
    })) as { adjusted?: { path: string }[] }
    expect(r.adjusted?.[0]?.path).toBe('cell.cornerRadius')
    expect(cellOf(s).round).toBe(true)
    expect(radius(cellOf(s))).toBe(2)
    await s.run('design.pattern.update', {
      partId: s.partId,
      featureId: 'pattern1',
      cell: { kind: 'rectangle', length: '10', width: '6' },
    })
    expect(cellOf(s).round).toBe(true)
    expect(radius(cellOf(s))).toBe(3)
  })

  it('a cell without Round has no round key', async () => {
    const s = await setup()
    await s.run('design.pattern.add', {
      partId: s.partId,
      cell: { kind: 'rectangle', length: '10', width: '4', cornerRadius: '1' },
    })
    expect('round' in cellOf(s)).toBe(false)
  })
})
