// Clones v2 (hardening DF40): a group source of features and operations, a Clones among them
// (Clones of Clones, two levels), stable ids at both levels, follow on edits (clonesFollow),
// removal and editing rules, the nested limit, pending keys, undo, persistence and program
// comments. Sources are plain operations and the F1 test kind `probe`.
// Spec: docs/modes/features.md#clones-v2-groups-df40
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { pendingChanges } from '../../commands/apply'
import { uiSource } from '../../commands/testing'
import { positionComment } from '../../plan/labels'
import { docToFiles, loadProjectFiles } from '../../project/layout'
import { designSetup, type DesignSetup } from '../design.fixture'
import { PROBE_COMMANDS } from '../feature.fixture'
import { loadPart } from '../load'

const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const exact = (q: unknown) => {
  const e = (q as { exact: { num: string; den: string } }).exact
  return Number(e.num) / Number(e.den)
}
const centre = (s: DesignSetup, id: string) => {
  const op = s.op(id) as unknown as { shape?: { center: unknown[] }; center?: unknown[] }
  return (op.shape?.center ?? op.center)!.map(exact)
}
const diameter = (s: DesignSetup, id: string) =>
  exact((s.op(id) as unknown as { shape: { diameter: unknown } }).shape.diameter)

/**
 * The X2 shape on a test block: a Ø 12 "cutout" pocket at (20, 30), a probe (counterbore and
 * drill) 10 mm right of it and its arc Clones round the cutout (clones1: 3 more probes), then a
 * later pocket outside the group.
 */
async function cutoutWithBoltCircle() {
  const s = await designSetup({ commands: PROBE_COMMANDS })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'circle', center: ['20', '30'], diameter: '12' },
    depth: '2',
  })
  await s.run('design.probe.add', {
    partId: s.partId,
    center: ['30', '30'],
    diameter: '4',
    depth: '1',
    drillDiameter: '2',
  })
  await s.run('design.clones.add', {
    partId: s.partId,
    source: { featureId: 'probe1' },
    rows: [{ kind: 'arc', radius: '10', angle: '180', arc: '360', step: '90' }],
  })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['80', '50'], length: '6', width: '6' },
    depth: '1',
  })
  return s
}

/** The group "cutout + its bolt circle" cloned 45 mm along u (clones2). */
async function cloneGroup(s: DesignSetup) {
  return (await s.run('design.clones.add', {
    partId: s.partId,
    source: { featureIds: ['clones1'], operationIds: ['pocket1'] },
    rows: [{ kind: 'offset', count: 1, du: '45', dv: '0' }],
  })) as { featureId: string; operationIds: string[] }
}

