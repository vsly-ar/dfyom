// The Clones feature (v0.4 F5) through its commands: expansion with reference mapping, stable
// numbering, the source following, refusals, limits, warnings, preview, pending keys, undo and
// persistence; `along` rows on a named shape (F6). Sources are plain operations and the F1 test
// kind `probe`.
// Spec: docs/modes/features.md#clones, docs/modes/design-v0.4.md#implementation-f5
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { pendingChanges } from '../../commands/apply'
import { uiSource } from '../../commands/testing'
import { docToFiles, loadProjectFiles } from '../../project/layout'
import type { ProjectDoc } from '../../project/document'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { designSetup, type DesignSetup } from '../design.fixture'
import { PROBE_COMMANDS } from '../feature.fixture'
import { loadPart } from '../load'
import type { PartDTO } from '../part.dto'
import { CLONES_MAX } from './clones'

const setup = () => designSetup({ commands: PROBE_COMMANDS })
const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}

/** A facing, a Ø10 pocket at (20, 20) with a Ø5 drilling on its floor, and a later pocket. */
async function withSource(s: DesignSetup) {
  await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'circle', center: ['20', '20'], diameter: '10' },
    depth: '3',
  })
  await s.run('design.drilling.add', {
    partId: s.partId,
    on: 'pocket1.floor',
    center: ['20', '20'],
    diameter: '5',
  })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['80', '45'], length: '10', width: '10' },
    depth: '2',
  })
}

const offsetRow = (count: number, du: string, skip?: number[]) => ({
  kind: 'offset',
  count,
  du,
  dv: '0',
  ...(skip === undefined ? {} : { skip }),
})

async function addClones(s: DesignSetup, rows: object[] = [offsetRow(2, '20')]) {
  return (await s.run('design.clones.add', {
    partId: s.partId,
    source: { operationIds: ['pocket1', 'drill1'] },
    rows,
  })) as { featureId: string; operationIds: string[]; warnings: { code: string }[] }
}

