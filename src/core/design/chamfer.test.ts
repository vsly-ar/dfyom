// The chamfer operation (v0.4 C2, sized by width since D45): add/update with defaults, width or
// depth, refusals, the edge following (`on`, references, a new edge keeps the width), DFM (too
// deep, no tool), Clones of a drilling with its chamfer, and a chamfer as an owned operation of
// a feature (F4 countersink = drilling + chamfer).
// Spec: docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges,
// docs/modes/design-v0.4.md#implementation-c2
import { describe, expect, it } from 'vitest'
import { collect, None, Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import type { AppError } from '../../shared/errors/app-error'
import { uiSource } from '../commands/testing'
import type { DfmWarning } from '../geometry/model'
import { PointArg, Src } from './commands'
import { designSetup, type DesignSetup } from './design.fixture'
import type { FeatureBase } from './feature'
import { featureKindCommands, type FeatureCommandSpec } from './feature-commands'
import type { FeatureDTO } from './feature.dto'
import { fieldContext, type Point } from './operation'
import { followEdges } from './surfaces'
import { loadPart } from './load'
import { Quantity } from '../quantity/quantity'
import { quantityFromDTO } from '../library/item'
import type { QuantityDTO } from '../quantity/quantity.dto'

const ui = uiSource()
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const warnings = (s: DesignSetup) =>
  (
    expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: DfmWarning[]
    }
  ).warnings

async function drill(s: DesignSetup, extra: object = {}) {
  await s.run('design.drilling.add', {
    partId: s.partId,
    center: ['30', '30'],
    diameter: '6',
    ...extra,
  })
}
const chamfer = (s: DesignSetup, extra: object = {}) =>
  s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'drill1', ...extra }) as Promise<{
    operationId: string
    warnings: DfmWarning[]
  }>

