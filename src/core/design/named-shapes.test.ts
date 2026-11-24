// Operations take shapes (v0.3 K3) through a dispatcher with the real 2D port: named and rotated
// shapes placed by their placed box, re-anchoring, profile `on` (open, blind), tab positions,
// convert in one undo step, removal of a used shape, loading, and the evaluation input hash.
// Doc: docs/modes/design-v0.3.md#operations-that-take-a-shape, docs/architecture/shapes.md#implementation-k3
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { regionArea } from '../geometry/2d/model'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import type { OperationGeometry } from '../geometry/model'
import { shapeOutline } from '../geometry/outline'
import { hashJson } from '../plan/snapshot'
import { designSetup, type DesignSetup } from './design.fixture'
import { loadPart, partGeometryInput } from './load'
import { operationsUsingShape } from './shape-users'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })
const rect = { kind: 'rectangle', center: ['0', '0'], length: '40', width: '20' }
const cornerRadius = '0'

/** Adds shape1 (a 40 × 20 sharp rectangle unless `items` is given). */
async function addShape(s: DesignSetup, items: object[] = [{ ...rect, cornerRadius }]) {
  await s.run('design.shape.add', { partId: s.partId, items })
}

function geometry(s: DesignSetup, id: string): OperationGeometry {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = input.operations.find((o) => o.id === id)
  expect(op, id).toBeDefined()
  return op!
}

/** Bounds of an operation's placed outline in its face frame. */
function bounds(op: OperationGeometry) {
  if (op.kind !== 'pocket' && op.kind !== 'profile') throw new Error('shape operation expected')
  const o = shapeOutline(op.shape)
  const pts =
    o.kind === 'region'
      ? o.region.pieces.flatMap((p) => p.outer.elements.map((e) => e.a))
      : o.path.elements.map((e) => e.a)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const r = (x: number) => Math.round(x * 1e6) / 1e6
  return {
    min: [r(Math.min(...xs)), r(Math.min(...ys))],
    max: [r(Math.max(...xs)), r(Math.max(...ys))],
  }
}

describe('named shapes on operations', () => {
  it('places a named shape by its placed box: anchor, rotation, mirror', async () => {
    const s = await setup()
    await addShape(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['10', '10'] },
      anchor: { u: 'min', v: 'min' },
      depth: '3',
    })
    expect(s.op('pocket1')).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } })
    const g = geometry(s, 'pocket1')
    expect(g.kind === 'pocket' && g.shape.contour.kind).toBe('region')
    expect(bounds(g)).toEqual({ min: [10, 10], max: [50, 30] })
    // rotated 90°: the placed box is 20 × 40, still anchored at its front-left corner
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape1', center: ['10', '10'], rotation: '90' },
    })
    expect(bounds(geometry(s, 'pocket1'))).toEqual({ min: [10, 10], max: [30, 50] })
    expect(operationsUsingShape(s.part(), 'shape1')).toEqual(['pocket1'])
  })

  it('re-anchors a general shape without moving it', async () => {
    const s = await setup()
    await addShape(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], rotation: '30' },
      depth: '3',
    })
    const before = bounds(geometry(s, 'pocket1'))
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      anchor: { u: 'max', v: 'min' },
    })
    expect(bounds(geometry(s, 'pocket1'))).toEqual(before)
    const op = s.op('pocket1')
    expect(op.kind === 'pocket' && Number(op.shape.center[0].source)).toBeCloseTo(before.max[0]!, 6)
  })

  it('rotates an inline rectangle about its anchor point', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { ...rect, center: ['50', '30'], cornerRadius, rotation: '90' },
      depth: '3',
    })
    expect(bounds(geometry(s, 'pocket1'))).toEqual({ min: [40, 10], max: [60, 50] })
    // an unrotated rectangle keeps its v0.1 analytic input (byte-identical)
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { ...rect, center: ['50', '30'], cornerRadius },
    })
    const g = geometry(s, 'pocket1')
    expect(g.kind === 'pocket' && g.shape.contour.kind).toBe('rectangle')
  })

  it('refuses unknown shapes and a floor radius on a named pocket', async () => {
    const s = await setup()
    const e = await s.fail(
      'design.pocket.add',
      {
        partId: s.partId,
        shape: { kind: 'named', shapeId: 'shape9', center: ['0', '0'] },
        depth: '2',
      },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['shape', 'shapeId'], rule: 'unknownShape' })
    await addShape(s)
    const f = await s.fail(
      'design.pocket.add',
      {
        partId: s.partId,
        shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
        depth: '2',
        floorRadius: '1',
      },
      'model.invariant',
    )
    expect(f.issues.map((i) => i.rule)).toEqual(['floorRadiusShape'])
  })

  it('numbers the surfaces of a named pocket from its start point', async () => {
    const s = await setup()
    await addShape(s, [
      { ...rect, cornerRadius },
      { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '6' },
    ])
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      depth: '2',
    })
    const g = geometry(s, 'pocket1')
    if (g.kind !== 'pocket' || g.shape.contour.kind !== 'region') throw new Error('region')
    const piece = g.shape.contour.region.pieces[0]!
    // relative to the box centre: the front wall from its left end, the hole from its bottom
    expect(piece.outer.elements[0]).toEqual({ kind: 'line', a: [-20, -10], b: [20, -10] })
    expect(piece.holes[0]!.elements[0]!.a[1]).toBeCloseTo(-3, 9)
    expect(regionArea(g.shape.contour.region)).toBeCloseTo(800 - 9 * Math.PI, 6)
  })
})

