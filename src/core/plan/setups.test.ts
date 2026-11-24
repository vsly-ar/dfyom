// Spec: docs/modes/plan-v0.2.md (Setups from face directions; Merge, split, reorder).
import { describe, expect, it } from 'vitest'
import { expectErrCode } from '../../shared/testing/result'
import { len, libraryInput, machineValues } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createInProcessWorkers } from '../commands/jobs'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import type { PlanDTO } from './plan.dto'
import { expectUndoRedo, planSetup, type PlanSetup } from './plan.fixture'

const rect = (cx: string, cy: string, length: string, width: string) => ({
  kind: 'rectangle',
  center: [cx, cy],
  length,
  width,
  cornerRadius: '3',
})

/** The test part (top) plus a bottom facing with a pocket on its floor and a hole on the right. */
async function multiFace(s: PlanSetup): Promise<void> {
  const partId = s.partId
  await s.run('design.facing.add', { partId, on: 'stock.bottom', depth: '0.5' })
  await s.run('design.pocket.add', {
    partId,
    on: 'facing2.floor',
    shape: rect('50', '30', '20', '10'),
    depth: '3',
    floorRadius: '0',
  })
  // flat, depth 12: equal to drill2 on the top except for the face
  await s.run('design.drilling.add', {
    partId,
    on: 'stock.side[1]',
    center: ['30', '10'],
    diameter: '6',
    bottom: 'flat',
    depth: '12',
  })
}

const setupsOf = (p: PlanDTO) =>
  p.setups.map((x) => ({
    name: x.name,
    direction: x.direction ?? '+z',
    ops: x.operations.map((o) => o.designOperationIds.join('+')),
  }))
const opId = (p: PlanDTO, designId: string) =>
  p.setups.flatMap((x) => x.operations).find((o) => o.designOperationIds.includes(designId))!.id
const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings

async function multiPlan(args: object = {}) {
  const s = await planSetup()
  await multiFace(s)
  const r = (await expectUndoRedo(s, 'plan.create', { partId: s.partId, ...args })) as {
    planId: string
    setupIds: string[]
  }
  return { s, ...r }
}

describe('setup derivation', () => {
  it('keeps one top setup for a top-only part, as in v0.1', async () => {
    const s = await planSetup()
    const planId = await s.create()
    expect(setupsOf(s.plan(planId))).toEqual([
      {
        name: 'Top',
        direction: '+z',
        ops: ['facing1', 'drill1', 'drill3+drill4', 'drill2', 'pocket1', 'profile1'],
      },
    ])
  })

  it('makes one setup per direction: bottom first, the sides, the top last', async () => {
    const { s, planId, setupIds } = await multiPlan()
    const p = s.plan(planId)
    expect(setupIds).toEqual(p.setups.map((x) => x.id))
    expect(setupsOf(p)).toEqual([
      { name: 'Bottom', direction: '-z', ops: ['facing2', 'pocket2'] },
      // not grouped with drill2: one plan operation lies in one setup
      { name: 'Right', direction: '+x', ops: ['drill5'] },
      {
        name: 'Top',
        direction: '+z',
        ops: ['facing1', 'drill1', 'drill3+drill4', 'drill2', 'pocket1', 'profile1'],
      },
    ])
    expect(p.setups.every((x) => x.workOffset === 'G54' && x.rotation === undefined)).toBe(true)
  })

  it('derives every direction', async () => {
    const s = await planSetup({ part: false })
    const faces = ['stock.top', 'stock.bottom', 'stock.side[0]', 'stock.side[1]']
    for (const on of [...faces, 'stock.side[2]', 'stock.side[3]'])
      await s.run('design.facing.add', { partId: s.partId, on, depth: '0.5' })
    const planId = await s.create()
    expect(setupsOf(s.plan(planId)).map((x) => [x.name, x.direction])).toEqual([
      ['Bottom', '-z'],
      ['Front', '-y'],
      ['Right', '+x'],
      ['Back', '+y'],
      ['Left', '-x'],
      ['Top', '+z'],
    ])
  })

  it('DF65: a setup starts with the last tool of the setup before when that costs no run', async () => {
    const s = await planSetup({ part: false })
    const hole = (on: string, x: string, diameter: string) =>
      s.run('design.drilling.add', {
        partId: s.partId,
        on,
        center: [x, '30'],
        diameter,
        bottom: 'flat',
        depth: '3',
      })
    // the bottom ends with the 6 mm end mill (Ø 8); the top bores Ø 5 (4 mm) and Ø 8 (6 mm)
    await hole('stock.bottom', '50', '8')
    await hole('stock.top', '20', '5')
    await hole('stock.top', '70', '8')
    await s.run('project.apply', {})
    const p = s.plan(await s.create())
    expect(setupsOf(p).map((x) => x.ops)).toEqual([['drill1'], ['drill3', 'drill2']])
    const [bottom, top] = p.setups
    expect(top!.operations[0]!.tool).toBe(bottom!.operations.at(-1)!.tool)
  })
})

