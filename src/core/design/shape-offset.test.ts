// Offset items (D1, slice LF1): the offset oracle on the enclosure outline, the item through
// the shape commands (inward, outward, follow-edit with pending operations, the refusals), and
// removal while referenced. Doc: docs/modes/design-llm-first.md#offset-item, #testing
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { regionArea, regionLoops, type Region } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { maxOffsetError } from '../geometry/2d/testing/oracles'
import { shapeOutline } from '../geometry/outline'
import { hashJson } from '../plan/snapshot'
import { importSvg } from '../import/svg'
import { designSetup, type DesignSetup } from './design.fixture'
import { ENCLOSURE_SECTIONS_SVG } from './enclosure-sections.testing'
import { partGeometryInput } from './load'
import { definitionOf, resolveDefinition, withOffsetSources, type ShapeDefinition } from './shape'
import { svgShapeItems } from './shape-import'
import { designChangeTargets } from './shape-users'

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, enc: 'utf8'): string }
}
const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')

const region2d = nodeRegion2d()
/** The offset oracle's tolerance: the port's retries move an offset by up to 2e-3 mm (B2). */
const ORACLE = 2.5e-3

// ── resolution: the oracle on the black-box test's outline ─────────────────────────────────

/** The enclosure outline (shape1 of the fixture drawing) as the resolver's definition. */
function outlineDefinition(): ShapeDefinition {
  const svg = importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8'), { unit: 'mm' }).unwrap()
  return definitionOf(svgShapeItems(svg.shapes[0]!, 'mm').unwrap())
}

const OUTLINE = outlineDefinition()
const regionOf = (def: ShapeDefinition): Region => {
  const r = expectOk(resolveDefinition(region2d, def))
  if (r.kind !== 'region') throw new Error('a region expected')
  return r.region
}
const offsetOf = (distance: number, direction: 'inward' | 'outward'): ShapeDefinition =>
  withOffsetSources(
    [{ kind: 'offset', op: 'add', shapeId: 'shape1', distance, direction }],
    (id) => (id === 'shape1' ? OUTLINE : undefined),
  )

describe('offset item resolution (enclosure outline)', () => {
  const source = regionOf(OUTLINE)
  const cases: [number, 'inward' | 'outward'][] = [
    [0.81, 'inward'],
    [4.8, 'inward'],
    [4.83, 'inward'],
    [4.85, 'inward'],
    [5, 'inward'],
    [3, 'outward'],
  ]
  for (const [d, direction] of cases)
    it(`${direction} ${d} mm: every output point lies ${d} mm from the outline`, () => {
      const out = regionOf(offsetOf(d, direction))
      expect(maxOffsetError(regionLoops(source), regionLoops(out), d)).toBeLessThan(ORACLE)
      const grows = regionArea(out) > regionArea(source)
      expect(grows).toBe(direction === 'outward')
    })

  it('outward convex corners become arcs; the source is folded like any item', () => {
    const out = regionOf(offsetOf(3, 'outward'))
    expect(out.pieces[0]!.outer.elements.every((e) => e.kind === 'arc')).toBe(true)
    // the outline minus its 4.83 mm inset: a ring with one hole
    const ring = withOffsetSources(
      [
        ...OUTLINE,
        { kind: 'offset', op: 'subtract', shapeId: 'shape1', distance: 4.83, direction: 'inward' },
      ],
      (id) => (id === 'shape1' ? OUTLINE : undefined),
    )
    const r = regionOf(ring)
    expect(r.pieces).toHaveLength(1)
    expect(r.pieces[0]!.holes).toHaveLength(1)
  })

  it('a missing source or a cycle is refused at items.<n>.shapeId', () => {
    const missing = resolveDefinition(
      region2d,
      withOffsetSources(
        [{ kind: 'offset', op: 'add', shapeId: 'shape9', distance: 1, direction: 'inward' }],
        () => undefined,
      ),
    )
    expect(missing.unwrapErr().issues[0]).toMatchObject({
      path: ['items', 0, 'shapeId'],
      rule: 'unknownShape',
    })
    // shape1 offsets shape2, which offsets shape1
    const a: ShapeDefinition = [
      { kind: 'offset', op: 'add', shapeId: 'shape2', distance: 1, direction: 'inward' },
    ]
    const b: ShapeDefinition = [
      { kind: 'offset', op: 'add', shapeId: 'shape1', distance: 1, direction: 'outward' },
    ]
    const lookup = (id: string) => (id === 'shape1' ? a : id === 'shape2' ? b : undefined)
    const cycle = resolveDefinition(region2d, withOffsetSources(a, lookup, new Set(['shape1'])))
    expect(cycle.unwrapErr().issues[0]).toMatchObject({
      path: ['items', 0, 'shapeId'],
      rule: 'shapeCycle',
    })
  })
})

