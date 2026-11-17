import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { loadPart } from './load'
import { designSetup, type DesignSetup } from './design.fixture'
import { effectiveTolerance } from './operation'
import { designGraph, SurfaceTable } from './surfaces'

const rect = (length: string, width: string, cornerRadius = '1') => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  cornerRadius,
})

const loaded = (s: DesignSetup) => expectOk(loadPart(s.d.doc, s.partId, 'test'))
const exactOf = (q: unknown) => (q as { exact: { num: string; den: string } }).exact

/** facing1 (1 ±0.1) → pocket1 on its floor (depth 5) → pocket2 on stock.top, depth by formula. */
async function chain(depth2: string) {
  const s = await designSetup()
  const partId = s.partId
  await s.run('design.facing.add', { partId, depth: '1 ±0.1' })
  await s.run('design.pocket.add', { partId, shape: rect('40', '20'), depth: '5' })
  await s.run('design.pocket.add', {
    partId,
    on: 'stock.top',
    shape: rect('10', '10'),
    depth: depth2,
  })
  return s
}

describe('design reference resolver', () => {
  it('resolves .z, .z.min and .z.max of stock and earlier operation surfaces', async () => {
    const s = await designSetup({ thickness: '20 ±0.2' })
    await s.run('design.facing.add', { partId: s.partId, depth: '1 +0.1/-0.05' })
    await s.run('design.pocket.add', { partId: s.partId, shape: rect('40', '20'), depth: '5' })
    await s.run('design.profile.add', { partId: s.partId, shape: rect('84', '44', '5') })
    const { part, stock } = loaded(s)
    const table = SurfaceTable.build(part.operations, stock)
    const r = table.resolver(3)
    const z = (name: string) => r.resolve(name).unwrap()
    expect(z('stock.top.z').canonical).toBe(0)
    expect(z('stock.bottom.z').canonical).toBe(-20)
    expect(z('stock.bottom.z.max').canonical).toBeCloseTo(-19.8)
    expect(z('pocket1.floor.z').canonical).toBe(-6)
    // floor = facing floor − depth: −(1 +0.1/−0.05) − 5 → −6 +0.05/−0.1
    expect(z('pocket1.floor.z.max').canonical).toBeCloseTo(-5.95)
    expect(z('pocket1.floor.z.min').canonical).toBeCloseTo(-6.1)
    expect(z('pocket1.floor.z').tolerance.unwrap().notation).toBe('deviations')
    // tab tops: −T + thickness (2 mm default); only reachable through `on`, not formulas
    expect(table.get('profile1.tab[0].top').unwrap().z.z.toNumber()).toBe(-18)
    expect(table.get('profile1.tab[4].top').isNone()).toBe(true)
    // only earlier operations and only horizontal planar surfaces
    expect(table.resolver(1).resolve('pocket1.floor.z').isNone()).toBe(true)
    expect(r.resolve('pocket1.wall[0].z').isNone()).toBe(true)
    expect(r.resolve('pocket1.floor').isNone()).toBe(true)
    expect(r.resolve('tool.diameter').isNone()).toBe(true)
    expect(r.resolve('machine.travel.z').isNone()).toBe(true)
  })

  it('a formula may reference earlier surfaces; its tolerance propagates', async () => {
    const s = await chain('-pocket1.floor.z')
    const d = s.op('pocket2') as { depth: { source: string; tolerance?: unknown } }
    expect(d.depth.source).toBe('-pocket1.floor.z')
    expect(exactOf(d.depth)).toEqual({ num: '6', den: '1' })
    expect(d.depth.tolerance).toMatchObject({ notation: 'symmetric' })
  })

  it('a reference to a later or the same operation is an unknown reference', async () => {
    const s = await chain('5')
    const later = await s.fail(
      'design.facing.update',
      { partId: s.partId, operationId: 'facing1', depth: '-pocket1.floor.z' },
      'expression.reference',
    )
    expect(later.issues[0]).toMatchObject({ path: ['depth'], rule: 'unknownReference' })
    await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'pocket2', depth: '-pocket2.floor.z' },
      'expression.reference',
    )
  })
})

describe('dependency recalculation', () => {
  it('an update re-evaluates dependants through the chain, as one undo step', async () => {
    const s = await chain('-pocket1.floor.z')
    const before = s.d.doc
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '2' })
    // facing1.floor.z −2 → pocket1.floor.z −7 → pocket2.depth 7, untoleranced now
    const d = s.op('pocket2') as { depth: { source: string; tolerance?: unknown } }
    expect(d.depth.source).toBe('-pocket1.floor.z')
    expect(exactOf(d.depth)).toEqual({ num: '7', den: '1' })
    expect(d.depth.tolerance).toBeUndefined()
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })

  it('also follows a changed `on`', async () => {
    const s = await chain('-pocket1.floor.z')
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      on: 'stock.top',
    })
    expect(exactOf((s.op('pocket2') as { depth: unknown }).depth)).toEqual({ num: '5', den: '1' })
  })

  it('a dependant made invalid fails the update with its path; nothing changes', async () => {
    const s = await chain('-pocket1.floor.z + 5')
    const before = s.d.doc
    const e = await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'pocket1', depth: '15' },
      'model.invariant',
    )
    // pocket2.depth = 16 + 5 = 21 ≥ 20: its floor would be below the stock bottom
    expect(e.issues).toEqual([
      expect.objectContaining({
        path: ['operations', 'pocket2', 'depth'],
        rule: 'aboveStockBottom',
      }),
    ])
    expect(s.d.doc).toBe(before)
  })

  it('the graph orders surfaces and formulas and lists exactly the affected ones', async () => {
    const s = await chain('-pocket1.floor.z')
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'stock.top',
      center: ['5', '5'],
      diameter: '3',
      bottom: 'flat',
      depth: '-facing1.floor.z.min',
    })
    const { part, stock } = loaded(s)
    const g = expectOk(designGraph(part.operations, stock))
    expect(g.affectedBy(['pocket1#params'])).toEqual(['pocket1.floor.z', 'pocket2#depth'])
    expect(g.affectedBy(['facing1#params'])).toEqual([
      'facing1.floor.z',
      'pocket1.floor.z',
      'pocket2#depth',
      'drill1#depth',
    ])
    expect(g.affectedBy(['pocket2#params'])).toEqual(['pocket2.floor.z'])
  })
})

describe('effective tolerance', () => {
  it('explicit, else operation, else part general tolerance of the kind', async () => {
    const s = await designSetup()
    await s.run('design.part.update', { partId: s.partId, generalTolerance: { length: '0.2' } })
    await s.run('design.facing.add', { partId: s.partId, depth: '1' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: rect('40', '20'),
      depth: '5 ±0.01',
      generalTolerance: { length: '0.05' },
    })
    const { part } = loaded(s)
    const [facing, pocket] = part.operations as [
      Extract<(typeof part.operations)[number], { kind: 'facing' }>,
      Extract<(typeof part.operations)[number], { kind: 'pocket' }>,
    ]
    const upper = (t: ReturnType<typeof effectiveTolerance>) => t.unwrap().upper.toNumber()
    expect(upper(effectiveTolerance(facing.depth, facing, part))).toBe(0.2)
    expect(upper(effectiveTolerance(pocket.depth, pocket, part))).toBe(0.01)
    expect(upper(effectiveTolerance(pocket.floorRadius, pocket, part))).toBe(0.05)
    expectErrCode(loadPart(s.d.doc, 'nope', 'test'), 'input.malformed')
  })
})
