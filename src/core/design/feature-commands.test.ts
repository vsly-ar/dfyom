// The feature model (v0.4 F1) end to end with the test-only `probe` kind (feature.fixture.ts):
// owned operations, ids by role, refusals, remove / move / list, pending keys, undo, persistence
// and the consistency check. Spec: docs/modes/features.md#expansion-and-owned-operations,
// docs/modes/design-v0.4.md#implementation-f1
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { pendingChanges } from '../commands/apply'
import { createDispatcher } from '../commands/dispatcher'
import { inProcessWorkers } from '../commands/jobs'
import { createAppRegistry } from '../commands/registry'
import { fakeClock, fakeIds, uiSource } from '../commands/testing'
import { docToFiles, loadProjectFiles } from '../project/layout'
import type { ProjectDoc } from '../project/document'
import { designSetup, type DesignSetup } from './design.fixture'
import {
  designUnits,
  instanceOf,
  materialize,
  registerFeatureKind,
  stepOf,
  type FeatureBase,
} from './feature'
import { PROBE_COMMANDS, probeSpec } from './feature.fixture'
import { loadPart } from './load'
import type { PartDTO } from './part.dto'

const probeArgs = (extra: object = {}) => ({
  center: ['30', '30'],
  diameter: '10',
  depth: '3',
  drillDiameter: '5',
  ...extra,
})

async function setup(): Promise<DesignSetup> {
  return designSetup({ commands: PROBE_COMMANDS })
}

const ids = (s: DesignSetup) => s.part().operations.map((o) => o.id)

/** A facing, a probe on its floor and a later pocket. */
async function withProbe(s: DesignSetup) {
  await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
  const out = (await s.run('design.probe.add', { partId: s.partId, ...probeArgs() })) as {
    featureId: string
    operationIds: string[]
  }
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['70', '30'], length: '20', width: '10' },
    depth: '2',
  })
  return out
}

describe('feature add / update (the expansion in the command)', () => {
  it('stores owned operations with ids and default names by role, contiguous after the add', async () => {
    const s = await setup()
    const out = await withProbe(s)
    expect(out).toMatchObject({
      featureId: 'probe1',
      operationIds: ['probe1_pocket', 'probe1_drill'],
    })
    expect(ids(s)).toEqual(['facing1', 'probe1_pocket', 'probe1_drill', 'pocket1'])
    expect(s.op('probe1_pocket')).toMatchObject({
      name: 'Probe 1 · pocket',
      featureId: 'probe1',
      featureRole: 'pocket',
      on: 'facing1.floor',
    })
    expect(s.op('probe1_drill')).toMatchObject({
      kind: 'drilling',
      on: 'probe1_pocket.floor',
      featureId: 'probe1',
      featureRole: 'drill',
    })
    expect(s.part().features).toEqual([
      expect.objectContaining({
        id: 'probe1',
        kind: 'probe',
        name: 'Probe 1',
        on: 'facing1.floor',
      }),
    ])
  })

  it('update regenerates by role in one undo step; kept fields survive; a role can disappear', async () => {
    const s = await setup()
    await withProbe(s)
    // the owned operation's own fields: tool field, name and tolerance (A4)
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'probe1_drill',
      tool: { kind: 'generalized', type: 'drill', diameter: '5' },
    })
    await s.run('design.drilling.update', {
      partId: s.partId,
      operationId: 'probe1_drill',
      name: 'Pilot',
      generalTolerance: { length: '0.1' },
    })
    const before = s.d.doc
    await s.run('design.probe.update', {
      partId: s.partId,
      featureId: 'probe1',
      name: 'Probe A',
      depth: '4',
      drillDiameter: '4',
    })
    expect(s.op('probe1_drill')).toMatchObject({
      name: 'Pilot',
      toolLocked: true,
      tool: { kind: 'generalized', type: 'drill' },
      generalTolerance: { length: { source: '0.1' } },
      diameter: { source: '4' },
    })
    // a default name follows the renamed feature
    expect(s.op('probe1_pocket')).toMatchObject({
      name: 'Probe A · pocket',
      depth: { source: '4' },
    })
    await s.undo()
    expect(s.d.doc).toEqual(before)
    await s.redo()
    await s.run('design.probe.update', { partId: s.partId, featureId: 'probe1', drill: false })
    expect(ids(s)).toEqual(['facing1', 'probe1_pocket', 'pocket1'])
    await s.run('design.probe.update', { partId: s.partId, featureId: 'probe1', drill: true })
    expect(ids(s)).toEqual(['facing1', 'probe1_pocket', 'probe1_drill', 'pocket1'])
  })

  it('feature invariants and parse errors are model.invariant at the feature field', async () => {
    const s = await setup()
    const e = await s.fail(
      'design.probe.add',
      { partId: s.partId, ...probeArgs({ drillDiameter: '12' }) },
      'model.invariant',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['drillDiameter', 'drillInside'],
    ])
    const q = await s.fail(
      'design.probe.add',
      { partId: s.partId, ...probeArgs({ depth: 'banana' }) },
      'expression.reference',
    )
    expect(q.issues[0]?.path).toEqual(['depth'])
    expect(s.part().operations).toEqual([])
    expect(s.part().features).toBeUndefined()
  })

  it('update of another kind or an unknown feature is input.malformed', async () => {
    const s = await setup()
    await withProbe(s)
    const e = await s.fail(
      'design.probe.update',
      { partId: s.partId, featureId: 'probe9', depth: '1' },
      'input.malformed',
    )
    expect(e.issues[0]?.rule).toBe('unknownFeature')
  })
})

