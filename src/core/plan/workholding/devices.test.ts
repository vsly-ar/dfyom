// Workholding devices from the library in a plan (slice WL2): copies, placement, detach, stale
// and update, range findings, Copy from, Arrange automatically and the program header.
// Spec: docs/modes/workholding-library.md (§ Setup item, § Snapshots and persistence, § Placing
// items, § Implementation (WL2))
import { describe, expect, it } from 'vitest'
import { Ok } from '../../../shared/result'
import { expectOk } from '../../../shared/testing/result'
import { createInProcessWorkers } from '../../commands/jobs'
import { uiSource } from '../../commands/testing'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { len, libraryInput, toeClampValues } from '../../library/library.fixture'
import { exportPlan } from '../../post/plan-export'
import { createToolpathCache } from '../../toolpath/cache'
import type { PlanWarning } from '../checks'
import { loadPlanDTO } from '../plan'
import { expectUndoRedo, flat6, planSetup, stale, type PlanSetup } from '../plan.fixture'
import { setupWorkholding } from './setup'

const region2d = nodeRegion2d()

interface SetResult {
  items: { id: string; name: string; summary: string; libraryItemId?: string }[]
  findings: PlanWarning[]
}

async function plan(opts: { services?: object; stock?: object; part?: boolean } = {}) {
  const s = await planSetup(opts)
  const planId = await s.create()
  return { s, planId, setupId: s.plan(planId).setups[0]!.id }
}

/** The user's strap clamp (25 × 70, top 30, grip 5–20, M8) in the library. */
async function strapClamp(s: PlanSetup, extra: object = {}): Promise<string> {
  return (
    (await s.run('library.workholding.add', {
      values: { ...libraryInput(toeClampValues()), ...extra },
    })) as { id: string }
  ).id
}

const set = async (s: PlanSetup, args: object) =>
  (await s.run('plan.workholding.set', args)) as SetResult

const items = (s: PlanSetup, planId: string, n = 0) => s.plan(planId).setups[n]!.workholding ?? []
const copies = (s: PlanSetup, planId: string) =>
  s.plan(planId).snapshots.filter((c) => c.kind === 'workholding')
const source = (q: unknown) => (q as { source: string }).source

const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings

describe('placing a library device (plan.workholding.set libraryItemId)', () => {
  it('a library clamp gives the same prisms as the equal own item; the plan keeps one copy', async () => {
    const { s, planId, setupId } = await plan()
    const id = await strapClamp(s)
    const r = (await expectUndoRedo(s, 'plan.workholding.set', {
      planId,
      setupId,
      items: [
        { kind: 'toeClamp', edge: 'vMin', at: '40', libraryItemId: id },
        { kind: 'toeClamp', edge: 'vMax', at: '40', libraryItemId: id },
      ],
    })) as SetResult
    // grip: the middle of 5–20; reach: the strap length less the grip
    expect(r.items.map((i) => [i.summary, i.libraryItemId])).toEqual([
      ['front X40 grip 12.5 top Z30 · Strap clamp M8', id],
      ['back X40 grip 12.5 top Z30 · Strap clamp M8', id],
    ])
    expect(copies(s, planId)).toEqual([
      expect.objectContaining({
        libraryItemId: id,
        values: expect.objectContaining({ stud: 'M8' }),
      }),
    ])
    const copyId = copies(s, planId)[0]!.id
    expect(items(s, planId).map((i) => i.copyId)).toEqual([copyId, copyId])
    const first = items(s, planId)[0]!
    expect(first.kind === 'toeClamp' && source(first.reach)).toBe('57.5 mm')

    const own = await plan()
    await set(own.s, {
      planId: own.planId,
      setupId: own.setupId,
      items: ['vMin', 'vMax'].map((edge) => ({
        kind: 'toeClamp',
        edge,
        at: '40',
        width: '25',
        grip: '12.5',
        reach: '57.5',
        top: '30',
      })),
    })
    const stock = expectOk(loadPlanDTO(s.plan(planId), 'mm', 'test')).stock
    const prisms = (p: PlanSetup, id: string) =>
      setupWorkholding(p.plan(id).setups[0]!, stock).prisms
    expect(prisms(s, planId)).toEqual(prisms(own.s, own.planId))
  })

  it('a built-in is placed from the project units; an unknown id and another type are refused', async () => {
    const { s, planId, setupId } = await plan()
    const r = await set(s, {
      planId,
      setupId,
      items: [{ kind: 'vise', libraryItemId: 'builtin-vise' }],
    })
    // a built-in's name restates the kind: not added to the summary
    expect(r.items[0]!.summary).toBe('jaws along X, stock 5 above them')
    expect(r.items[0]!.libraryItemId).toBe('builtin-vise')
    const e = await s.failWith(
      'plan.workholding.set',
      {
        planId,
        setupId,
        items: [
          { kind: 'toeClamp', edge: 'vMin', libraryItemId: 'nope' },
          { kind: 'screw', center: ['10', '10'], libraryItemId: 'builtin-vise' },
        ],
      },
      'input.malformed',
    )
    expect(e.issues.map((i) => [i.path.join('.'), i.rule])).toEqual([
      ['items.0.libraryItemId', 'unknownItem'],
      ['items.1.libraryItemId', 'kindMismatch'],
    ])
  })
})