describe('profiles on shapes', () => {
  const openPath = {
    kind: 'path',
    closed: false,
    start: ['0', '0'],
    segments: [
      { kind: 'line', to: ['30', '0'] },
      { kind: 'line', to: ['30', '20'] },
    ],
  }

  it('cuts an open path on its line only, without tabs; blind on any side (DF53)', async () => {
    const s = await setup()
    await addShape(s, [openPath])
    const shape = { kind: 'named', shapeId: 'shape1', center: ['50', '30'] }
    const e = await s.fail('design.profile.add', { partId: s.partId, shape }, 'model.invariant')
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([['side', 'openNeedsOn']])
    await s.run('design.profile.add', { partId: s.partId, shape, side: 'on', depth: '2' })
    const g = geometry(s, 'profile1')
    expect(g).toMatchObject({ kind: 'profile', side: 'on', depth: 2 })
    expect(g.kind === 'profile' && g.shape.contour.kind).toBe('path')
    const t = await s.fail(
      'design.profile.update',
      { partId: s.partId, operationId: 'profile1', tabs: { positions: ['5'] } },
      'model.invariant',
    )
    expect(t.issues.map((i) => i.rule)).toEqual(['tabsNotAllowed'])
    // a blind outside profile is a step (DF53); its depth must stay inside the stock
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { ...rect, center: ['50', '30'] },
      depth: '2',
    })
    expect(geometry(s, 'profile2')).toMatchObject({ kind: 'profile', side: 'outside', depth: 2 })
    const b = await s.fail(
      'design.profile.update',
      { partId: s.partId, operationId: 'profile2', depth: '500' },
      'model.invariant',
    )
    expect(b.issues.map((i) => i.rule)).toEqual(['lessThanStockThickness'])
    const p = await s.fail(
      'design.pocket.add',
      { partId: s.partId, shape, depth: '2' },
      'model.invariant',
    )
    expect(p.issues.map((i) => i.rule)).toEqual(['openNeedsOn'])
  })

  it('a blind on groove has a floor that operations start from, and evaluates (G1)', async () => {
    const s = await setup()
    await addShape(s, [openPath])
    const shape = { kind: 'named', shapeId: 'shape1', center: ['50', '30'] }
    await s.run('design.profile.add', { partId: s.partId, shape, side: 'on', depth: '2' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['35', '15'], diameter: '2' },
      depth: '1',
      on: 'profile1.floor',
    })
    expect(geometry(s, 'pocket1')).toMatchObject({ kind: 'pocket', onZ: -2, depth: 1 })
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const kernel = expectOk(await loadManifold())
    const e = expectOk(kernel.withSolids((k) => evaluatePart(input, k, undefined, region2d)))
    expect(e.pieces).toBe(1)
    for (const id of ['profile1.floor', 'profile1.wall[0]', 'profile1.wall[1]', 'pocket1.floor'])
      expect(e.surfaces).toContain(id)
  })

  it('a step (blind outside, DF53) has a floor, no tabs, and evaluates', async () => {
    const s = await setup()
    await addShape(s, [{ ...rect, cornerRadius }])
    const shape = { kind: 'named', shapeId: 'shape1', center: ['50', '30'] }
    await s.run('design.profile.add', { partId: s.partId, shape, depth: '2', slotWidth: '8' })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '16'], diameter: '2' },
      depth: '1',
      on: 'profile1.floor',
    })
    expect(geometry(s, 'pocket1')).toMatchObject({ kind: 'pocket', onZ: -2, depth: 1 })
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const kernel = expectOk(await loadManifold())
    const e = expectOk(kernel.withSolids((k) => evaluatePart(input, k, undefined, region2d)))
    expect(e.pieces).toBe(1)
    for (const id of ['profile1.floor', 'profile1.wall[0]', 'pocket1.floor'])
      expect(e.surfaces).toContain(id)
    expect(e.surfaces.some((id) => id.startsWith('profile1.tab'))).toBe(false)
  })

  it('cuts one loop and checks tab positions against its length', async () => {
    const s = await setup()
    await addShape(s, [
      { ...rect, cornerRadius },
      { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '6' },
    ])
    await addShape(s, [{ ...rect, cornerRadius }])
    const e = await s.fail(
      'design.profile.add',
      { partId: s.partId, shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] } },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['profileOneLoop'])
    const shape = { kind: 'named', shapeId: 'shape2', center: ['50', '30'] }
    const bad = await s.fail(
      'design.profile.add',
      { partId: s.partId, shape, tabs: { width: '4', positions: ['10', '12', '130'] } },
      'model.invariant',
    )
    expect(bad.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['tabs.positions.2', 'tabOutside'],
    ])
    const overlap = await s.fail(
      'design.profile.add',
      { partId: s.partId, shape, tabs: { width: '4', positions: ['10', '12'] } },
      'model.invariant',
    )
    expect(overlap.issues.map((i) => i.rule)).toEqual(['tabsOverlap'])
    await s.run('design.profile.add', {
      partId: s.partId,
      shape,
      tabs: { width: '4', positions: ['10', '70'] },
    })
    expect(geometry(s, 'profile1')).toMatchObject({ tabs: { positions: [10, 70] } })
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      tabs: { positions: null },
    })
    expect(geometry(s, 'profile1')).toMatchObject({ tabs: { count: 4 } })
    expect('positions' in (geometry(s, 'profile1') as { tabs: object }).tabs).toBe(false)
  })
})