describe('design.chamfer.add / update', () => {
  it('defaults: width 0.5 mm (edge Ø + 1 mm), 90°, on the edge face; undoable', async () => {
    const s = await designSetup()
    await drill(s)
    const out = await chamfer(s)
    expect(out.operationId).toBe('chamfer1')
    const c = s.op('chamfer1') as Record<string, unknown>
    expect(c).toMatchObject({
      kind: 'chamfer',
      on: 'stock.top',
      edgeOf: 'drill1',
      name: 'Chamfer 1',
    })
    expect(exact(c['width'])).toBe(0.5)
    expect(c['diameter']).toBeUndefined()
    expect(c['angle']).toMatchObject({ source: '90°' })
    await s.undo()
    expect(s.part().operations.map((o) => o.id)).toEqual(['drill1'])
  })

  it('inch parts default to 1/64" wide', async () => {
    const s = await designSetup({ units: 'inch' })
    await drill(s, { diameter: '1/4"' })
    await chamfer(s)
    expect(exact(s.op('chamfer1')['width' as never])).toBeCloseTo(25.4 / 64, 9)
  })

  it('a depth instead of the width: the width follows through the angle', async () => {
    const s = await designSetup()
    await drill(s)
    await chamfer(s, { depth: '1.5' })
    // 90°: as wide as deep, exact
    expect(s.op('chamfer1')['width' as never]).toMatchObject({
      exact: { num: '3', den: '2' },
    })
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      angle: '60',
      depth: '2',
    })
    // width = depth × tan(30°), kept to 1 µm
    expect(exact(s.op('chamfer1')['width' as never])).toBeCloseTo(2 * Math.tan(Math.PI / 6), 6)
    const e = await s.fail(
      'design.chamfer.update',
      { partId: s.partId, operationId: 'chamfer1', width: '1', depth: '1' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('notWithWidth')
  })

  it('a circle pocket is an edge too; the chamfer sits on its face', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '12' },
      depth: '4',
    })
    await chamfer(s, { edgeOf: 'pocket1', width: '1', angle: '60' })
    expect(s.op('chamfer1')).toMatchObject({ on: 'facing1.floor', angle: { source: '60' } })
  })

  it('inside and outside profiles are edges (E1, E2); an on profile is not', async () => {
    const s = await designSetup()
    const circle = { kind: 'circle', center: ['50', '30'], diameter: '22' }
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: circle,
      side: 'inside',
      slotWidth: '11',
      tabs: { count: '0' },
    })
    await chamfer(s, { edgeOf: 'profile1' })
    expect(exact(s.op('chamfer1')['width' as never])).toBe(0.5)
    expect(s.op('chamfer1')).toMatchObject({ on: 'stock.top', edgeOf: 'profile1' })
    // through: the cone never reaches a bottom
    expect(warnings(s).map((w) => w.code)).not.toContain('dfm.chamferTooDeep')
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { ...circle, center: ['20', '30'], diameter: '10' },
      side: 'outside',
      tabs: { count: '0' },
    })
    await chamfer(s, { edgeOf: 'profile2' })
    expect(s.op('chamfer2')).toMatchObject({ on: 'stock.top', edgeOf: 'profile2' })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { ...circle, center: ['80', '30'], diameter: '10' },
      side: 'on',
      tabs: { count: '0' },
    })
    const e = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'profile3' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('chamferEdge')
  })

  it('refuses a missing edge, a width of 0 and an angle out of range', async () => {
    const s = await designSetup()
    await drill(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['70', '30'], length: '10', width: '10' },
      depth: '2',
    })
    const rule = (e: AppError) => e.issues.map((i) => i.rule)
    expect(
      rule(
        await s.fail(
          'design.chamfer.add',
          { partId: s.partId, edgeOf: 'drill9' },
          'model.invariant',
        ),
      ),
    ).toContain('chamferEdge')
    // a rectangle pocket's rim is a general edge (edge-chamfers.md E1): accepted, not stepped
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1' })
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'chamfer1' })
    expect(
      rule(
        await s.fail(
          'design.chamfer.add',
          { partId: s.partId, edgeOf: 'drill1', width: '0' },
          'model.invariant',
        ),
      ),
    ).toContain('positive')
    expect(
      rule(
        await s.fail(
          'design.chamfer.add',
          { partId: s.partId, edgeOf: 'drill1', angle: '150' },
          'model.invariant',
        ),
      ),
    ).toContain('range')
    expect(s.part().operations).toHaveLength(2)
  })

  it('update: the width stays when the angle, the edge or the edge Ø changes', async () => {
    const s = await designSetup()
    await drill(s)
    await drill(s, { center: ['60', '30'], diameter: '10' })
    await chamfer(s, { width: '1' })
    await s.run('design.chamfer.update', { partId: s.partId, operationId: 'chamfer1', angle: '82' })
    expect(exact(s.op('chamfer1')['width' as never])).toBe(1)
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      edgeOf: 'drill2',
    })
    expect(exact(s.op('chamfer1')['width' as never])).toBe(1)
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill2',
      diameter: '12',
    })
    expect(exact(s.op('chamfer1')['width' as never])).toBe(1)
  })

  it('follows its edge: moving the edge to another face moves the chamfer', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await drill(s)
    await chamfer(s)
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill1',
      on: 'stock.top',
    })
    expect(s.op('chamfer1').on).toBe('stock.top')
  })

  it('removing its edge is refused (design.referenced)', async () => {
    const s = await designSetup()
    await drill(s)
    await chamfer(s)
    await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'drill1' },
      'design.referenced',
    )
  })

  it('followEdges sets on from the edge', async () => {
    const s = await designSetup()
    await drill(s)
    await chamfer(s)
    const l = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const moved = l.part.operations.map((o) =>
      o.kind === 'drilling' ? { ...o, on: 'stock.bottom' } : o,
    )
    expect(followEdges(moved).find((o) => o.id === 'chamfer1')!.on).toBe('stock.bottom')
  })
})