describe('editing a placed item (Q138)', () => {
  it('a placement edit keeps the device; a different device value detaches, one undo step', async () => {
    const { s, planId, setupId } = await plan()
    const id = await strapClamp(s)
    await set(s, {
      planId,
      setupId,
      items: [
        { kind: 'toeClamp', edge: 'vMin', libraryItemId: id },
        { kind: 'toeClamp', edge: 'vMax', libraryItemId: id },
      ],
    })
    const [a, b] = items(s, planId).map((i) => i.id) as [string, string]
    // grip is placement: the reach follows the strap; the device's own width again is no edit
    await set(s, {
      planId,
      setupId,
      items: [
        { id: a, kind: 'toeClamp', grip: '8', width: '25 mm' },
        { id: b, kind: 'toeClamp' },
      ],
    })
    const kept = items(s, planId)[0]!
    expect(kept.copyId).toBeDefined()
    expect(kept.kind === 'toeClamp' && [source(kept.grip), source(kept.reach)]).toEqual([
      '8',
      '62 mm',
    ])
    // a longer strap on one clamp: an own item with the device's other values
    await expectUndoRedo(s, 'plan.workholding.set', {
      planId,
      setupId,
      items: [
        { id: a, kind: 'toeClamp', reach: '80' },
        { id: b, kind: 'toeClamp' },
      ],
    })
    const [own, still] = items(s, planId)
    expect(own!.copyId).toBeUndefined()
    expect(own!.kind === 'toeClamp' && [source(own!.width), source(own!.reach)]).toEqual([
      '25',
      '80',
    ])
    expect(still!.copyId).toBe(copies(s, planId)[0]!.id)
    // the last item of a device gone: its copy goes with it
    await set(s, { planId, setupId, items: [{ id: a, kind: 'toeClamp' }] })
    expect(copies(s, planId)).toEqual([])
  })

  it('Copy from keeps the copy: both setups follow the same device', async () => {
    const { s, planId, setupId } = await plan()
    const second = (
      (await s.run('plan.setup.split', {
        planId,
        setupId,
        planOperationIds: [s.plan(planId).setups[0]!.operations.at(-1)!.id],
      })) as { setupId: string }
    ).setupId
    const id = await strapClamp(s)
    await set(s, {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'uMin', libraryItemId: id }],
    })
    await set(s, { planId, setupId: second, copyFrom: setupId })
    expect(copies(s, planId)).toHaveLength(1)
    expect(items(s, planId, 1)[0]!.copyId).toBe(copies(s, planId)[0]!.id)
  })
})