describe('design.clones.add', () => {
  it('nests the source and adds step-major instances with mapped references', async () => {
    const s = await setup()
    await withSource(s)
    const out = await addClones(s)
    expect(out.featureId).toBe('clones1')
    expect(out.operationIds).toEqual([
      'clones1_2_pocket1',
      'clones1_3_pocket1',
      'clones1_2_drill1',
      'clones1_3_drill1',
    ])
    // the source stays in place as instance 1; the block right after it
    expect(ids(s)).toEqual(['facing1', 'pocket1', 'drill1', ...out.operationIds, 'pocket2'])
    const p3 = s.op('clones1_3_pocket1') as unknown as {
      shape: { center: unknown[] }
      on: string
      name: string
      featureRole: string
    }
    expect(exact(p3.shape.center[0])).toBe(60)
    expect(exact(p3.shape.center[1])).toBe(20)
    expect(p3).toMatchObject({
      on: 'facing1.floor',
      name: 'Pocket 1 · 3',
      featureRole: '3_pocket1',
    })
    // clone 3's drilling is on clone 3's pocket floor
    expect(s.op('clones1_3_drill1')).toMatchObject({ on: 'clones1_3_pocket1.floor' })
    expect(s.part().features).toEqual([
      expect.objectContaining({
        id: 'clones1',
        kind: 'clones',
        name: 'Clones 1',
        on: 'facing1.floor',
      }),
    ])
    // the source operations are plain operations still
    expect(s.op('pocket1').featureId).toBeUndefined()
  })

  it('gathers a scattered source at its first operation; others keep their order', async () => {
    const s = await setup()
    await withSource(s)
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'pocket2'] },
      rows: [{ kind: 'offset', count: 1, du: '0', dv: '-10' }],
    })
    expect(ids(s)).toEqual([
      'facing1',
      'pocket1',
      'pocket2',
      'clones1_2_pocket1',
      'clones1_2_pocket2',
      'drill1',
    ])
  })

  it('numbers stay stable when positions are skipped (D30)', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s, [offsetRow(3, '20', [1])])
    expect(ids(s).filter((id) => id.startsWith('clones1'))).toEqual([
      'clones1_2_pocket1',
      'clones1_4_pocket1',
      'clones1_2_drill1',
      'clones1_4_drill1',
    ])
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [offsetRow(3, '20')],
    })
    expect(ids(s).filter((id) => id.startsWith('clones1_3'))).toEqual([
      'clones1_3_pocket1',
      'clones1_3_drill1',
    ])
  })

  it('takes a feature as source: roles name its operations', async () => {
    const s = await setup()
    await s.run('design.probe.add', {
      partId: s.partId,
      center: ['20', '20'],
      diameter: '10',
      depth: '3',
      drillDiameter: '5',
    })
    const out = (await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureId: 'probe1' },
      rows: [{ kind: 'grid', cols: 2, rows: 2, du: '25', dv: '15' }],
    })) as { operationIds: string[] }
    expect(out.operationIds).toEqual([
      'clones1_2_probe1_pocket',
      'clones1_3_probe1_pocket',
      'clones1_4_probe1_pocket',
      'clones1_2_probe1_drill',
      'clones1_3_probe1_drill',
      'clones1_4_probe1_drill',
    ])
    expect(s.op('clones1_4_probe1_drill')).toMatchObject({ on: 'clones1_4_probe1_pocket.floor' })
    // the source feature is nested: it moves and goes with the Clones
    await s.fail(
      'design.feature.move',
      { partId: s.partId, featureId: 'probe1', toIndex: 0 },
      'design.featureOwned',
    )
    await s.fail(
      'design.feature.remove',
      { partId: s.partId, featureId: 'probe1' },
      'design.featureOwned',
    )
    // Clones of Clones are refused
    const e = await s.fail(
      'design.clones.add',
      { partId: s.partId, source: { featureId: 'clones1' }, rows: [offsetRow(1, '5')] },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toContain('clonesNested')
    // with the next step: a row on that Clones, or its source in a new one (X2 F4)
    expect(e.issues.find((i) => i.rule === 'clonesNested')?.message).toMatch(
      /add a row to clones1, or clone its source \((featureId|operationIds) [^)]+\) in a new Clones/,
    )
  })

  it('refuses facings, outside profiles, taken, owned and two-face sources', async () => {
    const s = await setup()
    await withSource(s)
    const rule = async (source: object) =>
      (
        await s.fail(
          'design.clones.add',
          { partId: s.partId, source, rows: [offsetRow(1, '5')] },
          'model.invariant',
        )
      ).issues.map((i) => i.rule)
    expect(await rule({ operationIds: ['facing1'] })).toEqual(['clonesSourceKind'])
    expect(await rule({ operationIds: ['pocket1', 'pocket9'] })).toEqual(['unknownOperation'])
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'stock.top',
      center: ['50', '50'],
      diameter: '3',
    })
    expect(await rule({ operationIds: ['pocket2', 'drill2'] })).toEqual(['clonesSourceFace'])
    await addClones(s)
    expect(await rule({ operationIds: ['pocket1'] })).toEqual(['clonesSourceTaken'])
    expect(await rule({ operationIds: ['clones1_2_pocket1'] })).toEqual(['clonesSourceOwned'])
  })

  it('limits: 100 instances per Clones feature, rows checked', async () => {
    const s = await setup()
    await withSource(s)
    const e = await s.fail(
      'design.clones.add',
      {
        partId: s.partId,
        source: { operationIds: ['pocket2'] },
        rows: [
          { kind: 'grid', cols: 10, rows: 10, du: '0.5', dv: '0.5' },
          { kind: 'offset', count: 10, du: '0', dv: '0.5' },
        ],
      },
      'model.invariant',
    )
    expect(e.issues).toEqual([
      expect.objectContaining({ rule: 'clonesLimit', params: { max: CLONES_MAX, actual: 110 } }),
    ])
    const bad = await s.fail(
      'design.clones.add',
      {
        partId: s.partId,
        source: { operationIds: ['pocket2'] },
        rows: [{ kind: 'arc', radius: '10', angle: '0', arc: '90', step: '120' }],
      },
      'model.invariant',
    )
    expect(bad.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['rows.0.step', 'stepInArc'],
    ])
  })

  it('warns once on the feature: outside the stock, duplicates, overlaps', async () => {
    const s = await setup()
    await withSource(s)
    const out = await addClones(s, [offsetRow(5, '20'), offsetRow(1, '-100')])
    const clone = out.warnings.filter((w) => w.code.startsWith('dfm.clone'))
    // footprints (B3): instance 5's Ø10 pocket is centred on the stock's right edge (u = 100)
    expect(clone).toEqual([
      expect.objectContaining({
        code: 'dfm.cloneOutsideStock',
        operation: 'clones1',
        params: { count: 2, numbers: [5, 6] },
      }),
      expect.objectContaining({ code: 'dfm.cloneDuplicate', params: { count: 1, numbers: [7] } }),
    ])
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [offsetRow(1, '5')],
    })
    const list = expectOk(s.d.query('design.warning.list', { partId: s.partId }, uiSource()))
      .value as { warnings: { code: string; params: object }[] }
    expect(list.warnings.filter((w) => w.code === 'dfm.cloneOverlap')).toEqual([
      expect.objectContaining({ params: { count: 2, numbers: [1, 2] } }),
    ])
  })
})

