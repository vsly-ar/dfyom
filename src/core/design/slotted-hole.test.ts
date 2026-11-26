// Slotted (long) bolt holes (H2): `slotLength` and `rotation` on a hole; the slot expands to Round
// rectangle pockets for the bore and the recess / counterbore, and its countersink to an edge
// chamfer on the slot outline, for every hole type; slot length 0 is the round hole unchanged; the
// refusals; the drill role's tool lock across the round ↔ slotted switch; the clamps_40 hole as one
// feature against the user's construction from operations (TG #369).
// Spec: docs/modes/hole-slots-and-round-corners.md#slotted-holes-df119,
// docs/modes/hole-slots-and-round-corners.md#implementation-h2
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { designSetup, type DesignSetup } from './design.fixture'
import { partGeometryInput } from './load'

const region2d = nodeRegion2d()
const setup = (opts: { thickness?: string } = {}) =>
  designSetup({ ...opts, services: { region2d } })
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const feature = (s: DesignSetup, id = 'hole1') =>
  s.part().features!.find((f) => f.id === id) as Record<string, unknown>
const shape = (s: DesignSetup, id: string) =>
  (s.op(id) as unknown as { shape: Record<string, unknown> }).shape
const rules = (e: { issues: readonly { path: readonly unknown[]; rule: string }[] }) =>
  e.issues.map((i) => [i.path.join('.'), i.rule])
const add = (s: DesignSetup, args: object) =>
  s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...args }) as Promise<{
    operationIds: string[]
  }>
const update = (s: DesignSetup, args: object) =>
  s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', ...args })

/** A Round rectangle `length` × `width` (mm) at the hole's centre, rotated `rotation`°. */
function expectSlot(s: DesignSetup, id: string, length: number, width: number, rotation = 0) {
  const sh = shape(s, id)
  expect(sh).toMatchObject({ kind: 'rectangle', round: true })
  expect(exact(sh['length'])).toBeCloseTo(length, 12)
  expect(exact(sh['width'])).toBeCloseTo(width, 12)
  expect(exact(sh['cornerRadius'])).toBeCloseTo(width / 2, 12)
  expect(exact(sh['rotation'])).toBe(rotation)
  expect((sh['center'] as unknown[]).map(exact)).toEqual([30, 30])
}

describe('slotted hole: expansion per type', () => {
  it('simple: one through pocket, (slotLength + Ø) × Ø, Round', async () => {
    const s = await setup()
    const out = await add(s, { fastener: 'M5', slotLength: '10' })
    expect(out.operationIds).toEqual(['hole1_drill'])
    expect(s.op('hole1_drill')).toMatchObject({ kind: 'pocket', on: 'stock.top', through: true })
    expectSlot(s, 'hole1_drill', 15.5, 5.5)
    // the through pocket's depth is the material below its face when expanded
    expect(exact(s.op('hole1_drill')['depth' as never])).toBe(20)
    expect(feature(s)).toMatchObject({ slotLength: { source: '10' }, rotation: { source: '0°' } })
  })

  it('blind: a flat floor at the hole depth', async () => {
    const s = await setup()
    await add(s, { diameter: '6', slotLength: '8', bottom: 'flat', depth: '7' })
    const drill = s.op('hole1_drill') as Record<string, unknown>
    expect(drill['through']).toBeUndefined()
    expect(drill['depth']).toMatchObject({ source: '7' })
    expectSlot(s, 'hole1_drill', 14, 6)
  })

  it('counterbore: a Round counterbore pocket, then the slot on its floor', async () => {
    const s = await setup()
    const out = await add(s, { type: 'counterbore', fastener: 'M5', slotLength: '12' })
    expect(out.operationIds).toEqual(['hole1_counterbore', 'hole1_drill'])
    // ISO 4762 M5 counterbore Ø 10 (table), the slot 5.5 wide
    expectSlot(s, 'hole1_counterbore', 22, 10)
    expect(s.op('hole1_drill')).toMatchObject({ on: 'hole1_counterbore.floor', through: true })
    expectSlot(s, 'hole1_drill', 17.5, 5.5)
    const cbDepth = exact(feature(s)['cbDepth'])
    expect(exact(s.op('hole1_drill')['depth' as never])).toBeCloseTo(20 - cbDepth, 12)
  })

  it('countersink: an edge chamfer on the slot outline, (csØ − Ø) / 2 wide', async () => {
    const s = await setup()
    const out = await add(s, { type: 'countersink', fastener: 'M5', slotLength: '10' })
    expect(out.operationIds).toEqual(['hole1_drill', 'hole1_countersink'])
    expectSlot(s, 'hole1_drill', 15.5, 5.5)
    const cs = s.op('hole1_countersink') as Record<string, unknown>
    expect(cs).toMatchObject({ kind: 'chamfer', edgeOf: 'hole1_drill', on: 'stock.top' })
    expect(exact(cs['width'])).toBeCloseTo((11.6 - 5.5) / 2, 12)
  })

  it('recessed countersink: Round recess, slot and chamfer on the recess floor', async () => {
    const s = await setup()
    const out = await add(s, { type: 'recessedCountersink', fastener: 'M5', slotLength: '19.5' })
    expect(out.operationIds).toEqual(['hole1_counterbore', 'hole1_drill', 'hole1_countersink'])
    expectSlot(s, 'hole1_counterbore', 19.5 + 12.6, 12.6)
    expectSlot(s, 'hole1_drill', 25, 5.5)
    expect(s.op('hole1_drill')).toMatchObject({ on: 'hole1_counterbore.floor', through: true })
    expect(exact(s.op('hole1_drill')['depth' as never])).toBe(18)
    expect(s.op('hole1_countersink')).toMatchObject({
      edgeOf: 'hole1_drill',
      on: 'hole1_counterbore.floor',
    })
  })

  it('rotation turns every pocket of the slot about the hole centre', async () => {
    const s = await setup()
    await add(s, { type: 'recessedCountersink', fastener: 'M5', slotLength: '10', rotation: '30' })
    expectSlot(s, 'hole1_counterbore', 22.6, 12.6, 30)
    expectSlot(s, 'hole1_drill', 15.5, 5.5, 30)
    await update(s, { rotation: '90°' })
    expectSlot(s, 'hole1_drill', 15.5, 5.5, 90)
    // the slot length alone keeps the rotation
    await update(s, { slotLength: '12' })
    expectSlot(s, 'hole1_drill', 17.5, 5.5, 90)
  })
})