describe('library changes (stale, Update from library, draft follow)', () => {
  async function changeStrap(s: PlanSetup, id: string, values: object) {
    const item = s.query('library.workholding.get', { id }) as { revision: number }
    await s.run('library.workholding.update', {
      id,
      revision: item.revision,
      values: libraryInput({ ...toeClampValues(), ...values }),
    })
  }

  it('a library edit marks the copy; plan.libraryItem.update writes it into every item', async () => {
    const { s, planId, setupId } = await plan()
    await s.toStatus(planId, 'settledDesign')
    const id = await strapClamp(s)
    await set(s, {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'uMin', libraryItemId: id }],
    })
    // marking it the default is about the library, not the device: still current
    await changeStrap(s, id, { default: true })
    expect(stale(s, planId).libraryCopies).toEqual([])
    await changeStrap(s, id, { default: true, width: len('40'), length: len('90') })
    const listed = stale(s, planId).libraryCopies
    expect(listed).toEqual([
      expect.objectContaining({ kind: 'workholding', status: 'libraryChanged', blocked: null }),
    ])
    await expectUndoRedo(s, 'plan.libraryItem.update', {
      planId,
      snapshotId: listed[0]!.snapshotId,
    })
    expect(stale(s, planId).libraryCopies).toEqual([])
    const item = items(s, planId)[0]!
    expect(item.kind === 'toeClamp' && [source(item.width), source(item.reach)]).toEqual([
      '40',
      '77.5 mm',
    ])
    // a strap shorter than the grip cannot be applied
    await changeStrap(s, id, { length: len('12'), gripMin: len('3'), gripMax: len('8') })
    const blocked = stale(s, planId).libraryCopies[0]!
    expect(blocked.blocked).toMatch(/can't be applied/)
    await s.failWith(
      'plan.libraryItem.update',
      { planId, snapshotId: blocked.snapshotId },
      'model.invariant',
    )
  })

  it('a draft plan follows the device on Apply', async () => {
    const { s, planId, setupId } = await plan()
    const id = await strapClamp(s)
    await set(s, {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'uMin', libraryItemId: id }],
    })
    await changeStrap(s, id, { top: len('45') })
    await s.run('project.apply', {})
    const item = items(s, planId)[0]!
    expect(item.kind === 'toeClamp' && source(item.top)).toBe('45')
    expect(stale(s, planId).libraryCopies).toEqual([])
  })
})

describe('plan.workholding.outOfRange', () => {
  it('a grip outside the clamp range and a stock wider than the vise opening are warnings', async () => {
    const { s, planId, setupId } = await plan()
    const id = await strapClamp(s)
    const r = await set(s, {
      planId,
      setupId,
      items: [{ kind: 'toeClamp', edge: 'uMin', grip: '25', libraryItemId: id }],
    })
    const range = (w: PlanWarning[]) =>
      w.filter((f) => f.code === 'plan.workholding.outOfRange').map((f) => [f.severity, f.rule])
    expect(range(r.findings)).toEqual([['warning', 'grip']])
    expect(range(warnings(s, planId))).toEqual([['warning', 'grip']])
    const vise = (
      (await s.run('library.workholding.add', {
        values: {
          name: 'Small vise',
          type: 'vise',
          jawWidth: '100',
          jawThickness: '15',
          maxOpening: '20',
        },
      })) as { id: string }
    ).id
    await set(s, { planId, setupId, items: [{ kind: 'vise', libraryItemId: vise }] })
    expect(range(warnings(s, planId))).toEqual([['warning', 'opening']])
  })
})

