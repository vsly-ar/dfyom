// Clones mirror (hardening DF126, slice M1): the `mirror` row through the path walk and the
// commands: reflected geometry (asymmetric named shapes, rotated rectangles, tabs), quadrants
// with stable numbers, on-line copies dropped, the reference (stock centre, `about` following its
// edits and refusing its removal, `at`), mirror rows last, groups, Clones of Clones, a split
// piece, limits, preview and persistence.
// Spec: docs/modes/clones-mirror.md#slices (M1), docs/modes/clones-mirror.md#implementation-m1
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { uiSource } from '../../commands/testing'
import { chainPointAt, closestOnChains } from '../../geometry/2d/measure'
import type { Loop } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import type { OperationGeometry } from '../../geometry/model'
import { profileChain, shapeOutline } from '../../geometry/outline'
import { docToFiles, loadProjectFiles } from '../../project/layout'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'
import { clonePath, type PathRow, type UV } from './path'

const region2d = nodeRegion2d()
const ui = uiSource()
const preview = (s: DesignSetup, featureId: string) =>
  expectOk(s.d.query('design.clones.preview', { partId: s.partId, featureId }, ui)).value
const setup = () => designSetup({ services: { region2d } })
const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const centre = (s: DesignSetup, id: string) => {
  const op = s.op(id) as unknown as { shape?: { center: unknown[] }; center?: unknown[] }
  return (op.shape?.center ?? op.center)!.map(exact)
}
const shapeOf = (s: DesignSetup, id: string) =>
  (s.op(id) as unknown as { shape: Record<string, unknown> }).shape

/** An L (asymmetric in u and v), 20 × 12, its inner corner at (8, 5) of its frame. */
const L_SHAPE = {
  kind: 'path',
  start: ['0', '0'],
  closed: true,
  segments: [
    { kind: 'line', to: ['20', '0'] },
    { kind: 'line', to: ['20', '5'] },
    { kind: 'line', to: ['8', '5'] },
    { kind: 'line', to: ['8', '12'] },
    { kind: 'line', to: ['0', '12'] },
  ],
}

async function withL(s: DesignSetup) {
  await s.run('design.shape.add', { partId: s.partId, items: [L_SHAPE] })
}

const geometry = (s: DesignSetup) =>
  new Map(expectOk(partGeometryInput(s.d.doc, s.partId, region2d)).operations.map((o) => [o.id, o]))

/** The outer loop of a pocket's or profile's placed shape (face frame, mm). */
function outerLoop(op: OperationGeometry | undefined): Loop {
  if (op === undefined || (op.kind !== 'pocket' && op.kind !== 'profile'))
    throw new Error('a pocket or profile expected')
  const o = shapeOutline(op.shape)
  if (o.kind !== 'region') throw new Error('a region expected')
  return o.region.pieces[0]!.outer
}

/** Every vertex of `a` reflected (`flip` across `c`) lies on `b`, and the other way round. */
function expectMirrorImage(a: Loop, b: Loop, flip: 'u' | 'v', c: number) {
  const k = flip === 'u' ? 0 : 1
  const reflect = (p: readonly [number, number]): [number, number] =>
    k === 0 ? [2 * c - p[0], p[1]] : [p[0], 2 * c - p[1]]
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const)
    for (const e of from.elements)
      expect(closestOnChains([to], reflect(e.a))!.distance).toBeLessThan(0.001)
}