describe('slotted hole: slot length 0 is the round hole', () => {
  it.each(['simple', 'counterbore', 'countersink', 'recessedCountersink'])(
    '%s: slotLength 0 adds the same record and operations as no slot',
    async (type) => {
      const a = await setup()
      const b = await setup()
      await add(a, { type, fastener: 'M5' })
      await add(b, { type, fastener: 'M5', slotLength: '0' })
      expect(JSON.stringify(b.part())).toBe(JSON.stringify(a.part()))
      expect(feature(a)['slotLength']).toBeUndefined()
      expect(feature(a)['rotation']).toBeUndefined()
    },
  )

  it('an update to slotLength 0 makes a slotted hole round again', async () => {
    const a = await setup()
    const b = await setup()
    await add(a, { type: 'countersink', fastener: 'M5' })
    await add(b, { type: 'countersink', fastener: 'M5', slotLength: '10', rotation: '45' })
    expect(b.op('hole1_drill')).toMatchObject({ kind: 'pocket' })
    await update(b, { slotLength: '0' })
    expect(JSON.stringify(b.part())).toBe(JSON.stringify(a.part()))
  })
})

describe('slotted hole: refusals', () => {
  const fail = (s: DesignSetup, args: object) =>
    s.fail(
      'design.hole.add',
      { partId: s.partId, center: ['30', '30'], fastener: 'M5', ...args },
      'model.invariant',
    )

  it('notForSlot: a drill point, a tap drill, a stepped countersink', async () => {
    const s = await setup()
    const slot = { slotLength: '10' }
    expect(rules(await fail(s, { ...slot, bottom: 'drillPoint', depth: '5' }))).toEqual([
      ['bottom', 'notForSlot'],
    ])
    expect(rules(await fail(s, { ...slot, purpose: 'tapDrill' }))).toEqual([
      ['purpose', 'notForSlot'],
    ])
    expect(rules(await fail(s, { ...slot, type: 'countersink', csMethod: 'stepped' }))).toEqual([
      ['csMethod', 'notForSlot'],
    ])
    expect(s.part().features ?? []).toHaveLength(0)
  })

  it('notForRound: a rotation without a slot; a negative slot length', async () => {
    const s = await setup()
    expect(rules(await fail(s, { rotation: '30' }))).toEqual([['rotation', 'notForRound']])
    expect(rules(await fail(s, { slotLength: '-2' }))).toEqual([['slotLength', 'positive']])
  })

  it('slotTooLong: a slot longer than its face, along its rotation', async () => {
    const s = await setup()
    // the face is 100 × 60: 95 + 5.5 overall does not fit along u, 50 + 12.6 not along v
    const long = await fail(s, { center: ['50', '30'], slotLength: '95' })
    expect(long.issues).toEqual([
      expect.objectContaining({
        path: ['slotLength'],
        rule: 'slotTooLong',
        params: expect.objectContaining({ overall: 100.5, max: 94.5 }),
      }),
    ])
    const across = await fail(s, {
      center: ['50', '30'],
      type: 'recessedCountersink',
      slotLength: '50',
      rotation: '90',
    })
    expect(rules(across)).toEqual([['slotLength', 'slotTooLong']])
    await add(s, { center: ['50', '30'], fastener: 'M5', slotLength: '94.5' })
    expect(s.part().features).toHaveLength(1)
  })

  it('a refused update leaves the hole as it was', async () => {
    const s = await setup()
    await add(s, { fastener: 'M5', slotLength: '10' })
    const before = JSON.stringify(s.part())
    await s.fail(
      'design.hole.update',
      { partId: s.partId, featureId: 'hole1', bottom: 'drillPoint', depth: '5' },
      'model.invariant',
    )
    expect(JSON.stringify(s.part())).toBe(before)
  })
})

