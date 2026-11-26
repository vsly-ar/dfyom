// The recessed countersink hole type (H1): a recess on the face, the hole and its countersink on
// the recess floor; defaults per fastener size, refill rules, refusals, the custom-size note, and
// the recess as wide as the countersink cut away by its own dependants without a warning (DF118).
// Spec: docs/modes/hole-slots-and-round-corners.md#recessed-countersink-type,
// docs/modes/hole-slots-and-round-corners.md#implementation-h1
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart, type PartEvaluation } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { DfmWarning } from '../geometry/model'
import type { SolidKernel } from '../geometry/solid-port'
import { designSetup, type DesignSetup } from './design.fixture'
import { FASTENER_TABLE } from './fastener/data'
import { partGeometryInput } from './load'

const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const feature = (s: DesignSetup, id = 'hole1') =>
  s.part().features!.find((f) => f.id === id) as Record<string, unknown>
const rules = (e: { issues: readonly { path: readonly unknown[]; rule: string }[] }) =>
  e.issues.map((i) => [i.path.join('.'), i.rule])

async function addHole(s: DesignSetup, args: object) {
  return (await s.run('design.hole.add', {
    partId: s.partId,
    center: ['30', '30'],
    type: 'recessedCountersink',
    ...args,
  })) as { featureId: string; operationIds: string[]; warnings: DfmWarning[] }
}
const update = (s: DesignSetup, args: object) =>
  s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', ...args })

describe('recessed countersink: expansion', () => {
  it('M5: the recess on the face, then the drilling and the countersink on its floor', async () => {
    const s = await designSetup()
    const out = await addHole(s, { fastener: 'M5' })
    expect(out.operationIds).toEqual(['hole1_counterbore', 'hole1_drill', 'hole1_countersink'])
    const recess = s.op('hole1_counterbore') as Record<string, unknown>
    expect(recess).toMatchObject({ kind: 'pocket', on: 'stock.top', shape: { kind: 'circle' } })
    // ISO 10642 M5 dk 11.2 + 2 × 0.2 = 11.6; the recess 1 mm wider, 2 mm deep
    expect(exact((recess['shape'] as Record<string, unknown>)['diameter'])).toBeCloseTo(12.6, 12)
    expect(recess['depth']).toMatchObject({ source: '2 mm' })
    expect(s.op('hole1_drill')).toMatchObject({
      kind: 'drilling',
      on: 'hole1_counterbore.floor',
      bottom: 'through',
      diameter: { source: '5.5 mm' },
    })
    const cs = s.op('hole1_countersink') as Record<string, unknown>
    expect(cs).toMatchObject({
      kind: 'chamfer',
      on: 'hole1_counterbore.floor',
      edgeOf: 'hole1_drill',
      angle: { source: '90°' },
    })
    expect(cs['stepdown']).toBeUndefined()
    expect(exact(cs['width'])).toBeCloseTo((11.6 - 5.5) / 2, 12)
    expect(feature(s)).toMatchObject({
      type: 'recessedCountersink',
      fastener: 'M5',
      cbDepth: { source: '2 mm' },
      csAngle: { source: '90°' },
    })
    expect(out.warnings.filter((w) => w.code === 'dfm.holeCustomSize')).toEqual([])
  })

  it('blind: the drilling goes depth − cbDepth below the recess floor', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M4', bottom: 'flat', depth: '12', cbDepth: '3' })
    expect(exact(s.op('hole1_drill')['depth' as never])).toBeCloseTo(9, 12)
    expect(s.op('hole1_drill')).toMatchObject({ bottom: 'flat', on: 'hole1_counterbore.floor' })
  })

  it.each(['M3', 'M4', 'M5', 'M6', 'M8'])('%s: sizes from the fastener table', async (size) => {
    const row = FASTENER_TABLE.find((r) => r.size === size)!
    const s = await designSetup()
    await addHole(s, { fastener: size })
    const f = feature(s)
    const cs = row.countersunkHead.diameter + 0.4
    expect(exact(f['diameter'])).toBeCloseTo(row.clearance.normal, 12)
    expect(exact(f['csDiameter'])).toBeCloseTo(cs, 12)
    expect(exact(f['cbDiameter'])).toBeCloseTo(cs + 1, 12)
    expect(exact(f['cbDepth'])).toBe(2)
    expect(exact(f['csAngle'])).toBe(row.countersunkHead.angle)
  })

  it('inch project: the recess defaults are 0.04" wider and 0.08" deep', async () => {
    const s = await designSetup({ units: 'inch' })
    await addHole(s, { fastener: 'M5', center: ['1', '1'] })
    const f = feature(s)
    expect(f['cbDepth']).toMatchObject({ source: '0.08"' })
    expect(exact(f['cbDiameter'])).toBeCloseTo(exact(f['csDiameter']) + 0.04 * 25.4, 12)
  })
})