describe('the path walk (path.ts)', () => {
  const offset = (count: number, du: number, skip?: number[]): PathRow => ({
    kind: 'offset',
    count,
    du,
    dv: 0,
    ...(skip ? { skip } : {}),
  })
  const mirror = (flip: 'u' | 'v', c: number, skip?: number[]): PathRow => ({
    kind: 'mirror',
    flip,
    c,
    ...(skip ? { skip } : {}),
  })
  const at = (u: number, v: number): UV => ({ u, v })

  it('two mirror rows give the four quadrants: 1 + 3 → 8 → 16, numbers in order', () => {
    const p = clonePath(at(10, 10), [offset(3, 5), mirror('u', 50), mirror('v', 30)])
    expect(p.lastNumber).toBe(16)
    expect(p.instances).toHaveLength(16)
    // the source's mirror is the first of each mirror row
    expect(p.instances[4]).toMatchObject({ number: 5, at: at(90, 10), flip: { u: true } })
    expect(p.instances[8]).toMatchObject({ number: 9, at: at(10, 50), flip: { v: true } })
    expect(p.instances[12]).toMatchObject({
      number: 13,
      at: at(90, 50),
      flip: { u: true, v: true },
    })
    // a flipped instance is translated after its flip: −u + offset
    expect(p.instances[4]!.offset).toEqual(at(100, 0))
  })

  it('a skipped original keeps its mirror skipped (and its number); the row skips its own', () => {
    const p = clonePath(at(10, 10), [offset(3, 5, [1]), mirror('u', 50, [0])])
    expect(p.instances.map((i) => i.number)).toEqual([1, 2, 4, 6, 8])
    // 3 skipped; its mirror 7 too; the row's own skip 0 is the source's mirror, 5
    expect(p.skipped).toEqual([3, 5, 7])
  })

  it('a symmetric source on the line is dropped (onLine), an asymmetric one is kept', () => {
    const on = clonePath(at(50, 10), [mirror('u', 50)], { u: true, v: false })
    expect(on.instances).toHaveLength(1)
    expect(on.onLine).toEqual([2])
    expect(on.rows[0]!.points[0]).toMatchObject({ kind: 'onLine', number: 2 })
    const asym = clonePath(at(50, 10), [mirror('u', 50)])
    expect(asym.instances.map((i) => i.number)).toEqual([1, 2])
    // a mirror image landing on another instance is a duplicate
    const dup = clonePath(at(40, 10), [offset(1, 20), mirror('u', 50)], { u: true, v: false })
    expect(dup.duplicates).toEqual([3, 4])
    expect(dup.instances.map((i) => i.number)).toEqual([1, 2])
  })
})

describe('mirrored geometry', () => {
  it('an asymmetric named pocket mirrored in u and in v reflects exactly', async () => {
    const s = await setup()
    await withL(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['20', '15'], rotation: '30' },
      anchor: { u: 'min', v: 'centre' },
      depth: '3',
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1'] },
      rows: [
        { kind: 'mirror', flip: 'u' },
        { kind: 'mirror', flip: 'v', at: '40' },
      ],
    })
    expect(shapeOf(s, 'clones1_2_pocket1')).toMatchObject({ mirror: true, anchor: { u: 'max' } })
    expect(exact(shapeOf(s, 'clones1_2_pocket1')['rotation'])).toBe(-30)
    expect(shapeOf(s, 'clones1_3_pocket1')).toMatchObject({ mirror: true, anchor: { u: 'min' } })
    expect(exact(shapeOf(s, 'clones1_3_pocket1')['rotation'])).toBe(150)
    // both flips: a half turn, not mirrored
    expect(shapeOf(s, 'clones1_4_pocket1')).toMatchObject({ anchor: { u: 'max' } })
    expect(shapeOf(s, 'clones1_4_pocket1')['mirror']).toBeUndefined()
    expect(exact(shapeOf(s, 'clones1_4_pocket1')['rotation'])).toBe(210)
    const g = geometry(s)
    const src = outerLoop(g.get('pocket1'))
    // the stock is 100 × 60: the u line at 50, the v line at 40
    expectMirrorImage(src, outerLoop(g.get('clones1_2_pocket1')), 'u', 50)
    expectMirrorImage(src, outerLoop(g.get('clones1_3_pocket1')), 'v', 40)
    expectMirrorImage(
      outerLoop(g.get('clones1_2_pocket1')),
      outerLoop(g.get('clones1_4_pocket1')),
      'v',
      40,
    )
  })

  it('a rotated rectangle turns the other way and swaps its anchor; a circle moves only', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['10', '12'], length: '16', width: '6', rotation: '20' },
      anchor: { u: 'min', v: 'min' },
      depth: '2',
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['30', '12'], diameter: '6' },
      depth: '2',
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'pocket2'] },
      rows: [{ kind: 'mirror', flip: 'v' }],
    })
    expect(shapeOf(s, 'clones1_2_pocket1')).toMatchObject({ anchor: { u: 'min', v: 'max' } })
    expect(exact(shapeOf(s, 'clones1_2_pocket1')['rotation'])).toBe(-20)
    expect(centre(s, 'clones1_2_pocket1')).toEqual([10, 48])
    expect(centre(s, 'clones1_2_pocket2')).toEqual([30, 48])
    const g = geometry(s)
    expectMirrorImage(outerLoop(g.get('pocket1')), outerLoop(g.get('clones1_2_pocket1')), 'v', 30)
  })

  it('an inside profile with tab positions: each tab on the mirror image of its source tab', async () => {
    const s = await setup()
    await withL(s)
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['25', '20'] },
      side: 'inside',
      slotWidth: '3',
      tabs: { width: '3', thickness: '2', positions: ['5', '31'] },
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['profile1'] },
      rows: [
        { kind: 'mirror', flip: 'u' },
        { kind: 'mirror', flip: 'v' },
      ],
    })
    const g = geometry(s)
    const tabPoints = (id: string) => {
      const op = g.get(id)
      if (op?.kind !== 'profile') throw new Error('profile expected')
      const { chain } = profileChain(op)
      return op.tabs.positions!.map((t) => expectOk(chainPointAt(chain, t, true)).point)
    }
    const src = tabPoints('profile1')
    const flips: [string, (p: readonly number[]) => [number, number]][] = [
      ['clones1_2_profile1', (p) => [100 - p[0]!, p[1]!]],
      ['clones1_3_profile1', (p) => [p[0]!, 60 - p[1]!]],
      ['clones1_4_profile1', (p) => [100 - p[0]!, 60 - p[1]!]],
    ]
    for (const [id, f] of flips)
      tabPoints(id).forEach((q, i) => {
        const want = f(src[i]!)
        expect(Math.hypot(q[0] - want[0], q[1] - want[1]), id).toBeLessThan(0.002)
      })
  })
})