describe("Arrange automatically and the program header (W6 with the library's clamp)", () => {
  const services = () => ({
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    toolpaths: createToolpathCache(),
    region2d,
  })

  async function profiled() {
    const s = await planSetup({
      part: false,
      services: services(),
      stock: {
        name: 'Board',
        shape: 'block',
        length: '250',
        width: '100',
        thickness: '12',
        material: { name: 'Oak', class: 'hardwood' },
      },
    })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['125', '50'],
        length: '150',
        width: '60',
        cornerRadius: '5',
      },
      tabs: { count: '4', width: '8', thickness: '3' },
    })
    await s.run('project.apply', {})
    const long6 = (
      (await s.run('library.tool.add', {
        values: libraryInput({ ...flat6(), name: 'Long flat 6', fluteLength: len('30') }),
      })) as { id: string }
    ).id
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    for (const op of s.plan(planId).setups[0]!.operations)
      await s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: long6 })
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    return { s, planId, setupId: s.plan(planId).setups[0]!.id }
  }

  it('the default toe clamp is placed (the built-in without one), autoItemId names another', async () => {
    const { s, planId, setupId } = await profiled()
    const builtin = await set(s, { planId, setupId, auto: 'toeClamps' })
    expect(builtin.items.map((i) => [i.summary, i.libraryItemId])).toEqual([
      // W6-C's size: where the exit criteria put them (X45, X205)
      ['front X45 grip 10 top Z25', 'builtin-toe-clamp'],
      ['front X205 grip 10 top Z25', 'builtin-toe-clamp'],
      ['back X45 grip 10 top Z25', 'builtin-toe-clamp'],
      ['back X205 grip 10 top Z25', 'builtin-toe-clamp'],
    ])
    expect(copies(s, planId).map((c) => c.libraryItemId)).toEqual(['builtin-toe-clamp'])
    const id = await strapClamp(s, { default: true })
    const strap = await set(s, { planId, setupId, auto: 'toeClamps' })
    expect(strap.items.every((i) => i.libraryItemId === id)).toBe(true)
    expect(strap.items[0]!.summary).toMatch(/grip 12\.5 top Z30 · Strap clamp M8$/)
    expect(copies(s, planId).map((c) => c.libraryItemId)).toEqual([id])
    const again = await set(s, {
      planId,
      setupId,
      auto: 'toeClamps',
      autoItemId: 'builtin-toe-clamp',
    })
    expect(again.items[0]!.libraryItemId).toBe('builtin-toe-clamp')
    const e = await s.failWith(
      'plan.workholding.set',
      { planId, setupId, auto: 'toeClamps', autoItemId: 'builtin-vise' },
      'input.malformed',
    )
    expect(e.issues[0]).toMatchObject({ path: ['autoItemId'], rule: 'kindMismatch' })
  })

  it("the program header names a library device after the item's summary", async () => {
    const { s, planId, setupId } = await profiled()
    const id = await strapClamp(s, { default: true })
    await set(s, { planId, setupId, auto: 'toeClamps' })
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    const text = expectOk(await exportPlan(s.d.doc, planId, services())).text
    const lines = text.split('\n').filter((l) => l.startsWith('(Workholding: '))
    // too long for one GRBL line (70 bytes): the device on the next
    expect(lines.slice(0, 2)).toEqual([
      '(Workholding: Toe clamp 1: front X34 grip 12.5 top Z30)',
      '(Workholding: Toe clamp 1 device: Strap clamp M8)',
    ])
    expect(lines).toHaveLength(8)
    // a short one fits: "Toe clamp 1: left Y50 grip 12.5 top Z30 · Strap M8"
    const v = s.query('library.workholding.get', { id }) as { revision: number }
    await s.run('library.workholding.update', {
      id,
      revision: v.revision,
      values: libraryInput({ ...toeClampValues(), name: 'Strap M8' }),
    })
    await s.run('plan.libraryItem.update', { planId, snapshotId: copies(s, planId)[0]!.id })
    const again = expectOk(await exportPlan(s.d.doc, planId, services())).text
    expect(again).toContain('(Workholding: Toe clamp 1: front X34 grip 12.5 top Z30 - Strap M8)')
  })
})
