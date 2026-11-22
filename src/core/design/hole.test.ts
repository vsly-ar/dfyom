// The hole feature (v0.4 F3): parameters, refill from the fastener table, expansion (simple,
// counterbore), invariants, dfm.holeCustomSize, issue paths mapped to hole fields, and feature
// fields written as expressions following what they reference.
// Spec: docs/modes/design-v0.4.md#hole-feature, docs/modes/design-v0.4.md#implementation-f3
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import type { DfmWarning } from '../geometry/model'
import { uiSource } from '../commands/testing'
import { designSetup, type DesignSetup } from './design.fixture'
import { loadPart } from './load'

const ui = uiSource()
const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const opField = (s: DesignSetup, id: string, field: string) =>
  (s.op(id) as unknown as Record<string, unknown>)[field]
const feature = (s: DesignSetup, id = 'hole1') =>
  s.part().features!.find((f) => f.id === id) as Record<string, unknown>

async function addHole(s: DesignSetup, args: object) {
  return (await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...args })) as {
    featureId: string
    operationIds: string[]
    warnings: DfmWarning[]
  }
}

describe('design.hole.add', () => {
  it('simple: one drilling on the face, sizes from the table (clearance, normal fit)', async () => {
    const s = await designSetup()
    const out = await addHole(s, { fastener: 'M3' })
    expect(out).toMatchObject({ featureId: 'hole1', operationIds: ['hole1_drill'] })
    expect(s.op('hole1_drill')).toMatchObject({
      kind: 'drilling',
      on: 'stock.top',
      bottom: 'through',
      diameter: { source: '3.4 mm' },
      featureId: 'hole1',
      featureRole: 'drill',
      name: 'Hole 1 · drill',
    })
    expect(feature(s)).toMatchObject({
      kind: 'hole',
      name: 'Hole 1',
      type: 'simple',
      fastener: 'M3',
      purpose: 'clearance',
      fit: 'normal',
      bottom: 'through',
      headSink: { source: '0.2 mm' },
    })
    expect(out.warnings.filter((w) => w.code === 'dfm.holeCustomSize')).toEqual([])
  })

  it('tap drill and fits pick their table column; no fastener means 6 mm', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', purpose: 'tapDrill' })
    await addHole(s, { fastener: 'M5', fit: 'loose' })
    await addHole(s, {})
    expect(exact(opField(s, 'hole1_drill', 'diameter'))).toBe(4.2)
    expect(exact(opField(s, 'hole2_drill', 'diameter'))).toBe(5.8)
    expect(s.op('hole3_drill')).toMatchObject({ diameter: { source: '6 mm' } })
  })

  it('counterbore: a circular pocket, then the drilling on its floor (through)', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    const out = await addHole(s, { fastener: 'M5', type: 'counterbore' })
    expect(out.operationIds).toEqual(['hole1_counterbore', 'hole1_drill'])
    expect(ids(s)).toEqual(['facing1', 'hole1_counterbore', 'hole1_drill'])
    const cb = s.op('hole1_counterbore') as Record<string, unknown>
    expect(cb).toMatchObject({
      kind: 'pocket',
      on: 'facing1.floor',
      shape: { kind: 'circle', diameter: { source: '10 mm' } },
    })
    // cbDepth = k + headSink = 5 + 0.2 (design-v0.4.md § Fastener table)
    expect(exact(cb['depth'])).toBeCloseTo(5.2, 12)
    expect(s.op('hole1_drill')).toMatchObject({
      on: 'hole1_counterbore.floor',
      bottom: 'through',
      diameter: { source: '5.5 mm' },
    })
    expect(feature(s)).toMatchObject({ type: 'counterbore', cbDepth: { source: '5.2 mm' } })
  })

  it('counterbore, blind: the drilling goes depth − cbDepth below the floor', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M4', type: 'counterbore', bottom: 'flat', depth: '12' })
    const drill = s.op('hole1_drill') as Record<string, unknown>
    expect(drill).toMatchObject({ bottom: 'flat', depth: { source: '7.8 mm' } })
    expect(exact(drill['depth'])).toBeCloseTo(7.8, 12)
  })

  it('drill point gets the drilling default angle', async () => {
    const s = await designSetup()
    await addHole(s, { diameter: '5', bottom: 'drillPoint', depth: '8' })
    expect(s.op('hole1_drill')).toMatchObject({ pointAngle: { source: '118°' } })
  })

  it('inch project: table sizes stay in mm, derived ones are written in inches', async () => {
    const s = await designSetup({ units: 'inch' })
    await addHole(s, { fastener: 'M3', type: 'counterbore', center: ['1', '1'] })
    expect(s.op('hole1_drill')).toMatchObject({ diameter: { source: '3.4 mm', defaultUnit: 'in' } })
    expect(feature(s)).toMatchObject({ headSink: { source: '0.008"' } })
    // 3 mm + 0.008" written in inches, exact value kept
    expect(exact(feature(s)['cbDepth'])).toBeCloseTo(3 + 0.008 * 25.4, 12)
  })
})