describe('chamfer DFM', () => {
  it('dfm.chamferTooDeep when the cone reaches past a blind edge, with a suggested width', async () => {
    const s = await designSetup()
    await drill(s, { bottom: 'flat', depth: '1' })
    await chamfer(s, { width: '2' })
    const w = warnings(s).find((x) => x.code === 'dfm.chamferTooDeep')
    expect(w).toMatchObject({ operation: 'chamfer1', parameter: 'width' })
    // 90°: at most as wide as the edge is deep
    expect(w?.suggestion).toMatchObject({ relation: 'atMost', value: expect.closeTo(1, 9) })
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      width: '0.5',
    })
    expect(warnings(s).some((x) => x.code === 'dfm.chamferTooDeep')).toBe(false)
  })

  it('dfm.chamferTooDeep through a thin floor left by a pocket from the bottom (B4)', async () => {
    const s = await designSetup()
    // the Ø6 through hole at (30, 30) on top; a 40 × 40 pocket 18.5 deep from the bottom under
    // it (the bottom face frame: u = x, v = 60 − y) leaves a 1.5 mm floor around the hole
    await drill(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'stock.bottom',
      shape: { kind: 'rectangle', center: ['30', '30'], length: '40', width: '40' },
      depth: '18.5',
    })
    await chamfer(s, { width: '2' })
    const w = warnings(s).find((x) => x.code === 'dfm.chamferTooDeep')
    expect(w).toMatchObject({
      operation: 'chamfer1',
      parameter: 'width',
      params: { edgeOf: 'pocket1', edgeDepth: expect.closeTo(1.5, 9) },
    })
    expect(w?.suggestion).toMatchObject({ relation: 'atMost', value: expect.closeTo(1.5, 9) })
    await s.run('design.chamfer.update', { partId: s.partId, operationId: 'chamfer1', width: '1' })
    expect(warnings(s).some((x) => x.code === 'dfm.chamferTooDeep')).toBe(false)
  })

  it('a floor beside the hole counts where the cone reaches over it (B4)', async () => {
    const s = await designSetup()
    await drill(s)
    // a pocket from the bottom whose wall is 3.5 mm from the hole's axis, 18.6 deep: 1.4 floor;
    // the 2 mm chamfer (Ø10) is 1.5 deep at r = 3.5, the 1 mm one (Ø8) 0.5
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'stock.bottom',
      shape: { kind: 'rectangle', center: ['43.5', '30'], length: '20', width: '20' },
      depth: '18.6',
    })
    await chamfer(s, { width: '2' })
    const w = warnings(s).find((x) => x.code === 'dfm.chamferTooDeep')
    expect(w?.params).toMatchObject({ edgeOf: 'pocket1' })
    // 1.4 × tan 45° + (3.5 − 3)
    expect(w?.suggestion).toMatchObject({ value: expect.closeTo(1.9, 9) })
    await s.run('design.chamfer.update', { partId: s.partId, operationId: 'chamfer1', width: '1' })
    expect(warnings(s).some((x) => x.code === 'dfm.chamferTooDeep')).toBe(false)
  })

  it('dfm.chamferNoTool when the library has tools but no chamfer mill fits', async () => {
    const s = await designSetup()
    await s.run('library.tool.add', {
      values: {
        name: '6 mm end mill',
        type: 'flatEndMill',
        diameter: '6',
        fluteLength: '25',
        overallLength: '60',
        fluteCount: '2',
      },
    })
    await drill(s)
    await chamfer(s)
    expect(warnings(s).find((x) => x.code === 'dfm.chamferNoTool')).toMatchObject({
      operation: 'chamfer1',
      parameter: 'angle',
    })
    await s.run('library.tool.add', {
      values: {
        name: 'V-bit 90',
        type: 'chamferMill',
        diameter: '12',
        angle: '90',
        fluteLength: '10',
        overallLength: '50',
        fluteCount: '2',
      },
    })
    expect(warnings(s).some((x) => x.code === 'dfm.chamferNoTool')).toBe(false)
  })
})

describe('chamfer with Clones', () => {
  it('a drilling with its chamfer clones as pairs; each chamfer bevels its own instance', async () => {
    const s = await designSetup()
    await drill(s)
    await chamfer(s)
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1', 'chamfer1'] },
      rows: [{ kind: 'offset', count: 2, du: '20', dv: '0' }],
    })
    expect(s.op('clones1_2_chamfer1')).toMatchObject({
      kind: 'chamfer',
      edgeOf: 'clones1_2_drill1',
    })
    // the source follows: a new width reaches the instance
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      width: '1',
    })
    expect(exact(s.op('clones1_2_chamfer1')['width' as never])).toBe(1)
    // instances are read-only
    await s.fail(
      'design.chamfer.update',
      { partId: s.partId, operationId: 'clones1_2_chamfer1', angle: '60' },
      'design.featureOwned',
    )
  })

  it('a chamfer cannot be cloned without its edge', async () => {
    const s = await designSetup()
    await drill(s)
    await chamfer(s)
    const e = await s.fail(
      'design.clones.add',
      {
        partId: s.partId,
        source: { operationIds: ['chamfer1'] },
        rows: [{ kind: 'offset', count: 2, du: '20', dv: '0' }],
      },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('clonesChamferEdge')
  })
})