// ── commands ────────────────────────────────────────────────────────────────────────────────

const setup = () => designSetup({ services: { region2d } })
const rect = { kind: 'rectangle', center: ['0', '0'], length: '40', width: '20' }
const offset = (shapeId: string, distance: string, direction: 'inward' | 'outward') => ({
  kind: 'offset',
  shapeId,
  distance,
  direction,
})
const query = (s: DesignSetup, name: string, args: object) =>
  expectOk(s.d.query(name, args, uiSource())).value as Record<string, unknown>
const resolvedOf = (s: DesignSetup, shapeId: string) =>
  query(s, 'design.shape.get', { partId: s.partId, shapeId })['resolved'] as {
    bounds: { min: number[]; max: number[] }
    area: number
  }

/** Bounds of an operation's placed outline in its face frame (µm rounded). */
function placedBounds(s: DesignSetup, id: string) {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = input.operations.find((o) => o.id === id)
  if (op?.kind !== 'pocket' && op?.kind !== 'profile') throw new Error('shape operation expected')
  const o = shapeOutline(op.shape)
  if (o.kind !== 'region') throw new Error('a region expected')
  const pts = o.region.pieces.flatMap((p) => p.outer.elements.flatMap((e) => [e.a, e.b]))
  const r = (x: number) => Math.round(x * 1e3) / 1e3
  return {
    min: [r(Math.min(...pts.map((p) => p[0]))), r(Math.min(...pts.map((p) => p[1])))],
    max: [r(Math.max(...pts.map((p) => p[0]))), r(Math.max(...pts.map((p) => p[1])))],
  }
}

