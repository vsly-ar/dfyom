// Chamfers in a plan (v0.4 T1): the entry resolved by P-C, the chamfer-mill checks (angle, tip,
// slant, reach), F10 feeds at the cut's depth, the order check against the edge, and the toolpath
// generated through the job. Spec: docs/modes/plan-v0.4.md (Chamfer toolpath, Tool checks, Feeds)
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { createInProcessWorkers } from '../commands/jobs'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { opsOf, planSetup } from './plan.fixture'

const ui = uiSource()

const chamferMill = (diameter: string, extra: object = {}) => ({
  name: `Chamfer ${diameter}`,
  type: 'chamferMill' as const,
  diameter: len(diameter),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
  ...extra,
})

interface OpView {
  id: string
  strategy: Record<string, number | string>
  feeds: Record<string, { value: number; source: string } | null>
}

async function setup(chamferArgs: object = {}) {
  const s = await planSetup({
    services: { toolpaths: createToolpathCache(), workers: createInProcessWorkers() },
  })
  const add = async (values: object) =>
    ((await s.run('library.tool.add', { values })) as { id: string }).id
  const tools = {
    cm12: await add(libraryInput(chamferMill('12'))),
    cm6: await add(libraryInput(chamferMill('6'))),
    cm60: await add(libraryInput(chamferMill('12', { angle: deg('60') }))),
    short: await add(libraryInput(chamferMill('6.5', { tipDiameter: len('6') }))),
  }
  // a 7 mm chamfer (default: edge + 1 mm) on the 6 mm through hole drill1 (top face, under the
  // 0.5 mm facing)
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'drill1', ...chamferArgs })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const planOp = (design: string) =>
    opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(design))!.id
  const chamfer = planOp('chamfer1')
  const assign = (toolLibraryItemId: string) =>
    s.run('plan.tool.assign', { planId, planOperationId: chamfer, toolLibraryItemId })
  const view = () =>
    (s.query('plan.operation.list', { planId }) as { operations: OpView[] }).operations.find(
      (o) => o.id === chamfer,
    )!
  const errors = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
      (w) => w.severity === 'error' && w.planOperationId === chamfer,
    )
  const generate = async () => {
    const { jobId } = expectOk(
      await s.d.dispatch('plan.toolpath.generate', { planId, planOperationIds: [chamfer] }, ui),
    ).value as { jobId: string }
    return expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { planOperationId: string; status: string; error?: { code: string } }[]
    }
  }
  const toolpath = () =>
    (s.query('plan.toolpath.get', { planId, planOperationId: chamfer }) as { toolpath: Toolpath })
      .toolpath
  return { s, planId, tools, chamfer, planOp, assign, view, errors, generate, toolpath }
}

const deepest = (tp: Toolpath) =>
  Math.min(
    ...tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? m.bottom : m.to[2]))),
  )