describe('order checks across setups', () => {
  it('warns plan.cutoutBeforeSetup for a through profile before another setup', async () => {
    const { s, planId } = await multiPlan()
    expect(warnings(s, planId).filter((w) => w.code === 'plan.cutoutBeforeSetup')).toEqual([])
    const top = s.plan(planId).setups[2]!.id
    await s.run('plan.setup.move', { planId, setupId: top, toIndex: 0 })
    const found = warnings(s, planId).filter((w) => w.code === 'plan.cutoutBeforeSetup')
    expect(found).toMatchObject([
      {
        severity: 'warning',
        planOperationId: opId(s.plan(planId), 'profile1'),
        rule: 'cutoutLast',
        params: { profile: 'profile1', setupId: top },
      },
    ])
    // the loose-piece check compares face-frame positions of one direction only
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([])
  })

  it('a blind on groove before another setup frees nothing: no plan.cutoutBeforeSetup', async () => {
    const s = await planSetup()
    await multiFace(s)
    await s.run('design.profile.update', {
      partId: s.partId,
      operationId: 'profile1',
      side: 'on',
      depth: '2',
    })
    const planId = await s.create()
    const top = s.plan(planId).setups[2]!.id
    await s.run('plan.setup.move', { planId, setupId: top, toIndex: 0 })
    expect(warnings(s, planId).filter((w) => w.code === 'plan.cutoutBeforeSetup')).toEqual([])
  })

  it('rejects a move that puts an operation before the setup making its on face', async () => {
    const { s, planId } = await multiPlan()
    const bottom = s.plan(planId).setups[0]!.id
    // pocket2 starts from facing2.floor: splitting facing2 off would make it later
    const e = await s.failWith(
      'plan.setup.split',
      { planId, setupId: bottom, planOperationIds: [opId(s.plan(planId), 'facing2')] },
      'plan.order',
    )
    expect(e.issues[0]).toMatchObject({
      rule: 'onBefore',
      params: { dependsOn: opId(s.plan(planId), 'facing2') },
    })
    const split = (await expectUndoRedo(s, 'plan.setup.split', {
      planId,
      setupId: bottom,
      planOperationIds: [opId(s.plan(planId), 'pocket2')],
    })) as { setupId: string }
    expect(warnings(s, planId).filter((w) => w.code === 'plan.order')).toEqual([])
    await s.failWith(
      'plan.setup.move',
      { planId, setupId: split.setupId, toIndex: 0 },
      'plan.order',
    )
    await s.failWith(
      'plan.operation.move',
      {
        planId,
        planOperationId: opId(s.plan(planId), 'facing2'),
        toIndex: 1,
        toSetupId: split.setupId,
      },
      'plan.order',
    )
  })
})

