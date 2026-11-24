// Machining order v2 (X1 follow-up): the fewest tool runs the dependencies allow, by kind within a
// run; the through profile that frees a piece after the operations inside it; rebuild placement
// by tool; `plan.loosePiece` for a user's order. Spec: docs/modes/plan-v0.4.md#machining-order-v2
import { describe, expect, it } from 'vitest'
import type { PlanWarning } from './checks'
import { partFromDTO } from '../design/operation'
import { defaultOrder } from './order'
import type { PlanDTO } from './plan.dto'
import { designIds, opsOf, planSetup, type PlanSetup } from './plan.fixture'

const rect = (cx: string, cy: string, length: string, width: string, cornerRadius: string) => ({
  kind: 'rectangle',
  center: [cx, cy],
  length,
  width,
  cornerRadius,
})

/** Tool runs of the plan's (only) setup: one entry per tool change plus the first tool. */
const runs = (p: PlanDTO) =>
  opsOf(p)
    .map((o) => o.tool)
    .filter((t, i, a) => i === 0 || t !== a[i - 1])

const warnings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings

const hole = (s: PlanSetup, cx: string, cy: string, diameter: string) =>
  s.run('design.drilling.add', {
    partId: s.partId,
    center: [cx, cy],
    diameter,
    bottom: 'flat',
    depth: '3',
  })

const pocket = (s: PlanSetup, shape: object) =>
  s.run('design.pocket.add', { partId: s.partId, shape, depth: '2' })

/** A through outside profile round most of the 100 × 60 block (Flat 6 by the auto choice). */
const outline = (s: PlanSetup) =>
  s.run('design.profile.add', {
    partId: s.partId,
    shape: rect('50', '30', '84', '44', '5'),
    slotWidth: '6',
    tabs: { count: '4', width: '8', thickness: '3' },
  })

describe('default order: fewest tool runs', () => {
  it('groups by tool across kinds (1 change where the kind groups needed 2)', async () => {
    const s = await planSetup({ part: false })
    // Ø 5 bored by the 4 mm end mill, Ø 8 by the 6 mm; a large pocket (6 mm) and a 5 mm slot (4 mm)
    await hole(s, '20', '20', '5')
    await hole(s, '40', '20', '8')
    await pocket(s, rect('70', '30', '20', '20', '4'))
    await pocket(s, rect('20', '45', '10', '5', '2'))
    await s.run('project.apply', {})
    const planId = await s.create()
    const p = s.plan(planId)
    // kind groups would be drill5 (4) → drill8 (6) → pocket1 (6) → pocket2 (4) → … 2 changes
    expect(designIds(p)).toEqual(['drill1', 'pocket2', 'drill2', 'pocket1'])
    expect(runs(p)).toHaveLength(2)
  })

  it('a drilling on a pocket floor still follows its pocket, in the same run', async () => {
    const s = await planSetup({ part: false })
    await pocket(s, rect('30', '30', '20', '20', '4'))
    await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      center: ['30', '30'],
      diameter: '8',
      bottom: 'flat',
      depth: '2',
    })
    await hole(s, '70', '30', '8')
    await s.run('project.apply', {})
    const planId = await s.create()
    // one 6 mm run by kind: the free hole first, the hole on the floor once the pocket is cut
    expect(designIds(s.plan(planId))).toEqual(['drill2', 'pocket1', 'drill1'])
    expect(runs(s.plan(planId))).toHaveLength(1)
    expect(warnings(s, planId).filter((w) => w.code === 'plan.order')).toEqual([])
  })

  it('is deterministic: the same design gives the same order', async () => {
    const order = async () => {
      const s = await planSetup()
      await hole(s, '20', '45', '5')
      await s.run('project.apply', {})
      return designIds(s.plan(await s.create()))
    }
    expect(await order()).toEqual(await order())
  })
})