describe('design.featureOwned refusals (A4, A5)', () => {
  it('geometry, remove and move of an owned operation go through its feature', async () => {
    const s = await setup()
    await withProbe(s)
    const before = s.d.doc
    const owned = { partId: s.partId, operationId: 'probe1_pocket' }
    const e = await s.fail('design.pocket.update', { ...owned, depth: '5' }, 'design.featureOwned')
    expect(e.frames[0]?.data).toMatchObject({ featureId: 'probe1', operationId: 'probe1_pocket' })
    expect(e.issues[0]).toMatchObject({ rule: 'featureOwned', message: 'edited through Probe 1' })
    await s.fail('design.operation.remove', owned, 'design.featureOwned')
    await s.fail('design.operation.move', { ...owned, toIndex: 0 }, 'design.featureOwned')
    expect(s.d.doc).toBe(before)
  })

  it('a plain operation cannot move into a block', async () => {
    const s = await setup()
    await withProbe(s)
    const e = await s.fail(
      'design.operation.move',
      { partId: s.partId, operationId: 'pocket1', toIndex: 2 },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ rule: 'insideFeature', params: { featureId: 'probe1' } })
    // before or after the block is fine
    await s.run('design.operation.move', { partId: s.partId, operationId: 'pocket1', toIndex: 1 })
    expect(ids(s)).toEqual(['facing1', 'pocket1', 'probe1_pocket', 'probe1_drill'])
  })
})