describe('chamfer plan operations', () => {
  it('a mill covering the chamfer plunges; F10 feeds at the plunged depth; the toolpath generates', async () => {
    const t = await setup()
    await t.assign(t.tools.cm12)
    expect(t.errors()).toEqual([])
    const v = t.view()
    // D 7, pointed 90°: the tip 3.5 below the face
    expect(v.strategy).toMatchObject({ entry: 'plunge', rampAngle: 3 })
    expect(v.strategy['cutDepth']).toBeCloseTo(3.5, 9)
    expect(Object.keys(v.feeds).filter((f) => v.feeds[f] !== null)).toEqual([
      'spindleSpeed',
      'feedRate',
      'plungeRate',
    ])
    const explained = t.s.query('plan.operation.feeds.get', {
      planId: t.planId,
      planOperationId: t.chamfer,
    }) as { inputs: { engagement: { kind: string; depth: number } } }
    expect(explained.inputs.engagement.kind).toBe('chamfer')
    expect(explained.inputs.engagement.depth).toBeCloseTo(3.5, 9)
    expect((await t.generate()).operations).toEqual([
      { planOperationId: t.chamfer, status: 'generated' },
    ])
    const tp = t.toolpath()
    expect(deepest(tp)).toBeCloseTo(-0.5 - 3.5, 9)
    expect(tp.passes.flatMap((p) => p.moves).some((m) => m.kind === 'arc')).toBe(false)
  })

  it('a smaller mill contours one ring at the chamfer depth', async () => {
    // a 10 mm chamfer: F10's De = 0 + 2 · 2 · tan 45° = 4 mm
    const t = await setup({ diameter: '10' })
    await t.assign(t.tools.cm6)
    expect(t.errors()).toEqual([])
    expect(t.view().strategy).toMatchObject({ entry: 'contour' })
    expect(t.view().strategy['cutDepth']).toBeCloseTo(2, 9)
    await t.generate()
    const tp = t.toolpath()
    expect(deepest(tp)).toBeCloseTo(-2.5, 9)
    expect(tp.passes.flatMap((p) => p.moves).some((m) => m.kind === 'arc')).toBe(true)
    // a plunge needs DC ≥ the chamfer Ø; a chamfer takes no helix; no stepdown
    const refuse = async (args: object) =>
      (
        await t.s.failWith(
          'plan.operation.update',
          { planId: t.planId, planOperationId: t.chamfer, ...args },
          'model.invariant',
        )
      ).issues.map((i) => i.rule)
    expect(await refuse({ strategy: { entry: 'plunge' } })).toEqual(['plungeSize'])
    expect(await refuse({ strategy: { entry: 'helix' } })).toEqual(['notForKind'])
    expect(
      (
        await t.s.failWith(
          'plan.operation.update',
          { planId: t.planId, planOperationId: t.chamfer, overrides: { stepdown: '1' } },
          'model.invariant',
        )
      ).issues.map((i) => i.rule),
    ).toEqual(['notForKind'])
  })

  it('a small contoured chamfer gets calculator feeds (De below the smallest charted diameter)', async () => {
    // the default 7 mm chamfer on the 6 mm hole with a pointed 6 mm mill: De = 0 + 7 − 6 = 1 mm
    const t = await setup()
    await t.assign(t.tools.cm6)
    expect(t.errors()).toEqual([])
    expect(t.view().strategy).toMatchObject({ entry: 'contour' })
    const v = t.view()
    for (const f of ['spindleSpeed', 'feedRate', 'plungeRate'])
      expect(v.feeds[f]?.source, f).toBe('calculator')
  })

  it('checks the chamfer mill: angle, tip, reach', async () => {
    const t = await setup()
    const rules = () => t.errors().map((w) => `${w.field}:${w.rule}`)
    await t.assign(t.tools.cm60)
    expect(rules()).toEqual(['tool:angle'])
    await t.assign(t.tools.short)
    expect(rules()).toEqual(['tool:tip'])
    await t.assign(t.tools.cm12)
    await t.s.run('plan.operation.update', {
      planId: t.planId,
      planOperationId: t.chamfer,
      stickout: '3',
    })
    // 0.5 facing + 3.5 plunged tip > 3
    expect(rules()).toEqual(['stickout:reach'])
  })

  it('a chamfer cuts after its edge: the move before it is refused (edgeBefore)', async () => {
    const t = await setup()
    await t.assign(t.tools.cm6)
    const ops = opsOf(t.s.plan(t.planId))
    const drill = ops.findIndex((o) => o.id === t.planOp('drill1'))
    expect(ops.findIndex((o) => o.id === t.chamfer)).toBeGreaterThan(drill)
    const e = await t.s.failWith(
      'plan.operation.move',
      { planId: t.planId, planOperationId: t.chamfer, toIndex: drill },
      'plan.order',
    )
    expect(e.issues.map((i) => i.rule)).toContain('edgeBefore')
  })
})