describe('numbering, on-line copies and limits', () => {
  it('quadrants (8 → 16) keep their ids after a skip', async () => {
    const s = await setup()
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['10', '10'],
      diameter: '3',
    })
    const rows = (skip?: number[]) => [
      { kind: 'offset', count: 3, du: '8', dv: '0', ...(skip ? { skip } : {}) },
      { kind: 'mirror', flip: 'u' },
      { kind: 'mirror', flip: 'v' },
    ]
    const out = (await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: rows(),
    })) as { operationIds: string[] }
    expect(out.operationIds).toHaveLength(15)
    expect(centre(s, 'clones1_16_drill1')).toEqual([100 - 34, 60 - 10])
    await s.run('design.clones.update', { partId: s.partId, featureId: 'clones1', rows: rows([1]) })
    // 3 skipped, and its mirrors 7, 11 and 15
    const numbers = ids(s)
      .filter((id) => id.startsWith('clones1_'))
      .map((id) => Number(id.split('_')[1]))
    expect(numbers).toEqual([2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16])
    expect(centre(s, 'clones1_16_drill1')).toEqual([100 - 34, 60 - 10])
  })

  it('a hole on the line is dropped silently; an asymmetric shape on it is mirrored', async () => {
    const s = await setup()
    await withL(s)
    await s.run('design.drilling.add', { partId: s.partId, center: ['50', '10'], diameter: '3' })
    const r = (await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [
        { kind: 'offset', count: 1, du: '0', dv: '20' },
        { kind: 'mirror', flip: 'u' },
      ],
    })) as { operationIds: string[]; warnings: { code: string }[] }
    expect(r.operationIds).toEqual(['clones1_2_drill1'])
    expect(r.warnings.map((w) => w.code)).not.toContain('dfm.cloneDuplicate')
    expect(preview(s, 'clones1')).toMatchObject({ onLine: [3, 4] })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '45'] },
      depth: '2',
    })
    const named = (await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1'] },
      rows: [{ kind: 'mirror', flip: 'u' }],
    })) as { operationIds: string[]; warnings: { code: string; params?: object }[] }
    expect(named.operationIds).toEqual(['clones2_2_pocket1'])
    expect(named.warnings).toContainEqual(
      expect.objectContaining({ code: 'dfm.cloneOverlap', operation: 'clones2' }),
    )
  })

  it('1 + 49 clones then a mirror is the most', async () => {
    const s = await setup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['2', '2'], diameter: '0.5' })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [
        { kind: 'grid', cols: 10, rows: 5, du: '0.8', dv: '0.8' },
        { kind: 'mirror', flip: 'u' },
      ],
    })
    expect(ids(s).filter((id) => id.startsWith('clones1_'))).toHaveLength(99)
    const e = await s.fail(
      'design.clones.update',
      {
        partId: s.partId,
        featureId: 'clones1',
        rows: [
          { kind: 'grid', cols: 10, rows: 5, du: '0.8', dv: '0.8' },
          { kind: 'offset', count: 1, du: '0', dv: '5' },
          { kind: 'mirror', flip: 'u' },
        ],
      },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'clonesLimit' })
  })
})