describe('design.feature.remove / move / list', () => {
  it('remove takes the owned operations along; undo restores both', async () => {
    const s = await setup()
    await withProbe(s)
    const before = s.d.doc
    const out = await s.run('design.feature.remove', { partId: s.partId, featureId: 'probe1' })
    expect(out).toMatchObject({
      featureId: 'probe1',
      operationIds: ['probe1_pocket', 'probe1_drill'],
    })
    expect(ids(s)).toEqual(['facing1', 'pocket1'])
    expect(s.part().features).toBeUndefined()
    await s.undo()
    expect(s.d.doc).toEqual(before)
    await s.redo()
    expect(ids(s)).toEqual(['facing1', 'pocket1'])
  })

  it('remove fails with design.referenced while a later operation uses an owned surface', async () => {
    const s = await setup()
    await withProbe(s)
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'probe1_pocket.floor',
      center: ['33', '30'],
      diameter: '2',
    })
    const e = await s.fail(
      'design.feature.remove',
      { partId: s.partId, featureId: 'probe1' },
      'design.referenced',
    )
    expect(e.frames[0]?.data).toMatchObject({ dependants: ['drill1'] })
  })

  it('move moves the block as one; references and positions are checked', async () => {
    const s = await setup()
    await withProbe(s)
    await s.run('design.feature.move', { partId: s.partId, featureId: 'probe1', toIndex: 2 })
    expect(ids(s)).toEqual(['facing1', 'pocket1', 'probe1_pocket', 'probe1_drill'])
    // before the facing whose floor it starts from
    await s.fail(
      'design.feature.move',
      { partId: s.partId, featureId: 'probe1', toIndex: 0 },
      'design.referenced',
    )
    const past = await s.fail(
      'design.feature.move',
      { partId: s.partId, featureId: 'probe1', toIndex: 3 },
      'input.malformed',
    )
    expect(past.issues[0]).toMatchObject({ rule: 'range', params: { max: 2 } })
    await s.undo()
    expect(ids(s)).toEqual(['facing1', 'probe1_pocket', 'probe1_drill', 'pocket1'])
  })

  it('move refuses a position inside another feature', async () => {
    const s = await setup()
    await withProbe(s)
    await s.run('design.probe.add', { partId: s.partId, ...probeArgs({ center: ['30', '15'] }) })
    // facing1, probe1_pocket, probe1_drill, pocket1, probe2_pocket, probe2_drill
    const e = await s.fail(
      'design.feature.move',
      { partId: s.partId, featureId: 'probe2', toIndex: 2 },
      'input.malformed',
    )
    expect(e.issues[0]?.rule).toBe('insideFeature')
    await s.run('design.feature.move', { partId: s.partId, featureId: 'probe2', toIndex: 1 })
    expect(ids(s)).toEqual([
      'facing1',
      'probe2_pocket',
      'probe2_drill',
      'probe1_pocket',
      'probe1_drill',
      'pocket1',
    ])
  })

  it('list returns features in design order with their operations; featureId is the get', async () => {
    const s = await setup()
    await withProbe(s)
    await s.run('design.probe.add', { partId: s.partId, ...probeArgs({ center: ['30', '15'] }) })
    await s.run('design.feature.move', { partId: s.partId, featureId: 'probe2', toIndex: 1 })
    const list = expectOk(s.d.query('design.feature.list', { partId: s.partId }, uiSource()))
      .value as { features: { feature: { id: string }; index: number; operationIds: string[] }[] }
    expect(list.features.map((f) => [f.feature.id, f.index, f.operationIds])).toEqual([
      ['probe2', 1, ['probe2_pocket', 'probe2_drill']],
      ['probe1', 3, ['probe1_pocket', 'probe1_drill']],
    ])
    const one = expectOk(
      s.d.query('design.feature.list', { partId: s.partId, featureId: 'probe1' }, uiSource()),
    ).value as { features: { feature: { id: string; kind: string } }[] }
    expect(one.features.map((f) => f.feature)).toEqual([
      expect.objectContaining({ id: 'probe1', kind: 'probe', drillDiameter: expect.anything() }),
    ])
    expectErrCode(
      s.d.query('design.feature.list', { partId: s.partId, featureId: 'probe7' }, uiSource()),
      'input.malformed',
    )
  })
})

