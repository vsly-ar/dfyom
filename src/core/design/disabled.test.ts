// Disabling operations and features (hardening DF106): the toggle on design.part.update, what
// follows a disabled item (its chamfer, operations on its floor, a feature's owned operations),
// refusals (owned items, unknown ids, building on a disabled item), pruning, undo, and the
// enabled part that evaluation and DFM read.
// Spec: docs/modes/design.md#disabling-operations-and-features-df106
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import type { DfmWarning } from '../geometry/model'
import { hashJson } from '../plan/snapshot'
import { buildTestPart, designSetup, type DesignSetup } from './design.fixture'
import { disabledState, enabledPart, topLevelUnits } from './disabled'
import { partGeometryInput } from './load'

const ui = uiSource()
const opIds = (s: DesignSetup) =>
  expectOk(partGeometryInput(s.d.doc, s.partId)).operations.map((o) => o.id)
const warnings = (s: DesignSetup) =>
  (
    expectOk(s.d.query('design.warning.list', { partId: s.partId }, ui)).value as {
      warnings: DfmWarning[]
    }
  ).warnings
const disable = (s: DesignSetup, disabled: string[]) =>
  s.run('design.part.update', { partId: s.partId, disabled })

/** A circle pocket (the next pocket id) with a chamfer on its edge, beside the test part. */
async function pocketWithChamfer(s: DesignSetup) {
  const { operationId } = (await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'circle', center: ['20', '30'], diameter: '10' },
    depth: '3',
    floorRadius: '0',
  })) as { operationId: string }
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: operationId })
}

describe('disabling an operation (DF106)', () => {
  it('leaves it and its chamfer out of the evaluated part; enabling restores it byte-equal', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    await pocketWithChamfer(s)
    const before = hashJson(expectOk(partGeometryInput(s.d.doc, s.partId)))
    const record = s.part()
    await disable(s, ['pocket2'])
    expect(s.part().disabled).toEqual(['pocket2'])
    // the list keeps it; geometry input has neither the pocket nor its chamfer
    expect(s.part().operations.map((o) => o.id)).toContain('pocket2')
    expect(opIds(s)).not.toContain('pocket2')
    expect(opIds(s)).not.toContain('chamfer1')
    const state = disabledState(s.part())
    expect([...state.roots]).toEqual(['pocket2'])
    expect([...state.dependants]).toEqual(['chamfer1'])
    await disable(s, [])
    expect(s.part()).not.toHaveProperty('disabled')
    expect(s.part()).toEqual(record)
    expect(hashJson(expectOk(partGeometryInput(s.d.doc, s.partId)))).toBe(before)
  })

  it('is one undo step', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    await disable(s, ['pocket1'])
    expect(s.part().disabled).toEqual(['pocket1'])
    await s.undo()
    expect(s.part()).not.toHaveProperty('disabled')
    await s.redo()
    expect(s.part().disabled).toEqual(['pocket1'])
  })

  it('switches off operations on its floor and their expression references too', async () => {
    const s = await designSetup()
    await buildTestPart(s)
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      center: ['50', '30'],
      diameter: '6',
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['80', '50'], diameter: '8' },
      depth: 'pocket1.floor.z * -1 - 1',
      floorRadius: '0',
    })
    await disable(s, ['pocket1'])
    expect([...disabledState(s.part()).dependants]).toEqual(['drill5', 'pocket2'])
    expect(opIds(s)).toEqual(['facing1', 'drill1', 'drill2', 'drill3', 'drill4', 'profile1'])
  })

  it('has no warnings for a disabled item', async () => {
    const s = await designSetup()
    // r = 0 always warns (design.md § Pocket)
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '20',
        width: '10',
        cornerRadius: '0',
      },
      depth: '3',
      floorRadius: '0',
    })
    expect(warnings(s).some((w) => w.operation === 'pocket1')).toBe(true)
    const r = (await disable(s, ['pocket1'])) as { warnings: DfmWarning[] }
    expect(r.warnings).toEqual([])
    expect(warnings(s)).toEqual([])
  })

  it('refuses unknown ids and owned operations, and building on a disabled item', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    await s.run('design.hole.add', { partId: s.partId, center: ['70', '30'], fastener: 'M5' })
    const unknown = await s.fail(
      'design.part.update',
      { partId: s.partId, disabled: ['pocket9'] },
      'input.malformed',
    )
    expect(unknown.issues.map((i) => i.rule)).toEqual(['unknownItem'])
    // a chamfer or an owned operation is part of something: the feature's own toggles, or its edge
    const inside = await s.fail(
      'design.part.update',
      { partId: s.partId, disabled: ['hole1_drill'] },
      'model.invariant',
    )
    expect(inside.issues.map((i) => [i.rule, i.params?.['featureId']])).toEqual([
      ['insideFeature', 'hole1'],
    ])
    await disable(s, ['pocket1'])
    const e = await s.fail(
      'design.drilling.add',
      { partId: s.partId, on: 'pocket1.floor', center: ['20', '30'], diameter: '3' },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['disabledTarget'])
    expect(s.part().operations.map((o) => o.id)).not.toContain('drill1')
  })

  it('a dependant chamfer stays off: it cannot be disabled on its own, and is listed', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    // a chamfer is a top-level row: it may be switched off alone
    await disable(s, ['chamfer1'])
    expect(opIds(s)).toEqual(['pocket1'])
    await disable(s, [])
    expect(opIds(s)).toEqual(['pocket1', 'chamfer1'])
  })

  it('a removed item leaves the list, so a new item never inherits its id', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    await disable(s, ['chamfer1'])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'chamfer1' })
    expect(s.part()).not.toHaveProperty('disabled')
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1' })
    expect(opIds(s)).toEqual(['pocket1', 'chamfer1'])
  })

  it('a feature: its owned operations go with it', async () => {
    const s = await designSetup()
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M5',
      type: 'counterbore',
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['80', '30'], diameter: '8' },
      depth: '2',
      floorRadius: '0',
    })
    expect(topLevelUnits(s.part())).toEqual(['hole1', 'pocket1'])
    await disable(s, ['hole1'])
    expect(opIds(s)).toEqual(['pocket1'])
    expect(enabledPart(s.part())).not.toHaveProperty('features')
  })

  it('Clones of a disabled operation are refused; disabling Clones takes its source too', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    const clones = {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'chamfer1'] },
      rows: [{ kind: 'offset', count: 1, du: '20', dv: '0' }],
    }
    await disable(s, ['pocket1'])
    const e = await s.fail('design.clones.add', clones, 'model.invariant')
    expect(e.issues.map((i) => i.rule)).toContain('disabledTarget')
    await disable(s, [])
    await s.run('design.clones.add', clones)
    const nested = await s.fail(
      'design.part.update',
      { partId: s.partId, disabled: ['pocket1'] },
      'model.invariant',
    )
    expect(nested.issues.map((i) => [i.rule, i.params?.['featureId']])).toEqual([
      ['insideFeature', 'clones1'],
    ])
    await disable(s, ['clones1'])
    expect(opIds(s)).toEqual([])
  })
})

describe('design.operation.list (DF106)', () => {
  it('lists what is off, the dependants included', async () => {
    const s = await designSetup()
    await pocketWithChamfer(s)
    const list = () =>
      expectOk(s.d.query('design.operation.list', { partId: s.partId }, ui)).value as {
        disabled?: string[]
      }
    expect(list()).not.toHaveProperty('disabled')
    await disable(s, ['pocket1'])
    expect(list().disabled).toEqual(['pocket1', 'chamfer1'])
  })
})
