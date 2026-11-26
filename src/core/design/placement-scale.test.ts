// Placement scale (D2): a uniform `scale` on a pocket's or profile's `named` placement, about the
// anchor point, before rotation and mirror; arcs stay exact; tab distances scale; refusals; and
// unscaled records stay byte-identical. Doc: docs/modes/design-llm-first.md#placement-scale
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { arcRadius, regionArea, regionLoops } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { shapeOutline } from '../geometry/outline'
import { designSetup, type DesignSetup } from './design.fixture'
import { partGeometryInput } from './load'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })

/** shape1: a 40 × 20 rectangle with R 3 corners and a Ø 6 hole (arcs on both loops). */
async function withShape(s: DesignSetup): Promise<void> {
  await s.run('design.shape.add', {
    partId: s.partId,
    items: [
      { kind: 'rectangle', center: ['0', '0'], length: '40', width: '20', cornerRadius: '3' },
      { kind: 'circle', op: 'subtract', center: ['10', '0'], diameter: '6' },
    ],
  })
}

/** The placed outline of an operation in its face frame. */
function placed(s: DesignSetup, id: string) {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
  const op = input.operations.find((o) => o.id === id)
  if (op?.kind !== 'pocket' && op?.kind !== 'profile') throw new Error('shape operation expected')
  const o = shapeOutline(op.shape)
  if (o.kind !== 'region') throw new Error('a region expected')
  const elements = regionLoops(o.region).flatMap((l) => l.elements)
  const pts = elements.flatMap((e) => [e.a, e.b])
  const r = (x: number) => Math.round(x * 1e6) / 1e6
  return {
    min: [r(Math.min(...pts.map((p) => p[0]))), r(Math.min(...pts.map((p) => p[1])))],
    max: [r(Math.max(...pts.map((p) => p[0]))), r(Math.max(...pts.map((p) => p[1])))],
    radii: elements
      .filter((e) => e.kind === 'arc')
      .map((e) => r(arcRadius(e as Extract<typeof e, { kind: 'arc' }>)))
      .sort((a, b) => a - b),
  }
}

const pocket = (s: DesignSetup, shape: object, extra: object = {}) =>
  s.run('design.pocket.add', { partId: s.partId, shape, depth: '2', ...extra })

