// Several parts per project (split parts S0): a second part beside the first, rename, remove
// with its plans and snapshots, plans per part, and every edit one undo step.
// Spec: docs/modes/split-parts.md#prerequisite-several-parts-per-project
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { planSetup, type PlanSetup } from '../plan/plan.fixture'

const ui = uiSource()

/** Adds a second part from the library stock of the first, with one pocket. */
async function secondPart(s: PlanSetup, name = 'Lid'): Promise<string> {
  const stock = s.d.doc.snapshots[s.part().stock]!.libraryItemId!
  const { partId } = (await s.run('design.part.add', { name, stockLibraryItemId: stock })) as {
    partId: string
  }
  await s.run('design.pocket.add', {
    partId,
    shape: { kind: 'circle', center: ['30', '30'], diameter: '20' },
    depth: '3',
  })
  return partId
}

const list = (s: PlanSetup) =>
  (expectOk(s.d.query('design.part.list', {}, ui)).value as { parts: { name: string }[] }).parts

describe('several parts per project (S0)', () => {
  it('adds a second part with its own stock snapshot; both list; undo and redo', async () => {
    const s = await planSetup()
    const before = s.d.doc
    const lid = await secondPart(s)
    expect(list(s).map((p) => p.name)).toEqual(['Bracket', 'Lid'])
    expect(s.d.doc.parts[lid]!.stock).not.toBe(s.part().stock)
    expect(s.d.doc.parts[lid]!.operations.map((o) => o.name)).toEqual(['Pocket 1'])
    // the first part is untouched
    expect(s.part()).toBe(before.parts[s.partId])
    await s.undo() // the pocket
    await s.undo() // the part
    expect(s.d.doc.parts).toEqual(before.parts)
    expect(s.d.doc.snapshots).toEqual(before.snapshots)
    await s.redo()
    expect(list(s)).toHaveLength(2)
  })

  it('renames one part by id; the other keeps its name', async () => {
    const s = await planSetup()
    const lid = await secondPart(s)
    await s.run('design.part.update', { partId: lid, name: 'Cover' })
    expect(list(s).map((p) => p.name)).toEqual(['Bracket', 'Cover'])
    await s.undo()
    expect(s.d.doc.parts[lid]!.name).toBe('Lid')
  })

  it('plans pick their part: each plan snapshots its own part', async () => {
    const s = await planSetup()
    const lid = await secondPart(s)
    const a = await s.create()
    const b = await s.create({ partId: lid })
    expect(s.plan(a).design.partId).toBe(s.partId)
    expect(s.plan(b).design.partId).toBe(lid)
    expect(s.plan(b).design.part.name).toBe('Lid')
    expect(s.plan(b).design.part.operations.map((o) => o.name)).toEqual(['Pocket 1'])
    // an edit of the lid leaves the bracket's plan as it was; the lid's draft follows on Apply
    const bracketPlan = s.plan(a)
    await s.run('design.pocket.update', { partId: lid, operationId: 'pocket1', depth: '4' })
    await s.run('project.apply', {})
    expect(s.plan(a)).toBe(bracketPlan)
    const depth = (s.plan(b).design.part.operations[0] as { depth: { source: string } }).depth
    expect(depth.source).toBe('4')
  })

  it('removes a part with its plans (confirm) and unused snapshots; one undo step', async () => {
    const s = await planSetup()
    const lid = await secondPart(s)
    const keep = await s.create()
    const gone = await s.create({ partId: lid })
    const before = s.d.doc
    const stock = s.d.doc.parts[lid]!.stock
    const asked = await s.fail('design.part.remove', { partId: lid }, 'input.malformed')
    expect(asked.issues[0]).toMatchObject({ path: ['confirm'], rule: 'partHasPlans' })
    const r = (await s.run('design.part.remove', { partId: lid, confirm: true })) as {
      removedPlans: string[]
    }
    expect(r.removedPlans).toEqual([gone])
    expect(Object.keys(s.d.doc.parts)).toEqual([s.partId])
    expect(Object.keys(s.d.doc.plans)).toEqual([keep])
    expect(s.d.doc.snapshots[stock]).toBeUndefined()
    // the first part's stock snapshot stays
    expect(s.d.doc.snapshots[s.part().stock]).toBeDefined()
    await s.undo()
    expect(s.d.doc.parts).toEqual(before.parts)
    expect(s.d.doc.plans).toEqual(before.plans)
    expect(s.d.doc.snapshots).toEqual(before.snapshots)
  })

  it('refuses while a plan of the part is in use; an unknown part is input.malformed', async () => {
    const s = await planSetup()
    const lid = await secondPart(s)
    const planId = await s.create({ partId: lid })
    await s.toStatus(planId, 'inUse')
    const e = await s.fail('design.part.remove', { partId: lid, confirm: true }, 'model.invariant')
    expect(e.issues[0]?.rule).toBe('planInUse')
    const u = await s.fail('design.part.remove', { partId: 'nope' }, 'input.malformed')
    expect(u.issues[0]?.rule).toBe('unknownPart')
  })

  it('removes the last part without plans: the project is empty again', async () => {
    const s = await planSetup({ part: false })
    await s.run('design.part.remove', { partId: s.partId })
    expect(s.d.doc.parts).toEqual({})
    expect(Object.values(s.d.doc.snapshots).filter((x) => x.kind === 'stock')).toEqual([])
  })

  it('design tools resolve the part by id with several parts', async () => {
    const s = await planSetup()
    const lid = await secondPart(s)
    const ops = (id: string) =>
      (
        expectOk(s.d.query('design.operation.list', { partId: id }, ui)).value as {
          operations: { id: string }[]
        }
      ).operations.map((o) => o.id)
    expect(ops(lid)).toEqual(['pocket1'])
    expect(ops(s.partId)).toContain('pocket1')
    await s.run('design.operation.remove', { partId: lid, operationId: 'pocket1' })
    expect(s.d.doc.parts[lid]!.operations).toEqual([])
    expect(s.part().operations.some((o) => o.id === 'pocket1')).toBe(true)
  })
})