describe('footprints (B3)', () => {
  const preview = (s: DesignSetup, rows: object[], operationIds = ['pocket1', 'drill1']) =>
    expectOk(
      s.d.query(
        'design.clones.preview',
        { partId: s.partId, source: { operationIds }, rows },
        uiSource(),
      ),
    ).value as { warnings: { code: string; params: { numbers: number[] } }[] }
  const numbers = (
    w: { warnings: { code: string; params: { numbers: number[] } }[] },
    code: string,
  ) => w.warnings.find((x) => x.code === code)?.params.numbers ?? []

  it('outside: a footprint past the edge, though its reference point is inside', async () => {
    const s = await setup()
    await withSource(s)
    // the Ø10 pocket at u = 20 + 77 reaches u = 102 on a 100 mm stock; at + 75 it ends at 100
    expect(numbers(preview(s, [offsetRow(1, '77')]), 'dfm.cloneOutsideStock')).toEqual([2])
    expect(numbers(preview(s, [offsetRow(1, '75')]), 'dfm.cloneOutsideStock')).toEqual([])
  })

  it('outside: a source open to an edge may be repeated along it, not further out', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['0', '20'], diameter: '10' },
      depth: '3',
    })
    const along = { kind: 'offset', count: 2, du: '0', dv: '15' }
    expect(numbers(preview(s, [along], ['pocket1']), 'dfm.cloneOutsideStock')).toEqual([])
    const out = { kind: 'offset', count: 1, du: '-2', dv: '15' }
    expect(numbers(preview(s, [out], ['pocket1']), 'dfm.cloneOutsideStock')).toEqual([2])
  })

  it('overlap: circles by their distance, not their boxes', async () => {
    const s = await setup()
    await withSource(s)
    const diag = (d: string) => [{ kind: 'offset', count: 1, du: d, dv: d }]
    // 7.2 · √2 = 10.18 > Ø10: the boxes overlap, the pockets do not
    expect(numbers(preview(s, diag('7.2')), 'dfm.cloneOverlap')).toEqual([])
    expect(numbers(preview(s, diag('7')), 'dfm.cloneOverlap')).toEqual([1, 2])
  })

  it('overlap: a turned shape is intersected in the 2D layer', async () => {
    const s = await designSetup({ services: { region2d: nodeRegion2d() } })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '20',
        width: '2',
        cornerRadius: '0',
        rotation: '45',
      },
      depth: '2',
    })
    const row = (du: string, dv: string) => [{ kind: 'offset', count: 1, du, dv }]
    // across the strip (4.24 mm apart, 2 wide): no overlap; along it: overlap
    expect(numbers(preview(s, row('-3', '3'), ['pocket1']), 'dfm.cloneOverlap')).toEqual([])
    expect(numbers(preview(s, row('3', '3'), ['pocket1']), 'dfm.cloneOverlap')).toEqual([1, 2])
  })
})