describe('pending keys and Apply (features.md § Apply and pending changes)', () => {
  it('a feature field counts 1 however many owned operations change; add, move, remove 1 each', async () => {
    const s = await setup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('project.apply', {})
    let base = s.d.doc
    const keys = () =>
      pendingChanges(s.d.doc, base).map((c) => [c.featureId ?? c.operationId, c.field, c.label])
    await s.run('design.probe.add', { partId: s.partId, ...probeArgs() })
    expect(keys()).toEqual([['probe1', 'added', 'Probe 1 added']])
    // the auto tool choice targets the new owned operations
    const applied = (await s.run('project.apply', {})) as {
      changes: number
      toolChanges: unknown[]
    }
    expect(applied.changes).toBe(1)
    expect(applied.toolChanges).toHaveLength(2)
    base = s.d.doc
    await s.run('design.probe.update', {
      partId: s.partId,
      featureId: 'probe1',
      center: ['40', '30'],
      depth: '4',
    })
    expect(keys()).toEqual([
      ['probe1', 'center', 'Probe 1: center'],
      ['probe1', 'depth', 'Probe 1: depth'],
    ])
    await s.run('project.apply', {})
    base = s.d.doc
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['80', '30'], diameter: '6' },
      depth: '1',
    })
    await s.run('project.apply', {})
    base = s.d.doc
    await s.run('design.feature.move', { partId: s.partId, featureId: 'probe1', toIndex: 2 })
    expect(keys()).toEqual([['probe1', 'moved', 'Probe 1 moved']])
    await s.run('project.apply', {})
    base = s.d.doc
    // the owned operation's own tool field keeps its per-operation key
    await s.run('design.operation.tool.unlock', { partId: s.partId, operationId: 'probe1_drill' })
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'probe1_drill',
      tool: { kind: 'generalized', type: 'drill', diameter: '3' },
    })
    expect(keys().map((k) => k[0])).toEqual(['probe1_drill', 'probe1_drill'])
    await s.run('project.apply', {})
    base = s.d.doc
    await s.run('design.feature.remove', { partId: s.partId, featureId: 'probe1' })
    expect(keys()).toEqual([['probe1', 'removed', 'Probe 1 removed']])
  })

  it('owned operations recalculated from an earlier edit count once for their feature', async () => {
    const s = await setup()
    await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
    await s.run('design.probe.add', {
      partId: s.partId,
      ...probeArgs({ depth: '2 - facing1.floor.z' }),
    })
    await s.run('project.apply', {})
    const base = s.d.doc
    await s.run('design.facing.update', { partId: s.partId, operationId: 'facing1', depth: '1' })
    const keys = pendingChanges(s.d.doc, base).map((c) => [c.featureId ?? c.operationId, c.field])
    expect(keys).toEqual([
      ['facing1', 'depth'],
      ['probe1', 'operations'],
    ])
  })
})

describe('persistence and the consistency check', () => {
  it('a project with a feature saves and loads unchanged; commands work on the loaded part', async () => {
    const s = await setup()
    await withProbe(s)
    const files = expectOk(docToFiles(s.d.doc))
    const loaded = expectOk(loadProjectFiles(files))
    expect(loaded).toEqual(s.d.doc)
    const d = createDispatcher({
      registry: expectOk(createAppRegistry(PROBE_COMMANDS)),
      doc: loaded,
      ids: fakeIds(),
      clock: fakeClock(),
      services: { workers: inProcessWorkers, library: s.library },
    })
    const r = expectOk(
      await d.dispatch(
        'design.feature.remove',
        { partId: s.partId, featureId: 'probe1' },
        uiSource(),
      ),
    )
    expect(r.value).toMatchObject({ operationIds: ['probe1_pocket', 'probe1_drill'] })
  })

  it('a project without features is byte-identical (no features key, no owner fields)', async () => {
    const s = await setup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '6' },
      depth: '1',
    })
    const json = [...expectOk(docToFiles(s.d.doc)).values()].join('')
    expect(json).not.toContain('feature')
  })

  const corrupt = async (edit: (part: PartDTO) => void) => {
    const s = await setup()
    await withProbe(s)
    const doc = structuredClone(s.d.doc) as ProjectDoc
    edit(doc.parts[s.partId]!)
    const e = expectErrCode(loadPart(doc, s.partId, 'test'), 'input.malformed')
    return e.issues.map((i) => i.rule)
  }

  it('dangling owners, broken blocks, wrong ids and unknown kinds are input.malformed', async () => {
    expect(await corrupt((p) => (p.features = []))).toEqual(['unknownFeature'])
    expect(
      await corrupt((p) => {
        const [o] = p.operations.splice(1, 1)
        p.operations.push(o!)
      }),
    ).toEqual(['featureBlock'])
    expect(
      await corrupt((p) => {
        p.operations[2]!.featureRole = 'pocket2'
      }),
    ).toEqual(['ownedId'])
    expect(
      await corrupt((p) => {
        p.operations.splice(2, 1)
      }),
    ).toEqual(['featureExpansion'])
    expect(
      await corrupt((p) => {
        p.features![0]!.kind = 'gizmo'
      }),
    ).toEqual(['unknownFeatureKind'])
    expect(
      await corrupt((p) => {
        delete p.operations[1]!.featureRole
      }),
    ).toEqual(['featureOwner'])
    expect(
      await corrupt((p) => {
        p.operations.splice(1, 2)
      }),
    ).toEqual(['emptyFeature'])
  })
})