describe('plan.setup.split / merge / move', () => {
  it('splits chosen operations into a new setup of the same direction after it', async () => {
    const { s, planId } = await multiPlan()
    const top = s.plan(planId).setups[2]!
    const ids = [opId(s.plan(planId), 'profile1'), opId(s.plan(planId), 'drill2')]
    const r = (await expectUndoRedo(s, 'plan.setup.split', {
      planId,
      setupId: top.id,
      planOperationIds: ids,
    })) as { setupId: string }
    const p = s.plan(planId)
    expect(p.setups[3]).toMatchObject({ id: r.setupId, name: 'Top 2' })
    expect(p.setups[3]).not.toHaveProperty('direction')
    expect(setupsOf(p).slice(2)).toEqual([
      { name: 'Top', direction: '+z', ops: ['facing1', 'drill1', 'drill3+drill4', 'pocket1'] },
      // in their order in the setup
      { name: 'Top 2', direction: '+z', ops: ['drill2', 'profile1'] },
    ])
    await s.failWith(
      'plan.setup.split',
      { planId, setupId: r.setupId, planOperationIds: ids },
      'input.malformed',
    )
    await s.failWith(
      'plan.setup.split',
      { planId, setupId: top.id, planOperationIds: [ids[0]!] },
      'input.malformed',
    )
  })

  it('merges setups of one direction into the first; different directions fail with plan.setup', async () => {
    const { s, planId } = await multiPlan()
    const [bottom, right, top] = s.plan(planId).setups.map((x) => x.id)
    const e = await s.failWith('plan.setup.merge', { planId, setupIds: [top, right] }, 'plan.setup')
    expect(e.issues[0]).toMatchObject({ path: ['setupIds'], rule: 'sameDirection' })
    await s.run('plan.setup.split', {
      planId,
      setupId: top!,
      planOperationIds: [opId(s.plan(planId), 'profile1')],
    })
    const split = s.plan(planId).setups[3]!.id
    await s.run('plan.setup.move', { planId, setupId: split, toIndex: 0 })
    const r = (await expectUndoRedo(s, 'plan.setup.merge', {
      planId,
      setupIds: [top, split],
    })) as { setupId: string }
    // into the first in machining order (the moved one); the others keep their place
    expect(r.setupId).toBe(split)
    expect(s.plan(planId).setups.map((x) => x.id)).toEqual([split, bottom, right])
    expect(setupsOf(s.plan(planId))[0]!.ops).toEqual([
      'profile1',
      'facing1',
      'drill1',
      'drill3+drill4',
      'drill2',
      'pocket1',
    ])
  })

  it('moves a setup and validates the index and ids', async () => {
    const { s, planId } = await multiPlan()
    const [bottom, right, top] = s.plan(planId).setups.map((x) => x.id)
    await expectUndoRedo(s, 'plan.setup.move', { planId, setupId: bottom, toIndex: 2 })
    expect(s.plan(planId).setups.map((x) => x.id)).toEqual([right, top, bottom])
    await s.failWith('plan.setup.move', { planId, setupId: top, toIndex: 3 }, 'input.malformed')
    await s.failWith('plan.setup.move', { planId, setupId: 'nope', toIndex: 0 }, 'input.malformed')
  })

  it('moves a plan operation into another setup of the same direction only', async () => {
    const { s, planId } = await multiPlan()
    const [, right, top] = s.plan(planId).setups.map((x) => x.id)
    const pocket = opId(s.plan(planId), 'pocket1')
    await s.failWith(
      'plan.operation.move',
      { planId, planOperationId: pocket, toIndex: 0, toSetupId: right },
      'plan.setup',
    )
    await s.run('plan.setup.split', {
      planId,
      setupId: top!,
      planOperationIds: [opId(s.plan(planId), 'profile1')],
    })
    const split = s.plan(planId).setups[3]!.id
    await expectUndoRedo(s, 'plan.operation.move', {
      planId,
      planOperationId: pocket,
      toIndex: 0,
      toSetupId: split,
    })
    expect(setupsOf(s.plan(planId))[3]!.ops).toEqual(['pocket1', 'profile1'])
    // emptying a setup removes it
    await s.run('plan.operation.move', {
      planId,
      planOperationId: opId(s.plan(planId), 'drill5'),
      toIndex: 0,
    })
    expect(s.plan(planId).setups).toHaveLength(4)
  })

  it('renames and rotates a setup; 0° is stored as absent', async () => {
    const { s, planId } = await multiPlan()
    const setupId = s.plan(planId).setups[0]!.id
    await expectUndoRedo(s, 'plan.setup.update', { planId, setupId, name: 'Flip', rotation: 90 })
    expect(s.plan(planId).setups[0]).toMatchObject({ name: 'Flip', rotation: 90 })
    await s.run('plan.setup.update', { planId, setupId, rotation: 0 })
    expect(s.plan(planId).setups[0]).not.toHaveProperty('rotation')
    await s.failWith('plan.setup.update', { planId, setupId, rotation: 45 }, 'input.malformed')
  })
})