describe('offset items through the shape commands', () => {
  it('inward and outward offsets of a shape, in the source frame', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    const r = (await s.run('design.shape.add', {
      partId: s.partId,
      items: [offset('shape1', '2', 'inward')],
    })) as { shapeId: string }
    expect(r.shapeId).toBe('shape2')
    const item = s.part().shapes![1]!.items[0]!
    expect(item).toMatchObject({ kind: 'offset', op: 'add', shapeId: 'shape1' })
    expect(item.kind === 'offset' && item.distance.source).toBe('2')
    expect('source' in item).toBe(false)
    expect(resolvedOf(s, 'shape2').bounds).toEqual({ min: [-18, -8], max: [18, 8] })
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape2',
      index: 0,
      distance: '3',
      direction: 'outward',
    })
    const out = resolvedOf(s, 'shape2')
    const um = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6)
    expect([um(out.bounds.min), um(out.bounds.max)]).toEqual([
      [-23, -13],
      [23, 13],
    ])
    // round convex corners: 40 × 20 with R 3 grown by 3 has R 6 corners
    expect(out.area).toBeCloseTo(46 * 26 - (4 - Math.PI) * 36, 6)
    const list = query(s, 'design.shape.list', { partId: s.partId })['shapes'] as {
      kind?: string
    }[]
    expect(list.map((x) => x.kind)).toEqual(['region', 'region'])
  })

  it('follows edits of the source: the placed outline changes, its operations are pending', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.run('design.shape.add', { partId: s.partId, items: [offset('shape1', '2', 'inward')] })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
      depth: '2',
    })
    expect(placedBounds(s, 'pocket1')).toEqual({ min: [32, 22], max: [68, 38] })
    await s.run('project.apply', {})
    const hash = () => hashJson(expectOk(partGeometryInput(s.d.doc, s.partId, region2d)))
    const before = hash()
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      length: '50',
    })
    expect(hash()).not.toBe(before)
    expect(placedBounds(s, 'pocket1')).toEqual({ min: [27, 22], max: [73, 38] })
    expect(designChangeTargets(s.part(), { shapeId: 'shape1' })).toEqual(['pocket1'])
    const pending = query(s, 'project.pending.get', {})['changes'] as Record<string, unknown>[]
    expect(pending.map((c) => c['shapeId'])).toEqual(['shape1'])
  })

  it('re-anchors an operation on an offset shape without moving it (X2: its source is loaded)', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.run('design.shape.add', { partId: s.partId, items: [offset('shape1', '2', 'inward')] })
    await s.run('design.profile.add', {
      partId: s.partId,
      side: 'outside',
      shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
    })
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      anchor: { u: 'min', v: 'min' },
    })
    expect(placedBounds(s, 'profile1')).toEqual({ min: [32, 22], max: [68, 38] })
    const op = s.part().operations[0] as unknown as { shape: { center: { source: string }[] } }
    const shape = op.shape
    expect(shape.center.map((c) => c.source)).toEqual(['32', '22'])
  })

  it('refuses unknownShape, shapeCycle, offsetOpenPath, shapeEmpty and negative distances', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    const issue = async (args: object) =>
      (await s.fail('design.shape.add', { partId: s.partId, ...args }, 'model.invariant')).issues[0]
    expect(await issue({ items: [offset('shape9', '1', 'inward')] })).toMatchObject({
      path: ['items', 0, 'shapeId'],
      rule: 'unknownShape',
    })
    expect(await issue({ items: [offset('shape1', '15', 'inward')] })).toMatchObject({
      path: ['items', 0, 'distance'],
      rule: 'shapeEmpty',
    })
    expect(await issue({ items: [offset('shape1', '-1', 'inward')] })).toMatchObject({
      path: ['items', 0, 'distance'],
      rule: 'nonNegative',
    })
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          segments: [{ kind: 'line', to: ['10', '0'] }],
          closed: false,
        },
      ],
    })
    expect(await issue({ items: [offset('shape2', '1', 'outward')] })).toMatchObject({
      path: ['items', 0, 'shapeId'],
      rule: 'offsetOpenPath',
    })
    // shape3 offsets shape1: shape1 may not offset shape3, nor itself
    await s.run('design.shape.add', { partId: s.partId, items: [offset('shape1', '1', 'outward')] })
    for (const target of ['shape3', 'shape1']) {
      const e = await s.fail(
        'design.shape.update',
        { partId: s.partId, shapeId: 'shape1', items: [offset(target, '1', 'inward')] },
        'model.invariant',
      )
      expect(e.issues[0]).toMatchObject({ path: ['items', 0, 'shapeId'], rule: 'shapeCycle' })
    }
  })

  it('refuses a source edit that leaves an offsetting shape empty, at shapes.<id>.items', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.run('design.shape.add', { partId: s.partId, items: [offset('shape1', '8', 'inward')] })
    const e = await s.fail(
      'design.shape.item.update',
      { partId: s.partId, shapeId: 'shape1', index: 0, width: '15' },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['shapes', 'shape2', 'items', 0, 'distance'],
      rule: 'shapeEmpty',
    })
    expect(s.part().shapes![0]!.items[0]).toMatchObject({ width: { source: '20' } })
  })

  it('a referenced source cannot be removed (design.referenced)', async () => {
    const s = await setup()
    await s.run('design.shape.add', { partId: s.partId, items: [rect] })
    await s.run('design.shape.add', { partId: s.partId, items: [offset('shape1', '1', 'inward')] })
    const e = await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'shape1' },
      'design.referenced',
    )
    expect(e.issues[0]).toMatchObject({
      path: ['shapes', 'shape2', 'items'],
      rule: 'referenced',
    })
    await s.run('design.shape.remove', { partId: s.partId, shapeId: 'shape2' })
    await s.run('design.shape.remove', { partId: s.partId, shapeId: 'shape1' })
    expect(s.part().shapes).toBeUndefined()
  })
})