describe('invariants and issue paths (at the hole fields)', () => {
  const rules = (e: { issues: readonly { path: readonly unknown[]; rule: string }[] }) =>
    e.issues.map((i) => [i.path.join('.'), i.rule])

  it('parameter rules', async () => {
    const s = await designSetup()
    const add = (args: object) =>
      s.fail(
        'design.hole.add',
        { partId: s.partId, center: ['30', '30'], ...args },
        'model.invariant',
      )
    expect(
      rules(await add({ type: 'counterbore', diameter: '8', cbDiameter: '8', cbDepth: '2' })),
    ).toEqual([['cbDiameter', 'greaterThanDiameter']])
    expect(rules(await add({ type: 'counterbore', fastener: 'M3', purpose: 'tapDrill' }))).toEqual([
      ['purpose', 'tapDrillSimple'],
    ])
    expect(rules(await add({ type: 'counterbore' }))).toEqual([
      ['cbDiameter', 'required'],
      ['cbDepth', 'required'],
    ])
    expect(rules(await add({ cbDiameter: '9' }))).toEqual([['cbDiameter', 'notForType']])
    expect(rules(await add({ bottom: 'flat' }))).toEqual([['depth', 'required']])
    expect(
      rules(await add({ fastener: 'M6', type: 'counterbore', bottom: 'flat', depth: '5' })),
    ).toEqual([['cbDepth', 'lessThanDepth']])
    expect(s.part().features).toBeUndefined()
  })

  it("an owned operation's check is reported at the hole field it comes from", async () => {
    const s = await designSetup() // 20 mm stock
    const e = await s.fail(
      'design.hole.add',
      {
        partId: s.partId,
        center: ['30', '30'],
        type: 'counterbore',
        diameter: '5',
        cbDiameter: '9',
        cbDepth: '25',
      },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['cbDepth'],
      rule: 'aboveStockBottom',
      params: { operationId: 'hole1_counterbore' },
    })
  })

  it('an unknown fastener size is input.malformed', async () => {
    const s = await designSetup()
    await s.fail(
      'design.hole.add',
      { partId: s.partId, center: ['1', '1'], fastener: 'M7' },
      'input.malformed',
    )
  })
})

