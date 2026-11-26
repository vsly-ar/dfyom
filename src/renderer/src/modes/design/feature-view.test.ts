// Feature view helpers (v0.4 task U1): units and spans, moves over whole blocks, role names,
// read-outs, the rolled-up count, issue-path mapping and the Make Clones… source rule, on parts
// built through the real commands. Doc: docs/conventions/ui.md#feature-rows-and-add
import { describe, expect, it } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { DfmWarning } from '../../../../core/geometry/model'
import { designDispatcher } from '../../test/bridge'
import { addableFeatures, sourceWith, sourceWithout } from './clones-view'
import {
  clonesSource,
  countsAsWarning,
  cloneInstances,
  featureFieldOf,
  featureReadout,
  operationMoveIndex,
  operationUnits,
  unitOperations,
  rolledUpCount,
  roleLabel,
  unitDropIndex,
  unitMoveIndex,
  warningFeatureField,
  type FeatureUnit,
  type OperationRowUnit,
} from './feature-view'
import { designPart } from './model'

const ui = { kind: 'ui', id: 'test' } as const

async function part(build: (d: Dispatcher, partId: string) => Promise<void>) {
  const d = await designDispatcher()
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: '6061-T6', class: 'aluminum' },
      },
    },
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  const partId = Object.keys(d.doc.parts)[0]!
  await build(d, partId)
  return designPart(d.doc)!
}

const ok = async (d: Dispatcher, name: string, args: object) => {
  ;(await d.dispatch(name, args, ui)).unwrap()
}

const warning = (operation: string, code = 'dfm.x', severity: 'warning' | 'info' = 'warning') =>
  ({ code, severity, message: '', operation, params: {} }) as unknown as DfmWarning