describe('the expansion contract', () => {
  const feature: FeatureBase = { id: 'probe5', kind: 'probe', name: 'Probe 5', on: 'stock.top' }
  const body = { kind: 'facing', on: 'stock.top', depth: undefined } as never

  it('roles: step and instance', () => {
    expect([stepOf('drill'), instanceOf('drill')]).toEqual(['drill', 1])
    expect([stepOf('3_pocket2'), instanceOf('3_pocket2')]).toEqual(['pocket2', 3])
    expect([stepOf('12_hole1_drill'), instanceOf('12_hole1_drill')]).toEqual(['hole1_drill', 12])
  })

  it('materialize keeps step-major order (D34) and refuses broken roles as bugs', () => {
    const ok = expectOk(
      materialize(
        feature,
        ['pocket1', '2_pocket1', '3_pocket1', 'drill1', '2_drill1'].map((role) => ({
          role,
          operation: body,
        })),
        [],
      ),
    )
    expect(ok.map((o) => o.id)).toEqual([
      'probe5_pocket1',
      'probe5_2_pocket1',
      'probe5_3_pocket1',
      'probe5_drill1',
      'probe5_2_drill1',
    ])
    expect(ok[1]!.owner.unwrap()).toEqual({ featureId: 'probe5', role: '2_pocket1' })
    expect(ok[0]!.tool.isNone()).toBe(true)
    const bad = (roles: string[]) =>
      expectErrCode(
        materialize(
          feature,
          roles.map((role) => ({ role, operation: body })),
          [],
        ),
        'internal.unexpected',
      ).message
    expect(bad(['a', '2_b', '2_a'])).toContain('step-major')
    expect(bad(['a', 'a'])).toContain('duplicate')
    expect(bad(['Bad role'])).toContain('invalid role')
    expect(bad([])).toContain('no operations')
  })

  it('design units count a block once', () => {
    expect(
      designUnits([
        { id: 'facing1' },
        { id: 'probe1_pocket', featureId: 'probe1' },
        { id: 'probe1_drill', featureId: 'probe1' },
        { id: 'pocket1' },
      ]),
    ).toEqual([
      { id: 'facing1', feature: false },
      { id: 'probe1', feature: true },
      { id: 'pocket1', feature: false },
    ])
  })

  it('a kind whose name or prefix clashes is refused', () => {
    expect(registerFeatureKind(probeSpec).isOk()).toBe(true) // the same spec again: no clash
    expectErrCode(registerFeatureKind({ ...probeSpec, kind: 'other' }), 'internal.unexpected')
    expectErrCode(
      registerFeatureKind({ ...probeSpec, kind: 'drillish', idPrefix: 'drill' }),
      'internal.unexpected',
    )
  })
})