describe('design.hole.update', () => {
  it('choosing fit or purpose refills the sizes; explicit sizes in the same command win', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', type: 'counterbore' })
    await s.run('design.hole.update', {
      partId: s.partId,
      featureId: 'hole1',
      fit: 'close',
      cbDiameter: '11',
    })
    expect(exact(opField(s, 'hole1_drill', 'diameter'))).toBe(5.3)
    expect(feature(s)).toMatchObject({ fit: 'close', cbDiameter: { source: '11' } })
    // a size edited by hand stays until the next refill; headSink alone does not refill
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', headSink: '0.5' })
    expect(exact(feature(s)['cbDepth'])).toBeCloseTo(5.2, 12)
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', fastener: 'M6' })
    expect(exact(feature(s)['cbDiameter'])).toBe(11)
    expect(exact(feature(s)['cbDepth'])).toBeCloseTo(6.5, 12)
    expect(exact(opField(s, 'hole1_drill', 'diameter'))).toBe(6.4)
  })

  it('dfm.holeCustomSize names a size that left the table row (info)', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M3', type: 'counterbore' })
    const out = (await s.run('design.hole.update', {
      partId: s.partId,
      featureId: 'hole1',
      cbDiameter: '7',
    })) as { warnings: DfmWarning[] }
    expect(out.warnings.filter((w) => w.code === 'dfm.holeCustomSize')).toEqual([
      expect.objectContaining({
        severity: 'info',
        operation: 'hole1_counterbore',
        parameter: 'cbDiameter',
        params: expect.objectContaining({
          field: 'cbDiameter',
          table: 6.5,
          value: 7,
          fastener: 'M3',
        }),
      }),
    ])
    // custom (no fastener): no table to differ from; the sizes stay
    const custom = (await s.run('design.hole.update', {
      partId: s.partId,
      featureId: 'hole1',
      fastener: null,
    })) as { warnings: DfmWarning[] }
    expect(custom.warnings.filter((w) => w.code === 'dfm.holeCustomSize')).toEqual([])
    expect(feature(s)['fastener']).toBeUndefined()
    expect(exact(feature(s)['cbDiameter'])).toBe(7)
    // also in design.warning.list, in design order
    await s.run('design.hole.update', {
      partId: s.partId,
      featureId: 'hole1',
      fastener: 'M3',
      diameter: '3.3',
    })
    const list = expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: DfmWarning[]
    }
    expect(
      list.warnings.filter((w) => w.code === 'dfm.holeCustomSize').map((w) => w.parameter),
    ).toEqual(['diameter'])
  })

  it('type change keeps the drill role (and its tool lock); a gone head removes its pocket', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M4' })
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole1_drill',
      tool: { kind: 'generalized', type: 'drill', diameter: '4.5' },
    })
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', type: 'counterbore' })
    expect(ids(s)).toEqual(['hole1_counterbore', 'hole1_drill'])
    expect(s.op('hole1_drill')).toMatchObject({ toolLocked: true, on: 'hole1_counterbore.floor' })
    expect(s.op('hole1_counterbore')).toMatchObject({ shape: { diameter: { source: '8 mm' } } })
    const before = s.d.doc
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', type: 'simple' })
    expect(ids(s)).toEqual(['hole1_drill'])
    expect(feature(s)['cbDiameter']).toBeUndefined()
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })
})

describe('feature fields written as expressions (F1 known issue)', () => {
  it('follow an edit of what they reference: record and owned operations', async () => {
    const s = await designSetup() // stock 20 thick
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['70', '30'], length: '20', width: '20' },
      depth: '5',
    })
    await addHole(s, {
      fastener: 'M3',
      type: 'counterbore',
      bottom: 'flat',
      depth: 'pocket1.floor.z - stock.bottom.z - 5',
    })
    expect(exact(feature(s)['depth'])).toBe(10)
    expect(exact(opField(s, 'hole1_drill', 'depth'))).toBeCloseTo(6.8, 12)
    const before = s.d.doc
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '8' })
    expect(feature(s)['depth']).toMatchObject({ source: 'pocket1.floor.z - stock.bottom.z - 5' })
    expect(exact(feature(s)['depth'])).toBe(7)
    expect(exact(opField(s, 'hole1_drill', 'depth'))).toBeCloseTo(3.8, 12)
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })

  it('a recalculation that breaks a hole rule fails at features.<id>.<field>', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['70', '30'], length: '20', width: '20' },
      depth: '5',
    })
    await addHole(s, {
      fastener: 'M3',
      type: 'counterbore',
      bottom: 'flat',
      depth: 'pocket1.floor.z - stock.bottom.z - 5',
    })
    const e = await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'pocket1', depth: '13' },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['features', 'hole1', 'cbDepth'],
      rule: 'lessThanDepth',
    })
  })
})

describe('persistence', () => {
  it('a part with holes loads (the kind is built in, no command registry needed)', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M8', type: 'counterbore', bottom: 'flat', depth: '15' })
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    expect(loaded.features.map((l) => l.feature.id)).toEqual(['hole1'])
    const list = expectOk(s.d.query('design.feature.list', { partId: s.partId }, ui)).value as {
      features: { feature: { id: string }; operationIds: string[] }[]
    }
    expect(list.features[0]).toMatchObject({
      feature: { id: 'hole1', kind: 'hole' },
      operationIds: ['hole1_counterbore', 'hole1_drill'],
    })
  })
})