describe('the source follows (design.clonesFollow)', () => {
  it('a source edit re-runs the expansion in the same command; one undo restores all', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    const before = s.d.doc
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      depth: '4',
      shape: { kind: 'circle', center: ['25', '20'], diameter: '10' },
    })
    expect(exact((s.op('clones1_3_pocket1') as unknown as { depth: unknown }).depth)).toBe(4)
    const c = (s.op('clones1_3_pocket1') as unknown as { shape: { center: unknown[] } }).shape
    expect(exact(c.center[0])).toBe(65)
    await s.undo()
    expect(s.d.doc).toEqual(before)
  })

  it('a row formula recalculates when what it reads changes (reevaluate, F3 sync)', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s, [{ kind: 'offset', count: 1, du: 'facing1.floor.z + 20.5', dv: '0' }])
    const u = () =>
      exact(
        (s.op('clones1_2_pocket1') as unknown as { shape: { center: unknown[] } }).shape.center[0],
      )
    expect(u()).toBe(40)
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '1' })
    expect(u()).toBe(39.5)
  })

  it('a source formula is copied as its value; the instance follows when it recalculates', async () => {
    const s = await setup()
    await withSource(s)
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      depth: 'facing1.floor.z + 17',
    })
    await addClones(s)
    const depth = (s.op('clones1_2_pocket1') as unknown as { depth: { source: string } }).depth
    expect(depth.source).toBe('16.5')
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '1' })
    expect(exact((s.op('clones1_2_pocket1') as unknown as { depth: unknown }).depth)).toBe(
      exact((s.op('pocket1') as unknown as { depth: unknown }).depth),
    )
  })

  it("instances take the source's tool and are read-only", async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'drill1',
      tool: { kind: 'generalized', type: 'drill', diameter: '5' },
    })
    expect(s.op('clones1_3_drill1')).toMatchObject({
      toolLocked: true,
      tool: { kind: 'generalized', type: 'drill' },
    })
    await s.fail(
      'design.operation.tool.unlock',
      { partId: s.partId, operationId: 'clones1_3_drill1' },
      'design.featureOwned',
    )
    await s.fail(
      'design.drilling.update',
      { partId: s.partId, operationId: 'clones1_3_drill1', name: 'X' },
      'design.featureOwned',
    )
  })

  it('a source edit that removes a referenced instance fails the command', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'clones1_3_pocket1.floor',
      center: ['60', '22'],
      diameter: '2',
    })
    await s.fail(
      'design.clones.update',
      { partId: s.partId, featureId: 'clones1', rows: [offsetRow(2, '20', [1])] },
      'design.referenced',
    )
  })
})

describe('order, removal and refusals', () => {
  it('the source cannot be removed or moved alone; nothing moves into the span', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'drill1' },
      'design.featureOwned',
    )
    await s.fail(
      'design.operation.move',
      { partId: s.partId, operationId: 'pocket1', toIndex: 0 },
      'design.featureOwned',
    )
    const e = await s.fail(
      'design.operation.move',
      { partId: s.partId, operationId: 'pocket2', toIndex: 3 },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'insideFeature', params: { featureId: 'clones1' } })
  })

  it('design.feature.move moves the span; removing Clones keeps the source (C4)', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    await s.run('design.feature.move', { partId: s.partId, featureId: 'clones1', toIndex: 2 })
    expect(ids(s).slice(0, 3)).toEqual(['facing1', 'pocket2', 'pocket1'])
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'clones1' })
    expect(ids(s)).toEqual(['facing1', 'pocket2', 'pocket1', 'drill1'])
    expect(s.part().features).toBeUndefined()
  })

  it('update { source } takes operations out (they stay before) and in', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      source: { operationIds: ['pocket1'] },
    })
    // drill1 sits on pocket1's floor, so it goes right after the span
    expect(ids(s)).toEqual([
      'facing1',
      'pocket1',
      'clones1_2_pocket1',
      'clones1_3_pocket1',
      'drill1',
      'pocket2',
    ])
  })

  it('every position skipped: Clones own nothing, still load, list and move', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s, [offsetRow(2, '20', [0, 1])])
    expect(ids(s)).toEqual(['facing1', 'pocket1', 'drill1', 'pocket2'])
    expect(loadPart(s.d.doc, s.partId, 't').isOk()).toBe(true)
    const list = expectOk(s.d.query('design.feature.list', { partId: s.partId }, uiSource()))
      .value as { features: { index: number; operationIds: string[] }[] }
    expect(list.features).toEqual([expect.objectContaining({ index: 3, operationIds: [] })])
    await s.run('design.feature.move', { partId: s.partId, featureId: 'clones1', toIndex: 2 })
    expect(ids(s)).toEqual(['facing1', 'pocket2', 'pocket1', 'drill1'])
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [offsetRow(2, '20', [0])],
    })
    expect(ids(s)).toEqual([
      'facing1',
      'pocket2',
      'pocket1',
      'drill1',
      'clones1_3_pocket1',
      'clones1_3_drill1',
    ])
  })
})