describe('placement scale', () => {
  it('scales lines and arcs exactly about the anchor point', async () => {
    const s = await setup()
    await withShape(s)
    await pocket(s, { kind: 'named', shapeId: 'shape1', center: ['50', '30'] })
    const one = placed(s, 'pocket1')
    expect(one).toMatchObject({ min: [30, 20], max: [70, 40] })
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], scale: 1.5 },
    })
    const k = placed(s, 'pocket1')
    // the centre anchor stays at (50, 30); every size and radius × 1.5
    expect(k.min).toEqual([20, 15])
    expect(k.max).toEqual([80, 45])
    expect(k.radii).toEqual(one.radii.map((r) => Math.round(r * 1.5 * 1e6) / 1e6))
    expect(s.part().operations[0]!).toMatchObject({ shape: { scale: 1.5 } })
  })

  it('keeps a corner anchor fixed, with rotation and mirror', async () => {
    const s = await setup()
    await withShape(s)
    await pocket(
      s,
      { kind: 'named', shapeId: 'shape1', center: ['10', '10'], rotation: '90', mirror: true },
      { anchor: { u: 'min', v: 'min' } },
    )
    expect(placed(s, 'pocket1')).toMatchObject({ min: [10, 10], max: [30, 50] })
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: {
        kind: 'named',
        shapeId: 'shape1',
        center: ['10', '10'],
        rotation: '90',
        mirror: true,
        scale: 0.5,
      },
    })
    expect(placed(s, 'pocket1')).toMatchObject({ min: [10, 10], max: [20, 30] })
  })

  it('an unscaled placement stays byte-identical; scale 1 is not stored', async () => {
    const s = await setup()
    await withShape(s)
    await pocket(s, { kind: 'named', shapeId: 'shape1', center: ['50', '30'] })
    const before = JSON.stringify(s.part().operations[0])
    expect(before).not.toContain('scale')
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], scale: 1 },
    })
    expect(JSON.stringify(s.part().operations[0])).toBe(before)
  })

  it('refuses scale ≤ 0 and over 1000 (model.invariant at shape.scale)', async () => {
    const s = await setup()
    await withShape(s)
    for (const [scale, rule] of [
      [0, 'positive'],
      [-2, 'positive'],
      [1001, 'max'],
    ] as const) {
      const e = await s.fail(
        'design.pocket.add',
        {
          partId: s.partId,
          shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'], scale },
          depth: '2',
        },
        'model.invariant',
      )
      expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toContainEqual(['shape.scale', rule])
    }
    expect(s.part().operations).toHaveLength(0)
  })

  it('tab positions scale with the placement', async () => {
    const s = await setup()
    await withShape(s)
    // a single-loop shape for the profile
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [{ kind: 'rectangle', center: ['0', '0'], length: '40', width: '20' }],
    })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
      tabs: { positions: ['10', '40'] },
    })
    const positions = () => {
      const op = s.part().operations.find((o) => o.kind === 'profile')
      if (op?.kind !== 'profile') throw new Error('profile expected')
      return op.tabs.positions?.map((q) => Number(q.exact.num) / Number(q.exact.den))
    }
    expect(positions()).toEqual([10, 40])
    const id = s.part().operations.find((o) => o.kind === 'profile')!.id
    const scaled = (scale?: number) => ({
      partId: s.partId,
      operationId: id,
      shape: {
        kind: 'named',
        shapeId: 'shape2',
        center: ['50', '30'],
        ...(scale === undefined ? {} : { scale }),
      },
    })
    await s.run('design.profile.update', scaled(2))
    expect(positions()).toEqual([20, 80])
    await s.run('design.profile.update', scaled(0.5))
    expect(positions()).toEqual([5, 20])
    await s.run('design.profile.update', scaled())
    expect(positions()).toEqual([10, 40])
  })

  it('a scaled-down shape is checked against the tool like any other', async () => {
    const s = await setup()
    await withShape(s)
    const r = (await pocket(s, {
      kind: 'named',
      shapeId: 'shape1',
      center: ['50', '30'],
      scale: 0.05,
    })) as { warnings?: { code: string }[] }
    // 2 × 1 mm with a Ø 0.3 hole: no library end mill fits
    expect((r.warnings ?? []).map((w) => w.code)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^dfm\./)]),
    )
  })
})

describe('placement scale in a split', () => {
  /** Piece areas of pocket1 after splitting at x = 50: shape1 at `scale`, or `big` (shape1 × 1.5). */
  async function pieceAreas(scaled: boolean): Promise<number[]> {
    const s = await setup()
    if (scaled) await withShape(s)
    else
      await s.run('design.shape.add', {
        partId: s.partId,
        items: [
          { kind: 'rectangle', center: ['0', '0'], length: '60', width: '30', cornerRadius: '4.5' },
          { kind: 'circle', op: 'subtract', center: ['15', '0'], diameter: '9' },
        ],
      })
    await pocket(s, {
      kind: 'named',
      shapeId: 'shape1',
      center: ['50', '30'],
      rotation: '30',
      ...(scaled ? { scale: 1.5 } : {}),
    })
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }] },
    })
    const parts = Object.values(s.d.doc.parts)
      .filter((p) => p.derivedFrom?.partId === s.partId)
      .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
    return parts.map((p) => {
      const op = p.operations.find((o) => o.id === 'pocket1')!
      expect(op).toMatchObject({ shape: { kind: 'named', ...(scaled ? { scale: 1.5 } : {}) } })
      return regionArea(placedRegion(s, p.id, 'pocket1'))
    })
  }

  it('a scaled pocket crossing a split line is clipped as the same shape drawn larger', async () => {
    const scaled = await pieceAreas(true)
    const drawn = await pieceAreas(false)
    expect(scaled).toHaveLength(2)
    // the clip rectangle is stored in the shape frame at 1 nm (÷ 1.5), hence 3 decimals
    scaled.forEach((a, i) => expect(a).toBeCloseTo(drawn[i]!, 3))
  })
})

function placedRegion(s: DesignSetup, partId: string, id: string) {
  const input = expectOk(partGeometryInput(s.d.doc, partId, region2d))
  const op = input.operations.find((o) => o.id === id)
  if (op?.kind !== 'pocket') throw new Error('pocket expected')
  const o = shapeOutline(op.shape)
  if (o.kind !== 'region') throw new Error('a region expected')
  return o.region
}