describe('feature view', () => {
  it('DF122: a pocket and its roughing pocket are one unit; moves land as the core moves them', async () => {
    const pocket = {
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '30' },
      depth: '5',
    }
    let dispatcher: Dispatcher | undefined
    let id = ''
    const build = async (d: Dispatcher, partId: string) => {
      dispatcher = d
      id = partId
      await ok(d, 'design.drilling.add', { partId, center: ['10', '10'], diameter: '5' })
      await ok(d, 'design.pocket.add', { partId, ...pocket, roughing: true })
      await ok(d, 'design.drilling.add', { partId, center: ['90', '10'], diameter: '5' })
    }
    const p = await part(build)
    const units = operationUnits(p)
    expect(units.map((u) => u.id)).toEqual(['drill1', 'pocket1', 'drill2'])
    const owner = units[1] as OperationRowUnit
    expect(owner).toMatchObject({ start: 1, end: 3 })
    expect(owner.roughing?.id).toBe('pocket1_roughing')
    expect(unitOperations(owner).map((o) => o.id)).toEqual(['pocket1_roughing', 'pocket1'])
    expect(rolledUpCount(owner, [warning('pocket1_roughing'), warning('pocket1')])).toBe(2)
    // down past drill2, then up to the top: the core's syncRoughing keeps the pair together
    const ids = () => Object.values(dispatcher!.doc.parts)[0]!.operations.map((o) => o.id)
    const move = async (to: number) => {
      const now = operationUnits(designPart(dispatcher!.doc)!)
      const u = now.find((x) => x.id === 'pocket1') as OperationRowUnit
      const at = unitDropIndex(now, 'pocket1', to)!
      await ok(dispatcher!, 'design.operation.move', {
        partId: id,
        operationId: 'pocket1',
        toIndex: operationMoveIndex(u, at),
      })
    }
    await move(2)
    expect(ids()).toEqual(['drill1', 'drill2', 'pocket1_roughing', 'pocket1'])
    await move(0)
    expect(ids()).toEqual(['pocket1_roughing', 'pocket1', 'drill1', 'drill2'])
    await move(1)
    expect(ids()).toEqual(['drill1', 'pocket1_roughing', 'pocket1', 'drill2'])
  })

  it('counts errors and hard warnings, never notes or what Apply may change (ui.md § Severity)', () => {
    // the status bar and the viewport summary count with it: an engraving's
    // dfm.toolNotInLibrary (info) is listed, not counted (engraving e2e)
    expect(countsAsWarning(warning('engraving1_line', 'dfm.toolNotInLibrary', 'info'))).toBe(false)
    expect(countsAsWarning(warning('pocket1', 'dfm.toolUnfit'))).toBe(true)
    const pending = { ...warning('pocket1', 'dfm.toolUnfit'), pendingApply: true } as DfmWarning
    expect(countsAsWarning(pending)).toBe(false)
  })

  it('groups a hole block as one unit and moves units over whole neighbours', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.drilling.add', { partId, center: ['10', '10'], diameter: '5' })
      await ok(d, 'design.hole.add', {
        partId,
        center: ['30', '30'],
        type: 'counterbore',
        fastener: 'M3',
      })
      await ok(d, 'design.drilling.add', { partId, center: ['70', '10'], diameter: '5' })
    })
    const units = operationUnits(p)
    expect(units.map((u) => u.id)).toEqual(['drill1', 'hole1', 'drill2'])
    const hole = units[1] as FeatureUnit
    expect(hole.ops.map((o) => o.featureRole)).toEqual(['counterbore', 'drill'])
    expect([hole.start, hole.end]).toEqual([1, 3])
    // drill1 down steps over the 2-operation block; the hole moves by one plain operation
    expect(unitMoveIndex(units, 'drill1', 1)).toBe(2)
    expect(unitMoveIndex(units, 'drill2', -1)).toBe(1)
    expect(unitMoveIndex(units, 'hole1', -1)).toBe(0)
    expect(unitMoveIndex(units, 'hole1', 1)).toBe(2)
    expect(unitMoveIndex(units, 'drill1', -1)).toBeUndefined()
    // a drop (D45) lands where the same number of steps would
    for (const [i, u] of units.entries())
      for (const by of [-1, 1] as const)
        expect(unitDropIndex(units, u.id, i + by)).toBe(unitMoveIndex(units, u.id, by))
    expect(unitDropIndex(units, 'drill2', 0)).toBe(0)
    expect(unitDropIndex(units, 'drill1', 0)).toBeUndefined()
    // a part that does not load still groups owned blocks from the records
    expect(operationUnits({ ...p, loaded: undefined }).map((u) => u.id)).toEqual(
      units.map((u) => u.id),
    )

    expect(featureReadout(hole.feature)).toBe('M3 · counterbore')
    // H3: a slotted hole adds its travel
    expect(
      featureReadout({
        ...hole.feature,
        type: 'recessedCountersink',
        fastener: 'M5',
        slotLength: { kind: 'length', source: '19.5' },
      } as never),
    ).toBe('M5 · recessed countersink, slot 19.5')
    expect(roleLabel('Hole 1', 'Hole 1 · counterbore')).toBe('counterbore')
    expect(roleLabel('Hole 1', 'Spot face')).toBe('Spot face')
    // F3's issue-path mapping: the counterbore's circle diameter is the hole's cbDiameter
    expect(featureFieldOf(hole.feature, hole.ops[0]!, 'shape.diameter')).toBe('cbDiameter')
    expect(featureFieldOf(hole.feature, hole.ops[1]!, 'center.0')).toBe('center.0')
    expect(
      warningFeatureField(hole.feature, hole.ops[1]!, {
        ...warning('hole1_drill'),
        parameter: 'depth',
      }),
    ).toBe('depth')
  })

  it('rolls up hard findings of the feature and its owned operations only', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.hole.add', {
        partId,
        center: ['30', '30'],
        type: 'counterbore',
        fastener: 'M3',
      })
    })
    const hole = operationUnits(p)[0]!
    const ws = [
      warning('hole1_drill'),
      warning('hole1_counterbore', 'dfm.y'),
      warning('hole1_drill', 'dfm.note', 'info'), // soft: never counted
      warning('hole1'), // a finding on the feature itself
      warning('pocket9'),
    ]
    expect(rolledUpCount(hole, ws)).toBe(3)
  })

  it('a Clones span nests its source; instances come from the path; the source rule', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.facing.add', { partId })
      await ok(d, 'design.pocket.add', {
        partId,
        shape: { kind: 'circle', center: ['20', '30'], diameter: '10' },
        depth: '5',
      })
      await ok(d, 'design.clones.add', {
        partId,
        source: { operationIds: ['pocket1'] },
        rows: [{ kind: 'offset', count: 3, du: '15', dv: '0', skip: [1] }],
      })
    })
    const units = operationUnits(p)
    expect(units.map((u) => u.id)).toEqual(['facing1', 'clones1'])
    const clones = units[1] as FeatureUnit
    expect(clones.nested.map((n) => n.id)).toEqual(['pocket1'])
    expect(clones.ops).toHaveLength(2)
    expect(cloneInstances(p, 'clones1').map((x) => [x.n, x.kind])).toEqual([
      [2, 'clone'],
      [3, 'skipped'],
      [4, 'clone'],
    ])
    expect(featureReadout(clones.feature, 3)).toBe('×3')

    expect(clonesSource(p, null)).toMatchObject({ ok: false })
    expect(clonesSource(p, 'facing1')).toEqual({ ok: false, reason: 'A facing can’t be cloned.' })
    // Clones v2 (DF40, G2/G9): a Clones is a source too; its width spans its instances
    expect(clonesSource(p, 'clones1')).toEqual({
      ok: true,
      source: { featureId: 'clones1' },
      width: 55,
    })
    expect(clonesSource(p, 'pocket1')).toEqual({
      ok: false,
      reason: 'Pocket 1 is already cloned by Clones 1.',
    })
  })

  it('a group holding a Clones nests it with its own source (Clones v2, DF40)', async () => {
    const p = await part(async (d, partId) => {
      await ok(d, 'design.pocket.add', {
        partId,
        shape: { kind: 'circle', center: ['20', '30'], diameter: '12' },
        depth: '2',
      })
      await ok(d, 'design.drilling.add', { partId, center: ['30', '30'], diameter: '3' })
      await ok(d, 'design.clones.add', {
        partId,
        source: { operationIds: ['drill1'] },
        rows: [{ kind: 'arc', radius: '10', angle: '180', arc: '360', step: '120' }],
      })
      await ok(d, 'design.pocket.add', {
        partId,
        shape: { kind: 'circle', center: ['80', '45'], diameter: '6' },
        depth: '1',
      })
      await ok(d, 'design.clones.add', {
        partId,
        source: { featureIds: ['clones1'], operationIds: ['pocket1'] },
        rows: [{ kind: 'offset', count: 1, du: '45', dv: '0' }],
      })
    })
    const units = operationUnits(p)
    expect(units.map((u) => u.id)).toEqual(['clones2', 'pocket2'])
    const outer = units[0] as FeatureUnit
    expect(outer.nested.map((n) => n.id)).toEqual(['pocket1', 'clones1'])
    const inner = outer.nested[1] as FeatureUnit
    expect(inner.nested.map((n) => n.id)).toEqual(['drill1'])
    expect(inner.ops.map((o) => o.id)).toEqual(['clones1_2_drill1', 'clones1_3_drill1'])
    expect(clonesSource(p, 'clones1')).toEqual({
      ok: false,
      reason: 'Clones 1 is already cloned by Clones 2.',
    })
    // removing the inner Clones takes its source; the last member stays
    const source = { featureIds: ['clones1'], operationIds: ['pocket1', 'drill1'] }
    expect(sourceWithout(source, inner)).toEqual({ operationIds: ['pocket1'] })
    expect(sourceWithout({ operationIds: ['pocket1'] }, outer.nested[0]!)).toBeUndefined()
    expect(sourceWith({ operationIds: ['pocket1'] }, 'hole1', true)).toEqual({
      featureIds: ['hole1'],
      operationIds: ['pocket1'],
    })
    expect(addableFeatures(p, outer.feature)).toEqual([])
  })
})