describe('preview, pending keys, persistence', () => {
  it('design.clones.preview: a draft or a feature, nothing changes', async () => {
    const s = await setup()
    await withSource(s)
    const before = s.d.doc
    const r = expectOk(
      s.d.query(
        'design.clones.preview',
        {
          partId: s.partId,
          source: { operationIds: ['pocket1', 'drill1'] },
          rows: [offsetRow(3, '20', [1])],
        },
        uiSource(),
      ),
    ).value as { on: string; instances: unknown[]; rows: { points: unknown[] }[] }
    expect(r.on).toBe('facing1.floor')
    expect(r.instances).toEqual([
      { n: 1, at: [20, 20] },
      { n: 2, at: [40, 20] },
      { n: 4, at: [80, 20] },
    ])
    expect(r.rows[0]!.points[1]).toEqual({ at: [60, 20], kind: 'skipped', n: 3 })
    // the drawn path (U3): straight through an offset row's positions, no arc centre
    expect(r.rows[0]).toMatchObject({
      path: [
        [20, 20],
        [40, 20],
        [60, 20],
        [80, 20],
      ],
    })
    expect(r.rows[0]).not.toHaveProperty('centre')
    expect(s.d.doc).toBe(before)
  })

  it('a source edit is one pending key, not one per instance', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    const base = s.d.doc
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth: '4' })
    expect(pendingChanges(s.d.doc, base).map((p) => p.label)).toEqual(['Pocket 1: depth'])
  })

  it('saves and loads; a broken span is input.malformed', async () => {
    const s = await setup()
    await withSource(s)
    await addClones(s)
    const loaded = expectOk(loadProjectFiles(expectOk(docToFiles(s.d.doc))))
    expect(loaded).toEqual(s.d.doc)
    const part = s.part()
    const swap: PartDTO = {
      ...part,
      operations: [
        part.operations[0]!,
        part.operations[2]!,
        part.operations[1]!,
        ...part.operations.slice(3),
      ],
    }
    const doc: ProjectDoc = { ...s.d.doc, parts: { [s.partId]: swap } }
    expect(loadPart(doc, s.partId, 't').unwrapErr()).toMatchObject({ code: 'input.malformed' })
  })
})

