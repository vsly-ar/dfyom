// The Clones feature (v0.4 F5) through its commands: expansion with reference mapping, stable
// numbering, the source following, refusals, limits, warnings, preview, pending keys, undo and
// persistence. Sources are plain operations and the F1 test kind `probe`.
// Spec: docs/modes/features.md#clones, docs/modes/design-v0.4.md#implementation-f5
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { pendingChanges } from '../../commands/apply'
import { uiSource } from '../../commands/testing'
import { docToFiles, loadProjectFiles } from '../../project/layout'
import type { ProjectDoc } from '../../project/document'
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
    expect(clone).toEqual([
      expect.objectContaining({
        code: 'dfm.cloneOutsideStock',
        operation: 'clones1',
        params: { count: 1, numbers: [6] },
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