describe('recessed countersink: edits', () => {
  it('a new fastener refills the cone and the recess Ø, never the entered recess depth', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', cbDepth: '3' })
    await update(s, { fastener: 'M6' })
    const f = feature(s)
    expect(exact(f['csDiameter'])).toBeCloseTo(13.44 + 0.4, 12)
    expect(exact(f['cbDiameter'])).toBeCloseTo(13.84 + 1, 12)
    expect(f['cbDepth']).toMatchObject({ source: '3' })
  })

  it('the default recess follows a countersink Ø edit; an entered recess Ø stays', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5' })
    await update(s, { csDiameter: '12' })
    expect(exact(feature(s)['cbDiameter'])).toBeCloseTo(13, 12)
    await update(s, { cbDiameter: '14' })
    await update(s, { csDiameter: '11' })
    expect(feature(s)['cbDiameter']).toMatchObject({ source: '14' })
  })

  it('switching from a countersink keeps the drill role; the countersink moves to the floor', async () => {
    const s = await designSetup()
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      type: 'countersink',
      fastener: 'M5',
    })
    await update(s, { type: 'recessedCountersink' })
    expect(s.part().operations.map((o) => o.id)).toEqual([
      'hole1_counterbore',
      'hole1_drill',
      'hole1_countersink',
    ])
    expect(s.op('hole1_countersink')).toMatchObject({ on: 'hole1_counterbore.floor' })
    await update(s, { type: 'simple' })
    expect(s.part().operations.map((o) => o.id)).toEqual(['hole1_drill'])
    expect(s.op('hole1_drill')).toMatchObject({ on: 'stock.top' })
  })

  it('a hand-edited countersink Ø is a custom size; the recess never is', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', cbDiameter: '11.6', cbDepth: '4' })
    const out = (await update(s, { csDiameter: '11' })) as { warnings: DfmWarning[] }
    const custom = out.warnings.filter((w) => w.code === 'dfm.holeCustomSize')
    expect(custom.map((w) => [w.operation, w.parameter])).toEqual([
      ['hole1_countersink', 'csDiameter'],
    ])
  })

  it('round-trips through the record (load → save byte-equal)', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5' })
    const before = JSON.stringify(feature(s))
    await update(s, { name: 'Clamp screw' })
    expect(JSON.stringify({ ...feature(s), name: 'Bolt hole 1' })).toBe(before)
  })
})

describe('recessed countersink: refusals', () => {
  const fail = (s: DesignSetup, args: object) =>
    s.fail(
      'design.hole.add',
      { partId: s.partId, center: ['30', '30'], type: 'recessedCountersink', ...args },
      'model.invariant',
    )

  it('a recess narrower than the countersink, a zero recess depth, a stepped cone', async () => {
    const s = await designSetup()
    expect(rules(await fail(s, { fastener: 'M5', cbDiameter: '11' }))).toEqual([
      ['cbDiameter', 'atLeastCsDiameter'],
    ])
    expect(rules(await fail(s, { fastener: 'M5', cbDepth: '0' }))).toEqual([
      ['cbDepth', 'positive'],
    ])
    expect(rules(await fail(s, { fastener: 'M5', csMethod: 'stepped' }))).toEqual([
      ['csMethod', 'notForType'],
    ])
    expect(rules(await fail(s, { fastener: 'M5', csStepdown: '1' }))).toEqual([
      ['csStepdown', 'notForType'],
    ])
    expect(rules(await fail(s, {}))).toEqual([['csDiameter', 'required']])
    expect(s.part().features ?? []).toHaveLength(0)
  })

  it('countersinkTooDeep counts the recess: cbDepth + cone < depth', async () => {
    const s = await designSetup()
    // M5: cone (11.6 − 5.5) / 2 = 3.05 mm below a 2 mm recess: 5.05 mm > 5 mm deep
    const deep = await fail(s, { fastener: 'M5', bottom: 'flat', depth: '5' })
    expect(deep.issues).toEqual([
      expect.objectContaining({
        path: ['csDiameter'],
        rule: 'countersinkTooDeep',
        params: expect.objectContaining({ coneDepth: 3.05, depth: 5, cbDepth: 2 }),
      }),
    ])
    await addHole(s, { fastener: 'M5', bottom: 'flat', depth: '5.1' })
    expect(s.part().features).toHaveLength(1)
  })
})

describe('recessed countersink: construction surface (DF118)', () => {
  let kernel: SolidKernel
  const port = nodeRegion2d()
  beforeAll(async () => {
    kernel = expectOk(await loadManifold())
  })
  const evaluate = (s: DesignSetup): PartEvaluation => {
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, port))
    return expectOk(kernel.withSolids((solids) => evaluatePart(input, solids, undefined, port)))
  }

  it('a recess as wide as the countersink: its floor is cut away by its dependants, silently', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5', cbDiameter: '11.6' })
    const e = evaluate(s)
    expect(e.warnings.filter((w) => w.code === 'dfm.surfaceCutAway')).toEqual([])
    const floor = e.construction.find((c) => c.surface === 'hole1_counterbore.floor')
    expect(floor?.consumedBy).toContain('hole1_countersink')
    expect(floor?.referencedBy.map((r) => r.operationId).sort()).toEqual([
      'hole1_countersink',
      'hole1_drill',
    ])
  })

  it('the default 1 mm ledge keeps the floor: no construction surface', async () => {
    const s = await designSetup()
    await addHole(s, { fastener: 'M5' })
    const e = evaluate(s)
    expect(e.construction.filter((c) => c.surface === 'hole1_counterbore.floor')).toEqual([])
    expect(e.warnings.filter((w) => w.code === 'dfm.surfaceCutAway')).toEqual([])
  })
})