describe('along rows (F6)', () => {
  const region2d = nodeRegion2d()
  const withShape = async () => {
    const s = await designSetup({ services: { region2d } })
    await withSource(s)
    // an open L from (0, 0): 30 along x, then 20 along y
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          closed: false,
          segments: [
            { kind: 'line', to: ['30', '0'] },
            { kind: 'line', to: ['30', '20'] },
          ],
        },
      ],
    })
    return s
  }
  const at = (s: DesignSetup, id: string) =>
    (s.op(id) as unknown as { shape: { center: unknown[] } }).shape.center.map(exact)

  it('places clones along the shape and follows it when it changes (one undo step)', async () => {
    const s = await withShape()
    const r = await addClones(s, [{ kind: 'along', shapeId: 'shape1', spacing: '25' }])
    // 0: the source itself (no number); 25: (45, 20); 50: the end (50, 40)
    expect(r.operationIds).toEqual([
      'clones1_2_pocket1',
      'clones1_3_pocket1',
      'clones1_2_drill1',
      'clones1_3_drill1',
    ])
    expect(at(s, 'clones1_2_pocket1')).toEqual([45, 20])
    expect(at(s, 'clones1_3_pocket1')).toEqual([50, 40])
    const base = s.d.doc
    await s.run('design.shape.update', {
      partId: s.partId,
      shapeId: 'shape1',
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          closed: false,
          segments: [
            { kind: 'line', to: ['40', '0'] },
            { kind: 'line', to: ['40', '10'] },
          ],
        },
      ],
    })
    expect(at(s, 'clones1_2_pocket1')).toEqual([45, 20])
    expect(at(s, 'clones1_3_pocket1')).toEqual([60, 30])
    // the instances' change folds into the shape's key
    expect(pendingChanges(s.d.doc, base).map((k) => k.shapeId)).toEqual(['shape1'])
    await s.undo()
    expect(at(s, 'clones1_3_pocket1')).toEqual([50, 40])
  })

  it('count spreads evenly from start; the shape cannot be removed while used', async () => {
    const s = await withShape()
    await addClones(s, [{ kind: 'along', shapeId: 'shape1', start: '10', count: 3 }])
    expect(
      ['clones1_2_pocket1', 'clones1_3_pocket1', 'clones1_4_pocket1'].map((id) => at(s, id)),
    ).toEqual([
      [30, 20],
      [50, 20],
      [50, 40],
    ])
    const e = await s.fail(
      'design.shape.remove',
      { partId: s.partId, shapeId: 'shape1' },
      'design.referenced',
    )
    expect(e.issues).toEqual([expect.objectContaining({ path: ['features', 'clones1', 'rows'] })])
    // a shape edit that breaks the row fails the command (design.clonesFollow)
    await s.fail(
      'design.shape.update',
      {
        partId: s.partId,
        shapeId: 'shape1',
        items: [
          { kind: 'rectangle', center: ['0', '0'], length: '10', width: '10' },
          { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '2' },
        ],
      },
      'model.invariant',
    )
  })

  it('refuses unknown and many-item shapes, spacing with count, start off the path', async () => {
    const s = await withShape()
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '10', width: '10' },
        { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '2' },
      ],
    })
    const rules = async (row: object) =>
      (
        await s.fail(
          'design.clones.add',
          { partId: s.partId, source: { operationIds: ['pocket1', 'drill1'] }, rows: [row] },
          'model.invariant',
        )
      ).issues.map((i) => [i.path.join('.'), i.rule])
    expect(await rules({ kind: 'along', shapeId: 'shape9', count: 2 })).toEqual([
      ['rows.0.shapeId', 'unknownShape'],
    ])
    expect(await rules({ kind: 'along', shapeId: 'shape2', count: 2 })).toEqual([
      ['rows.0.shapeId', 'alongOneItem'],
    ])
    expect(await rules({ kind: 'along', shapeId: 'shape1', count: 2, spacing: '5' })).toEqual([
      ['rows.0.spacing', 'alongSpacingOrCount'],
    ])
    expect(await rules({ kind: 'along', shapeId: 'shape1', count: 2, start: '51' })).toEqual([
      ['rows.0.start', 'range'],
    ])
  })

  it('update and preview check source and rows against the full schema', async () => {
    const s = await withShape()
    await addClones(s)
    const bad = await s.fail(
      'design.clones.update',
      { partId: s.partId, featureId: 'clones1', rows: [{ kind: 'along', count: 2 }] },
      'input.malformed',
    )
    expect(bad.issues[0]!.path.slice(0, 2)).toEqual(['rows', 0])
    // the dispatcher validates the full schema, unknown keys inside a row included
    const unknown = await s.fail(
      'design.clones.update',
      {
        partId: s.partId,
        featureId: 'clones1',
        rows: [{ kind: 'along', shapeId: 'shape1', count: 2, spcing: '5' }],
      },
      'input.malformed',
    )
    expect(unknown.issues[0]).toMatchObject({
      path: ['rows', 0, 'spcing'],
      rule: 'unrecognized_keys',
    })
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'along', shapeId: 'shape1', count: 2 }],
    })
    expect(at(s, 'clones1_2_pocket1')).toEqual([50, 40])
    const preview = s.d.query(
      'design.clones.preview',
      { partId: s.partId, source: { operationIds: 'pocket1' }, rows: [] },
      uiSource(),
    )
    expect(preview.unwrapErr()).toMatchObject({ code: 'input.malformed' })
  })
})