// ── a chamfer owned by a feature (the F4 countersink pattern) ──────────────────────────────

interface Sink extends FeatureBase {
  readonly kind: 'sink'
  readonly center: Point
  readonly diameter: Quantity
  readonly sinkDiameter: Quantity
}
const sinkParams = { center: PointArg, diameter: Src, sinkDiameter: Src }
const q = (dto: unknown, path: string) => quantityFromDTO(dto as QuantityDTO, path)
const sinkSpec: FeatureCommandSpec<typeof sinkParams, Sink> = {
  kind: 'sink',
  idPrefix: 'sink',
  label: 'Sink',
  params: sinkParams,
  required: ['center', 'diameter', 'sinkDiameter'],
  build: (a, prev, { f, id, name, on }) => ({
    kind: 'sink',
    id,
    name,
    on,
    center:
      a.center !== undefined
        ? [f.q('center.0', 'length', a.center[0]), f.q('center.1', 'length', a.center[1])]
        : prev!.center,
    diameter: f.val('diameter', 'length', a.diameter, prev?.diameter),
    sinkDiameter: f.val('sinkDiameter', 'length', a.sinkDiameter, prev?.sinkDiameter),
  }),
  fromDTO(dto: FeatureDTO) {
    const d = dto as FeatureDTO & Record<string, unknown>
    const c = d['center'] as unknown[]
    return collect([
      q(c[0], 'center'),
      q(c[1], 'center'),
      q(d['diameter'], 'diameter'),
      q(d['sinkDiameter'], 'sinkDiameter'),
    ]).map(([u, v, diameter, sinkDiameter]) => ({
      kind: 'sink' as const,
      id: dto.id,
      name: dto.name,
      on: dto.on,
      center: [u!, v!] as Point,
      diameter: diameter!,
      sinkDiameter: sinkDiameter!,
    }))
  },
  toDTO: (p) => ({
    id: p.id,
    kind: 'sink',
    name: p.name,
    on: p.on,
    center: [p.center[0].toDTO(), p.center[1].toDTO()],
    diameter: p.diameter.toDTO(),
    sinkDiameter: p.sinkDiameter.toDTO(),
  }),
  invariants: () => [],
  expand: (p, ctx) =>
    Ok([
      {
        role: 'drill',
        operation: {
          kind: 'drilling' as const,
          on: p.on,
          center: p.center,
          diameter: p.diameter,
          bottom: 'through' as const,
          depth: None,
          pointAngle: None,
        },
      },
      {
        role: 'sink',
        operation: {
          kind: 'chamfer' as const,
          on: p.on,
          edgeOf: ctx.ownedId('drill'),
          width: Quantity.parse(
            `${(p.sinkDiameter.canonical - p.diameter.canonical) / 2}`,
            fieldContext('length', ctx.units),
          ).unwrap(),
          angle: Quantity.parse('90°', fieldContext('angle', ctx.units)).unwrap(),
          stepdown: None,
          sourceEdge: None,
        },
      },
    ]),
}
const SINK_COMMANDS = expectOk(featureKindCommands(sinkSpec))

describe('chamfer as an owned operation', () => {
  it('a feature expands a drilling and its chamfer; the chamfer bevels the owned drilling', async () => {
    const s = await designSetup({ commands: SINK_COMMANDS })
    const out = (await s.run('design.sink.add', {
      partId: s.partId,
      center: ['30', '30'],
      diameter: '5',
      sinkDiameter: '9',
    })) as { featureId: string; operationIds: string[] }
    expect(out.operationIds).toEqual(['sink1_drill', 'sink1_sink'])
    expect(s.op('sink1_sink')).toMatchObject({
      kind: 'chamfer',
      on: 'stock.top',
      edgeOf: 'sink1_drill',
      featureId: 'sink1',
      featureRole: 'sink',
    })
    await s.run('design.sink.update', { partId: s.partId, featureId: 'sink1', sinkDiameter: '10' })
    expect(exact(s.op('sink1_sink')['width' as never])).toBe(2.5)
  })
})
