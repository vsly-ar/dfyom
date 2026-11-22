// The chamfer operation (v0.4 C2): add/update with defaults, refusals, the edge following
// (`on`, references), DFM (too deep, no tool), Clones of a drilling with its chamfer, and a
// chamfer as an owned operation of a feature (F4 countersink = drilling + chamfer).
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
  it('defaults: edge Ø + 1 mm, 90°, on the edge face; undoable', async () => {
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
    expect(exact(c['diameter'])).toBe(7)
    expect(c['angle']).toMatchObject({ source: '90°' })
    await s.undo()
    expect(s.part().operations.map((o) => o.id)).toEqual(['drill1'])
  })

  it('inch parts widen by 1/32"', async () => {
    const s = await designSetup({ units: 'inch' })
    await drill(s, { diameter: '1/4"' })
    await chamfer(s)
    expect(exact(s.op('chamfer1')['diameter' as never])).toBeCloseTo((1 / 4 + 1 / 32) * 25.4, 9)
  })

  it('a circle pocket is an edge too; the chamfer sits on its face', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '12' },
      depth: '4',
    })
    await chamfer(s, { edgeOf: 'pocket1', diameter: '14', angle: '60' })
    expect(s.op('chamfer1')).toMatchObject({ on: 'facing1.floor', angle: { source: '60' } })
  })

  it('an inside circle profile (a through opening) is an edge; outside and on profiles are not', async () => {
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
    expect(exact(s.op('chamfer1')['diameter' as never])).toBe(23)
    expect(s.op('chamfer1')).toMatchObject({ on: 'stock.top', edgeOf: 'profile1' })
    // through: the cone never reaches a bottom
    expect(warnings(s).map((w) => w.code)).not.toContain('dfm.chamferTooDeep')
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { ...circle, center: ['20', '30'], diameter: '10' },
      side: 'outside',
      tabs: { count: '0' },
    })
    const e = await s.fail(
      'design.chamfer.add',
      { partId: s.partId, edgeOf: 'profile2' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('chamferEdge')
  })

  it('refuses a missing or non-circular edge, a small diameter and an angle out of range', async () => {
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
    expect(
      rule(
        await s.fail(
          'design.chamfer.add',
          { partId: s.partId, edgeOf: 'pocket1' },
          'model.invariant',
        ),
      ),
    ).toContain('chamferEdge')
    expect(
      rule(
        await s.fail(
          'design.chamfer.add',
          { partId: s.partId, edgeOf: 'drill1', diameter: '5' },
          'model.invariant',
        ),
      ),
    ).toContain('greaterThanEdge')
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

  it('update: a new edge re-defaults the diameter; angle changes keep it', async () => {
    const s = await designSetup()
    await drill(s)
    await drill(s, { center: ['60', '30'], diameter: '10' })
    await chamfer(s, { diameter: '8' })
    await s.run('design.chamfer.update', { partId: s.partId, operationId: 'chamfer1', angle: '82' })
    expect(exact(s.op('chamfer1')['diameter' as never])).toBe(8)
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      edgeOf: 'drill2',
    })
    expect(exact(s.op('chamfer1')['diameter' as never])).toBe(11)
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
  it('dfm.chamferTooDeep when the cone reaches past a blind edge, with a suggested Ø', async () => {
    const s = await designSetup()
    await drill(s, { bottom: 'flat', depth: '1' })
    await chamfer(s, { diameter: '10' })
    const w = warnings(s).find((x) => x.code === 'dfm.chamferTooDeep')
    expect(w).toMatchObject({ operation: 'chamfer1', parameter: 'diameter' })
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      diameter: '7',
    })
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
    // the source follows: a new diameter reaches the instance
    await s.run('design.chamfer.update', {
      partId: s.partId,
      operationId: 'chamfer1',
      diameter: '8',
    })
    expect(exact(s.op('clones1_2_chamfer1')['diameter' as never])).toBe(8)
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
          diameter: p.sinkDiameter,
          angle: Quantity.parse('90°', fieldContext('angle', ctx.units)).unwrap(),
          stepdown: None,
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
    expect(exact(s.op('sink1_sink')['diameter' as never])).toBe(10)
  })
})