describe('Clones v2: a group source (DF40)', () => {
  it('clones a pocket with a Clones and its source as one unit; the group is stored in full', async () => {
    const s = await cutoutWithBoltCircle()
    const out = await cloneGroup(s)
    expect(out.featureId).toBe('clones2')
    // G1/G2: the member Clones brought its source (probe1); the pocket stays an operation
    expect(s.part().features?.find((f) => f.id === 'clones2')).toMatchObject({
      source: { featureIds: ['clones1', 'probe1'], operationIds: ['pocket1'] },
    })
    // step-major over the group in design order; G3: inner ids kept inside the outer ones
    const inner = [
      'clones1_2_probe1_pocket',
      'clones1_3_probe1_pocket',
      'clones1_4_probe1_pocket',
      'clones1_2_probe1_drill',
      'clones1_3_probe1_drill',
      'clones1_4_probe1_drill',
    ]
    expect(out.operationIds).toEqual(
      ['pocket1', 'probe1_pocket', 'probe1_drill', ...inner].map((id) => `clones2_2_${id}`),
    )
    // the span: the group, the outer block right after it, the later pocket after that
    expect(ids(s)).toEqual([
      'pocket1',
      'probe1_pocket',
      'probe1_drill',
      ...inner,
      ...out.operationIds,
      'pocket2',
    ])
    // moved by the row; references inside the group map to the same instance's copies
    expect(centre(s, 'clones2_2_pocket1')).toEqual([65, 30])
    // inner instance 3 at (10, 30): the arc round the cutout; outer instance 2 is 45 mm right
    expect(centre(s, 'clones1_3_probe1_pocket')).toEqual([10, 30])
    expect(centre(s, 'clones2_2_clones1_3_probe1_pocket')).toEqual([55, 30])
    expect(s.op('clones2_2_clones1_3_probe1_drill')).toMatchObject({
      on: 'clones2_2_clones1_3_probe1_pocket.floor',
    })
    // every outer instance is read-only (D26)
    await s.fail(
      'design.pocket.update',
      { partId: s.partId, operationId: 'clones2_2_clones1_3_probe1_pocket', depth: '3' },
      'design.featureOwned',
    )
    expect(loadPart(s.d.doc, s.partId, 't').isOk()).toBe(true)
    // the preview of a group with other rows
    const preview = expectOk(
      s.d.query(
        'design.clones.preview',
        {
          partId: s.partId,
          featureId: 'clones2',
          rows: [{ kind: 'offset', count: 2, du: '30', dv: '0' }],
        },
        uiSource(),
      ),
    ).value as { instances: { n: number; at: number[] }[] }
    expect(preview.instances.map((i) => i.n)).toEqual([1, 2, 3])
  })

  it('follows member edits in one command: inner first, then outer (G4); one pending key; undo', async () => {
    const s = await cutoutWithBoltCircle()
    await cloneGroup(s)
    const base = s.d.doc
    await s.run('design.probe.update', { partId: s.partId, featureId: 'probe1', diameter: '5' })
    for (const id of [
      'probe1_pocket',
      'clones1_3_probe1_pocket',
      'clones2_2_clones1_3_probe1_pocket',
    ])
      expect(diameter(s, id)).toBe(5)
    expect(pendingChanges(s.d.doc, base).map((p) => p.featureId ?? p.operationId)).toEqual([
      'probe1',
    ])
    await s.undo()
    expect(diameter(s, 'clones2_2_clones1_3_probe1_pocket')).toBe(4)
    // the inner rows: the outer copies the inner's new instances (same command)
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'arc', radius: '10', angle: '180', arc: '360', step: '90', skip: [1] }],
    })
    expect(ids(s)).not.toContain('clones1_3_probe1_pocket')
    expect(ids(s)).not.toContain('clones2_2_clones1_3_probe1_pocket')
    expect(ids(s)).toContain('clones2_2_clones1_4_probe1_pocket')
    expect(loadPart(s.d.doc, s.partId, 't').isOk()).toBe(true)
    // a plain member edit moves its copy too
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: 'pocket1',
      shape: { kind: 'circle', center: ['20', '30'], diameter: '11' },
    })
    expect(diameter(s, 'clones2_2_pocket1')).toBe(11)
  })

  it('keeps members in their group: move, remove and the inner source refused (G5)', async () => {
    const s = await cutoutWithBoltCircle()
    await cloneGroup(s)
    for (const featureId of ['clones1', 'probe1']) {
      const e = await s.fail(
        'design.feature.remove',
        { partId: s.partId, featureId },
        'design.featureOwned',
      )
      expect(e.issues[0]?.rule).toBe('featureNested')
    }
    await s.fail(
      'design.operation.remove',
      { partId: s.partId, operationId: 'pocket1' },
      'design.featureOwned',
    )
    // the inner Clones' source stays within the outer group while it is a member
    const inner = await s.fail(
      'design.clones.update',
      { partId: s.partId, featureId: 'clones1', source: { operationIds: ['pocket2'] } },
      'model.invariant',
    )
    expect(inner.issues.map((i) => i.rule)).toContain('clonesNestedSource')
    // the outer cannot drop the inner Clones but keep its source, nor the other way round
    const half = await s.fail(
      'design.clones.update',
      {
        partId: s.partId,
        featureId: 'clones2',
        source: { featureIds: ['probe1'], operationIds: ['pocket1'] },
      },
      'model.invariant',
    )
    expect(half.issues.map((i) => i.rule)).toContain('clonesSourceTaken')
    // dropping the inner Clones with its source works: the group is the pocket again
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones2',
      source: { operationIds: ['pocket1'] },
    })
    expect(
      s
        .part()
        .operations.filter((o) => o.featureId === 'clones2')
        .map((o) => o.id),
    ).toEqual(['clones2_2_pocket1'])
    expect(loadPart(s.d.doc, s.partId, 't').isOk()).toBe(true)
  })

  it('removing the outer Clones keeps the group, the inner Clones still works (C4)', async () => {
    const s = await cutoutWithBoltCircle()
    await cloneGroup(s)
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'clones2' })
    expect(ids(s).some((id) => id.startsWith('clones2_'))).toBe(false)
    expect(ids(s)).toContain('clones1_4_probe1_drill')
    await s.run('design.probe.update', { partId: s.partId, featureId: 'probe1', diameter: '5' })
    expect(diameter(s, 'clones1_4_probe1_pocket')).toBe(5)
    await s.undo()
    await s.undo()
    expect(ids(s)).toContain('clones2_2_clones1_4_probe1_drill')
  })

  it('saves and loads; program comments name the innermost position (G7)', async () => {
    const s = await cutoutWithBoltCircle()
    await cloneGroup(s)
    expect(expectOk(loadProjectFiles(expectOk(docToFiles(s.d.doc))))).toEqual(s.d.doc)
    const part = s.part()
    expect(positionComment(part, 'probe1_drill')).toBe('Clones 1 #1')
    expect(positionComment(part, 'clones1_3_probe1_drill')).toBe('Clones 1 #3')
    expect(positionComment(part, 'pocket1')).toBe('Clones 2 #1')
    expect(positionComment(part, 'clones2_2_clones1_3_probe1_drill')).toBe('Clones 2 #2')
  })

  it('refuses a Clones in its own source, a third level and over 1000 nested operations', async () => {
    const s = await cutoutWithBoltCircle()
    await cloneGroup(s)
    const self = await s.fail(
      'design.clones.update',
      { partId: s.partId, featureId: 'clones2', source: { featureIds: ['clones2'] } },
      'model.invariant',
    )
    expect(self.issues.map((i) => i.rule)).toContain('clonesNestedSelf')
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'clones2' })
    // 11 probes round the cutout: 25 operations × 99 clones, over the nested limit
    await s.run('design.clones.update', {
      partId: s.partId,
      featureId: 'clones1',
      rows: [{ kind: 'arc', radius: '10', angle: '180', arc: '360', step: '30' }],
    })
    const big = await s.fail(
      'design.clones.add',
      {
        partId: s.partId,
        source: { featureIds: ['clones1'], operationIds: ['pocket1'] },
        rows: [{ kind: 'grid', cols: 10, rows: 10, du: '0.5', dv: '0.5' }],
      },
      'model.invariant',
    )
    expect(big.issues.map((i) => [i.rule, i.params?.['operations']])).toEqual([
      ['clonesLimit', true],
    ])
    // an owned operation of a feature outside the group names the next step
    const owned = await s.fail(
      'design.clones.add',
      {
        partId: s.partId,
        source: { operationIds: ['pocket1', 'probe1_drill'] },
        rows: [{ kind: 'offset', count: 1, du: '45', dv: '0' }],
      },
      'model.invariant',
    )
    expect(owned.issues.find((i) => i.rule === 'clonesSourceOwned')?.message).toMatch(
      /add probe1 to featureIds/,
    )
  })
})

describe('Clones follow a source whose roles change (found with DF40)', () => {
  it('a cloned hole changes type: the instances take the new roles in the same command', async () => {
    const s = await designSetup()
    await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], fastener: 'M3' })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureId: 'hole1' },
      rows: [{ kind: 'offset', count: 1, du: '20', dv: '0' }],
    })
    await s.run('design.hole.update', { partId: s.partId, featureId: 'hole1', type: 'counterbore' })
    expect(ids(s)).toEqual([
      'hole1_counterbore',
      'hole1_drill',
      'clones1_2_hole1_counterbore',
      'clones1_2_hole1_drill',
    ])
    expect(loadPart(s.d.doc, s.partId, 't').isOk()).toBe(true)
    await s.undo()
    expect(ids(s)).toEqual(['hole1_drill', 'clones1_2_hole1_drill'])
  })
})