describe('convert, remove, load, hashes', () => {
  it('convert moves the inline shape into a named shape in one undo step', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { ...rect, center: ['10', '10'], rotation: '30' },
      anchor: { u: 'min', v: 'min' },
      depth: '2',
    })
    const before = bounds(geometry(s, 'pocket1'))
    await s.run('design.shape.convert', { partId: s.partId, operationId: 'pocket1' })
    expect(s.op('pocket1')).toMatchObject({
      shape: { kind: 'named', shapeId: 'shape1', anchor: { u: 'min', v: 'min' } },
    })
    expect(bounds(geometry(s, 'pocket1'))).toEqual(before)
    await s.fail(
      'design.shape.convert',
      { partId: s.partId, operationId: 'pocket1' },
      'input.malformed',
    )
    await s.undo()
    expect(s.op('pocket1')).toMatchObject({ shape: { kind: 'rectangle' } })
    expect(s.part().shapes ?? []).toEqual([])
  })

  it('a used shape cannot be removed; a dangling reference does not load', async () => {
    const s = await setup()
    await addShape(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      depth: '2',
    })
    const e = await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'shape1' },
      'design.referenced',
    )
    expect(JSON.stringify(e.toJSON())).toContain('pocket1')
    const doc = s.d.doc
    const broken = {
      ...doc,
      parts: { [s.partId]: { ...doc.parts[s.partId]!, shapes: [] } },
    }
    const l = expectErrCode(loadPart(broken, s.partId, 'test'), 'input.malformed')
    expect(l.issues[0]).toMatchObject({ rule: 'unknownShape' })
    expect(l.issues[0]!.path.slice(-2)).toEqual(['shape', 'shapeId'])
  })

  it('the evaluation input hash follows the shape definition', async () => {
    const s = await setup()
    await addShape(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      depth: '2',
    })
    const hash = () => hashJson(expectOk(partGeometryInput(s.d.doc, s.partId, region2d)))
    const before = hash()
    await s.run('design.shape.item.update', {
      partId: s.partId,
      shapeId: 'shape1',
      index: 0,
      length: '30',
    })
    expect(hash()).not.toBe(before)
    expect(bounds(geometry(s, 'pocket1'))).toEqual({ min: [35, 20], max: [65, 40] })
    // without a port a named shape cannot be placed: a host bug, not a user error
    expectErrCode(partGeometryInput(s.d.doc, s.partId), 'internal.unexpected')
  })
})