describe('default order: the freeing cut last', () => {
  it('the outline comes after the operations inside it, even of its own tool', async () => {
    const s = await planSetup({ part: false })
    await outline(s)
    await hole(s, '30', '30', '8')
    await pocket(s, rect('60', '30', '10', '5', '2'))
    await s.run('project.apply', {})
    const planId = await s.create()
    const p = s.plan(planId)
    // without the freeing rule the 6 mm run would cut the hole and the outline, then the 4 mm
    // slot inside a loose piece; now the 4 mm run goes first: still one change
    expect(designIds(p)).toEqual(['pocket1', 'drill1', 'profile1'])
    expect(runs(p)).toHaveLength(2)
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([])
  })

  it('DF57: the outline releases the part, so it comes after operations outside its box', async () => {
    const s = await planSetup({ part: false })
    // a 6 mm pocket inside the outline, then a 4 mm rebate across its back edge (centre outside
    // the outline's box, y 54 > 52): the freeing rule alone let the 6 mm run cut the outline first
    await pocket(s, rect('50', '30', '20', '20', '4'))
    await outline(s)
    await pocket(s, rect('50', '54', '20', '10', '2'))
    await s.run('project.apply', {})
    const planId = await s.create()
    expect(designIds(s.plan(planId))).toEqual(['pocket2', 'pocket1', 'profile1'])
    expect(runs(s.plan(planId))).toHaveLength(2)
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([])
    // a user's order that releases the part first warns for the rebate after it
    const outlineOp = opsOf(s.plan(planId))[2]!.id
    const rebateOp = opsOf(s.plan(planId))[0]!.id
    await s.run('plan.operation.move', { planId, planOperationId: outlineOp, toIndex: 0 })
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([
      expect.objectContaining({ planOperationId: rebateOp, rule: 'releaseFirst' }),
      expect.objectContaining({
        rule: 'profileFirst',
        params: { profile: 'profile1', operation: 'pocket1' },
      }),
    ])
  })

  it('an inside cutout is cut before the outline enclosing it', async () => {
    const s = await planSetup({ part: false })
    await outline(s)
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '20' },
      side: 'inside',
      slotWidth: '6',
      tabs: { count: '2', width: '4', thickness: '2' },
    })
    await s.run('project.apply', {})
    const planId = await s.create()
    expect(designIds(s.plan(planId))).toEqual(['profile2', 'profile1'])
    // a user's order that cuts the outline first warns about the cutout inside it
    const outlineOp = opsOf(s.plan(planId))[1]!.id
    await s.run('plan.operation.move', { planId, planOperationId: outlineOp, toIndex: 0 })
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        rule: 'profileFirst',
        params: { profile: 'profile1', operation: 'profile2' },
      }),
    ])
  })

  it("a chamfer on a cutout's edge follows the cutout and frees nothing (X2)", async () => {
    const s = await planSetup({ part: false })
    await outline(s)
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: ['50', '30'], diameter: '20' },
      side: 'inside',
      slotWidth: '10',
      tabs: { count: '0' },
    })
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'profile2' })
    await s.run('project.apply', {})
    const planId = await s.create()
    // the chamfer's centre is inside the cutout, but it bevels the rim round it: the cutout is
    // not cut after it (which the edge forbids anyway) and does not warn about it
    expect(designIds(s.plan(planId))).toEqual(['profile2', 'chamfer1', 'profile1'])
    expect(
      warnings(s, planId).filter((w) => w.code === 'plan.loosePiece' || w.code === 'plan.order'),
    ).toEqual([])
  })

  it('a blind groove frees nothing: no loose-piece warning', async () => {
    const s = await planSetup({ part: false })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('50', '30', '60', '40', '5'),
      side: 'on',
      depth: '1',
      slotWidth: '6',
      tabs: { count: '0', width: '8', thickness: '3' },
    })
    await hole(s, '50', '30', '8')
    await s.run('project.apply', {})
    const planId = await s.create()
    const profile = opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'profile1')!
    await s.run('plan.operation.move', { planId, planOperationId: profile.id, toIndex: 0 })
    expect(designIds(s.plan(planId))[0]).toBe('profile1')
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([])
  })
})

describe('rebuild placement by tool', () => {
  it("a new operation joins its tool's run, before the outline enclosing it", async () => {
    const s = await planSetup({ part: false })
    await outline(s)
    await hole(s, '20', '20', '5')
    await pocket(s, rect('70', '30', '20', '20', '4'))
    await s.run('project.apply', {})
    const planId = await s.create()
    expect(designIds(s.plan(planId))).toEqual(['drill1', 'pocket1', 'profile1'])
    // a draft follows the design: the 4 mm slot is placed next to the 4 mm hole
    await pocket(s, rect('20', '45', '10', '5', '2'))
    await s.run('project.apply', {})
    const p = s.plan(planId)
    expect(designIds(p)).toEqual(['drill1', 'pocket2', 'pocket1', 'profile1'])
    expect(runs(p)).toHaveLength(2)
    // a new vent inside the outline: before it, though profiles come last by group
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('50', '30', '10', '5', '2'),
      side: 'inside',
      slotWidth: '4',
      tabs: { count: '0', width: '4', thickness: '2' },
    })
    await s.run('project.apply', {})
    const after = designIds(s.plan(planId))
    expect(after.at(-1)).toBe('profile1')
    expect(after.indexOf('profile2')).toBeLessThan(after.indexOf('profile1'))
    expect(warnings(s, planId).filter((w) => w.code === 'plan.loosePiece')).toEqual([])
  })
})

describe('default order: the setup before’s last tool first (DF65)', () => {
  const ids = (list: readonly { designOperationIds: readonly string[] }[]) =>
    list.map((o) => o.designOperationIds.join('+'))

  it('starts with startTool when that costs no run, else keeps the order', async () => {
    const s = await planSetup({ part: false })
    await hole(s, '20', '20', '5')
    await hole(s, '40', '20', '8')
    await pocket(s, rect('70', '30', '20', '20', '4'))
    await pocket(s, rect('20', '45', '10', '5', '2'))
    await s.run('project.apply', {})
    const p = s.plan(await s.create())
    const ops = opsOf(p)
    const part = partFromDTO(p.design.part).unwrap()
    const [first, second] = runs(p)
    expect(ids(defaultOrder(ops, part))).toEqual(['drill1', 'pocket2', 'drill2', 'pocket1'])
    // the 6 mm end mill is still in the spindle: its run goes first, still 2 runs
    expect(ids(defaultOrder(ops, part, undefined, second))).toEqual([
      'drill2',
      'pocket1',
      'drill1',
      'pocket2',
    ])
    expect(defaultOrder(ops, part, undefined, first)).toEqual(defaultOrder(ops, part))
    // a tool the setup does not use changes nothing
    expect(defaultOrder(ops, part, undefined, 'tool-x')).toEqual(defaultOrder(ops, part))
  })

  it('never adds a run for it: the outline’s tool waits for the cuts it frees', async () => {
    const s = await planSetup({ part: false })
    await outline(s)
    await hole(s, '30', '30', '8')
    await pocket(s, rect('60', '30', '10', '5', '2'))
    await s.run('project.apply', {})
    const p = s.plan(await s.create())
    const ops = opsOf(p)
    // starting with Flat 6 (the hole) would need Flat 6 → Flat 4 → Flat 6: 3 runs instead of 2
    expect(
      ids(defaultOrder(ops, partFromDTO(p.design.part).unwrap(), undefined, runs(p)[1])),
    ).toEqual(ids(ops))
  })
})