describe('the reference', () => {
  /** A Ø 4 hole at (20, 30) (drill1) and a Ø 6 reference hole at (60, 30) (drill2). */
  async function holes() {
    const s = await setup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['20', '30'], diameter: '4' })
    await s.run('design.drilling.add', { partId: s.partId, center: ['60', '30'], diameter: '6' })
    return s
  }

  it('follows the referenced operation (one undo step) and refuses its removal', async () => {
    const s = await holes()
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [{ kind: 'mirror', flip: 'u', about: 'drill2' }],
    })
    expect(centre(s, 'clones1_2_drill1')).toEqual([100, 30])
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill2',
      center: ['55', '30'],
    })
    expect(centre(s, 'clones1_2_drill1')).toEqual([90, 30])
    await s.undo()
    expect(centre(s, 'clones1_2_drill1')).toEqual([100, 30])
    expect(centre(s, 'drill2')).toEqual([60, 30])
    const e = await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'drill2' },
      'model.invariant',
    )
    expect(e.message).toContain("change Clones 1's mirror row (row 1) first")
    // `at`, then the reference can go
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'mirror', flip: 'u', at: '30' }],
    })
    expect(centre(s, 'clones1_2_drill1')).toEqual([40, 30])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'drill2' })
  })

  it('a feature reference: a Clones span is its whole footprint', async () => {
    const s = await holes()
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill2'] },
      rows: [{ kind: 'offset', count: 1, du: '0', dv: '-20' }],
    })
    // clones1 spans (60, 10) to (60, 30): its centre is (60, 20)
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [{ kind: 'mirror', flip: 'v', about: 'clones1' }],
    })
    expect(centre(s, 'clones2_2_drill1')).toEqual([20, 10])
  })

  it('takes a reference after the Clones; refuses its own clone, an unknown one, about with at', async () => {
    const s = await holes()
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [{ kind: 'offset', count: 1, du: '5', dv: '0' }],
    })
    await s.run('design.drilling.add', { partId: s.partId, center: ['60', '45'], diameter: '2' })
    const refused = async (
      row: object,
      rule: string,
      code: 'model.invariant' | 'input.malformed' = 'model.invariant',
    ) => {
      const e = await s.fail(
        'design.clones.update',
        { partId: s.partId, featureId: 'clones1', rows: [row] },
        code,
      )
      expect(e.issues[0], JSON.stringify(e.issues)).toMatchObject({ rule })
      return e
    }
    // drill3 comes after the Clones in design order: read as a value, followed as any reference
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'mirror', flip: 'v', about: 'drill3' }],
    })
    expect(centre(s, 'clones1_2_drill1')).toEqual([20, 60])
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'drill3',
      center: ['60', '40'],
    })
    expect(centre(s, 'clones1_2_drill1')).toEqual([20, 50])
    const own = await refused(
      { kind: 'mirror', flip: 'u', about: 'clones1_2_drill1' },
      'clonesMirrorRef',
    )
    expect(own.issues[0]!.message).toContain('one of its own clones')
    await refused({ kind: 'mirror', flip: 'u', about: 'nothing1' }, 'clonesMirrorRef')
    await refused(
      { kind: 'mirror', flip: 'u', about: 'drill2', at: '3' },
      'oneOf',
      'input.malformed',
    )
    const e = await s.fail(
      'design.clones.update',
      {
        partId: s.partId,
        featureId: 'clones1',
        rows: [
          { kind: 'mirror', flip: 'u' },
          { kind: 'offset', count: 1, du: '5', dv: '0' },
        ],
      },
      'model.invariant',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'clonesMirrorLast', path: ['rows', 1, 'kind'] })
    expect(e.issues[0]!.message).toContain('move the mirror rows to the end')
  })
})