describe('machine checks per setup', () => {
  it('checks the stock in each setup orientation, swapped by a 90° rotation', async () => {
    const s = await planSetup()
    // travel 120 × 70 × 50 fits the stock 100 × 60 lying flat, not on its right side (60 × 20 × 100)
    const { kind: _, ...m } = machineValues()
    const machine = (
      (await s.run('library.machine.add', {
        values: libraryInput({
          ...m,
          name: 'Small',
          travel: { x: len('120'), y: len('70'), z: len('50') },
        }),
      })) as { id: string }
    ).id
    await multiFace(s)
    const planId = await s.create({ machineLibraryItemId: machine })
    const right = s.plan(planId).setups[1]!.id
    const travel = () =>
      warnings(s, planId)
        .filter((w) => w.code === 'plan.machine')
        .map((w) => [w.params['setupId'], w.params['axis'], w.message])
    expect(travel()).toEqual([[right, 'z', 'stock length + clearance height exceeds the Z travel']])
    const bottom = s.plan(planId).setups[0]!.id
    await s.run('plan.setup.update', { planId, setupId: bottom, rotation: 90 })
    // rotated, the 100 mm length lies along Y (travel 70)
    expect(travel()).toEqual([
      [bottom, 'y', 'stock length exceeds the Y travel'],
      [right, 'z', 'stock length + clearance height exceeds the Z travel'],
    ])
  })
})

describe('rebuild keeps the setup structure', () => {
  it('adds new operations to the last setup of their direction or a new setup; drops empty ones', async () => {
    const s = await planSetup()
    const planId = await s.create()
    const top = s.plan(planId).setups[0]!.id
    await s.run('plan.setup.split', {
      planId,
      setupId: top,
      planOperationIds: [opId(s.plan(planId), 'profile1')],
    })
    await multiFace(s)
    await s.run('design.drilling.add', {
      partId: s.partId,
      center: ['50', '50'],
      diameter: '3',
    })
    // a draft plan follows the design on Apply; rebuild explicitly in case it has not
    await s.run('plan.rebuild', { planId })
    expect(setupsOf(s.plan(planId))).toEqual([
      { name: 'Bottom', direction: '-z', ops: ['facing2', 'pocket2'] },
      { name: 'Right', direction: '+x', ops: ['drill5'] },
      {
        name: 'Top',
        direction: '+z',
        ops: ['facing1', 'drill1', 'drill3+drill4', 'drill2', 'pocket1'],
      },
      // the new top hole joins the last top setup
      { name: 'Top 2', direction: '+z', ops: ['drill6', 'profile1'] },
    ])
    await s.run('design.operation.remove', { partId: s.partId, operationId: 'drill5' })
    await s.run('plan.rebuild', { planId })
    expect(setupsOf(s.plan(planId)).map((x) => x.name)).toEqual(['Bottom', 'Top', 'Top 2'])
  })
})

describe('export with several setups', () => {
  it('fails with plan.setup until export per setup (task E2)', async () => {
    const s0 = await planSetup()
    const { s, planId } = await multiPlan({ machineLibraryItemId: s0.machineId })
    const r = await exportPlan(s.d.doc, planId, {
      workers: createInProcessWorkers(),
      toolpaths: createToolpathCache(),
    })
    expectErrCode(r, 'plan.setup')
  })
})