describe('slotted hole: the drill role across round ↔ slotted', () => {
  const lock = (s: DesignSetup, type: string, diameter: string) =>
    s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole1_drill',
      tool: { kind: 'generalized', type, diameter },
    })
  const tool = (s: DesignSetup) => s.op('hole1_drill') as Record<string, unknown>

  it('a locked flat end mill stays locked on the slot pocket and back', async () => {
    const s = await setup()
    await add(s, { fastener: 'M5' })
    await lock(s, 'flatEndMill', '3')
    await update(s, { slotLength: '10' })
    expect(tool(s)).toMatchObject({
      kind: 'pocket',
      tool: { kind: 'generalized', type: 'flatEndMill' },
      toolLocked: true,
    })
    await update(s, { slotLength: '0' })
    expect(tool(s)).toMatchObject({
      kind: 'drilling',
      tool: { type: 'flatEndMill' },
      toolLocked: true,
    })
  })

  it('a drill bit never fits a pocket: the slot drops it to auto', async () => {
    const s = await setup()
    await add(s, { fastener: 'M5' })
    await lock(s, 'drill', '5.5')
    expect(tool(s)).toMatchObject({ toolLocked: true })
    await update(s, { slotLength: '10' })
    expect(tool(s)['toolLocked']).toBeUndefined()
    expect(tool(s)['tool']).not.toMatchObject({ type: 'drill' })
  })
})

describe('slotted hole: the clamps_40 hole as one feature (TG #369)', () => {
  let kernel: SolidKernel
  beforeAll(async () => {
    kernel = expectOk(await loadManifold())
  })
  const volume = (s: DesignSetup) => {
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    return expectOk(kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d)))
  }

  it("M5, slot 19.5 (a 25 mm slot), recess and countersink: the user's geometry", async () => {
    const feat = await setup({ thickness: '10' })
    await add(feat, {
      type: 'recessedCountersink',
      fastener: 'M5',
      slotLength: '19.5',
      cbDiameter: '12.6',
    })
    // the user's construction from operations: a Round recess, a Round slot on its floor, an
    // edge chamfer on the slot
    const ops = await setup({ thickness: '10' })
    const rect = (length: string, width: string) => ({
      kind: 'rectangle',
      center: ['30', '30'],
      length,
      width,
      cornerRadius: 'round',
    })
    const pocket = (args: object) => ops.run('design.pocket.add', { partId: ops.partId, ...args })
    await pocket({ shape: rect('32.1', '12.6'), depth: '2' })
    await pocket({ on: 'pocket1.floor', shape: rect('25', '5.5'), depth: '8', through: true })
    await ops.run('design.chamfer.add', {
      partId: ops.partId,
      edgeOf: 'pocket2',
      on: 'pocket1.floor',
      width: '3.05',
    })
    const a = volume(feat)
    const b = volume(ops)
    expect(a.warnings).toEqual([])
    // within the chord bound: the same arcs, tessellated alike
    expect(Math.abs(a.volume - b.volume)).toBeLessThan(1e-3 * b.volume)
    // the hole removes the recess, the slot and the cone (> the 32.1 × 12.6 × 2 recess alone)
    expect(100 * 60 * 10 - a.volume).toBeGreaterThan(32.1 * 12.6 * 2)
  })
})