describe('groups, Clones of Clones, split pieces, preview and persistence', () => {
  it('a group: the drilling on the pocket floor lands on the mirrored pocket floor', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['20', '20'], diameter: '10' },
      depth: '3',
    })
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      center: ['22', '20'],
      diameter: '3',
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'drill1'] },
      rows: [{ kind: 'mirror', flip: 'u' }],
    })
    expect(centre(s, 'clones1_2_pocket1')).toEqual([80, 20])
    expect(centre(s, 'clones1_2_drill1')).toEqual([78, 20])
    expect(s.op('clones1_2_drill1')).toMatchObject({ on: 'clones1_2_pocket1.floor' })
    const p = preview(s, 'clones1') as {
      instances: { n: number; mirrored?: object }[]
      rows: { mirror?: object }[]
    }
    expect(p.instances).toEqual([
      expect.objectContaining({ n: 1 }),
      expect.objectContaining({ n: 2, mirrored: { u: true } }),
    ])
    expect(p.rows[0]).toMatchObject({ mirror: { flip: 'u', c: 50 } })
    // persistence: the stored row round-trips
    expect(s.part().features?.[0]).toMatchObject({ rows: [{ kind: 'mirror', flip: 'u' }] })
    expect(expectOk(loadProjectFiles(expectOk(docToFiles(s.d.doc))))).toEqual(s.d.doc)
  })

  it('Clones of Clones: an outer mirror mirrors the inner instances; an inner one is repeated', async () => {
    const s = await setup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['10', '10'], diameter: '3' })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['drill1'] },
      rows: [{ kind: 'offset', count: 2, du: '10', dv: '0' }],
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureIds: ['clones1'] },
      rows: [{ kind: 'mirror', flip: 'v' }],
    })
    expect(centre(s, 'clones2_2_clones1_3_drill1')).toEqual([30, 50])
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [
        { kind: 'offset', count: 1, du: '10', dv: '0' },
        { kind: 'mirror', flip: 'u' },
      ],
    })
    expect(centre(s, 'clones1_4_drill1')).toEqual([80, 10])
    expect(centre(s, 'clones2_2_clones1_4_drill1')).toEqual([80, 50])
  })

  it('a split piece takes a mirrored named instance as any operation', async () => {
    const s = await setup()
    await withL(s)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['20', '30'] },
      depth: '2',
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1'] },
      rows: [{ kind: 'mirror', flip: 'u' }],
    })
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '50' }] },
    })
    const pieces = Object.values(s.d.doc.parts)
      .filter((p) => p.derivedFrom?.partId === s.partId)
      .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
    expect(pieces).toHaveLength(2)
    const inPiece = pieces[1]!.operations.find((o) => o.id === 'clones1_2_pocket1')
    expect(inPiece).toMatchObject({ shape: { kind: 'named', mirror: true } })
    // the piece's pocket is the whole part's mirrored pocket moved by the piece's offset
    const whole = outerLoop(geometry(s).get('clones1_2_pocket1'))
    const piece = outerLoop(
      expectOk(partGeometryInput(s.d.doc, pieces[1]!.id, region2d)).operations.find(
        (o) => o.id === 'clones1_2_pocket1',
      ),
    )
    const d = [
      piece.elements[0]!.a[0] - whole.elements[0]!.a[0],
      piece.elements[0]!.a[1] - whole.elements[0]!.a[1],
    ]
    expect(piece.elements).toHaveLength(whole.elements.length)
    piece.elements.forEach((e, i) => {
      expect(e.a[0] - whole.elements[i]!.a[0]).toBeCloseTo(d[0]!, 6)
      expect(e.a[1] - whole.elements[i]!.a[1]).toBeCloseTo(d[1]!, 6)
    })
  })
})
