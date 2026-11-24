// Z reference surface per tool run (hardening DF69): eligible surfaces, the default rule, the
// touch-off spot, stored choices and their findings, and the export's shift and spot move.
// Spec: docs/modes/z-reference.md
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan, withoutAppVersion } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { planSetup, type PlanSetup } from './plan.fixture'
import { planZReferences } from './z-reference'

const region2d = nodeRegion2d()

const rect = (x: string, y: string, l: string, w: string) => ({
  kind: 'rectangle',
  center: [x, y],
  length: l,
  width: w,
  cornerRadius: '3',
})

/**
 * 100 × 60 × 20 block (the fixture stock): a 0.5 mm facing (6 mm flat), a 20 × 10 pocket 3 deep
 * on its floor (4 mm flat), a 6 mm hole in the pocket (drill): three tool runs on the top.
 */
async function faced(opts: { facing?: boolean } = {}): Promise<{ s: PlanSetup; planId: string }> {
  const s = await planSetup({ part: false, services: { region2d } })
  const partId = s.partId
  if (opts.facing !== false) await s.run('design.facing.add', { partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId,
    on: opts.facing === false ? 'stock.top' : 'facing1.floor',
    shape: rect('50', '30', '20', '10'),
    depth: '3',
    floorRadius: '0',
  })
  await s.run('design.drilling.add', { partId, center: ['50', '30'], diameter: '6' })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const of = (design: string) =>
    s.plan(planId).setups[0]!.operations.find((o) => o.designOperationIds[0] === design)!.id
  // the default order drills first: the hole after the pocket
  const ops = s.plan(planId).setups[0]!.operations
  await s.run('plan.operation.move', {
    planId,
    planOperationId: of('drill1'),
    toIndex: ops.length - 1,
  })
  const tools: [string, string][] = [
    ['facing1', s.tools.flat6],
    ['pocket1', s.tools.flat4],
    ['drill1', s.tools.drill6],
  ]
  for (const [design, toolLibraryItemId] of tools)
    if (opts.facing !== false || design !== 'facing1')
      await s.run('plan.tool.assign', { planId, planOperationId: of(design), toolLibraryItemId })
  // the drill has no presets and no calculator data
  await s.run('plan.operation.update', {
    planId,
    planOperationId: of('drill1'),
    overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
  })
  return { s, planId }
}

const refs = (s: PlanSetup, planId: string) =>
  planZReferences(expectOk(loadPlan(s.d.doc, planId, 'test')), region2d)

const zFindings = (s: PlanSetup, planId: string) =>
  (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
    (w) => w.code === 'plan.zRef',
  )

const opId = (s: PlanSetup, planId: string, i: number) =>
  s.plan(planId).setups[0]!.operations[i]!.id

async function exported(s: PlanSetup, planId: string): Promise<string> {
  const e = expectOk(
    await exportPlan(s.d.doc, planId, {
      workers: createInProcessWorkers(),
      toolpaths: createToolpathCache(),
      region2d,
    }),
  )
  return withoutAppVersion(e.text)
}

describe('default rule (docs/modes/z-reference.md#default-rule)', () => {
  it('the first tool on the top face, later tools on the facing floor at its middle', async () => {
    const { s, planId } = await faced()
    const r = refs(s, planId)
    expect(r.map((x) => [x.zRef?.surface, x.zRef?.rule, x.zRef?.level])).toEqual([
      ['stock.top', 'top', 0],
      ['facing1.floor', 'facing', -0.5],
      ['facing1.floor', 'facing', -0.5],
    ])
    // run 2: nothing cut in the faced top yet: the middle of the face
    expect(r[1]!.zRef!.at).toEqual([50, 30])
    expect(r[1]!.zRef!.label).toBe('Facing 1 floor')
    // run 3: the pocket is in the middle; the spot moves to the widest uncut area, nearest the zero
    expect(r[2]!.zRef!.at).toEqual([21, 21])
    expect(r[2]!.candidates.map((c) => c.surface)).toEqual(['facing1.floor', 'pocket1.floor'])
    expect(zFindings(s, planId)).toEqual([])
  })

  it("outlines the reference's flat patch and spot area for the viewport, in the WCS", async () => {
    const { s, planId } = await faced()
    const r = refs(s, planId)
    // run 2: the whole faced top (100 × 60), the spot area inset by the clearance radius
    const o = r[1]!.outline!
    expect(o.grid).toBe(1)
    expect(o.patch).toHaveLength(1)
    const xs = o.patch[0]!.outer.map((p) => p[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 100])
    const ax = o.spotArea[0]!.outer.map((p) => p[0])
    expect(Math.min(...ax)).toBeCloseTo(o.clearance, 3)
    // run 3: the pocket in the middle is a hole of the patch
    expect(r[2]!.outline!.patch[0]!.holes.length).toBe(1)
    // the query carries it, agents do not (shape.ts)
    const q = s.query('plan.warning.list', { planId }) as { zRefs: { outline: unknown }[] }
    expect(q.zRefs[1]!.outline).toMatchObject({ grid: 1, clearance: o.clearance })
  })

  it('without a facing every run touches off on the top face, spots around the cuts', async () => {
    const { s, planId } = await faced({ facing: false })
    const r = refs(s, planId)
    expect(r.map((x) => x.zRef?.surface)).toEqual(['stock.top', 'stock.top'])
    expect(r[0]!.zRef!.at).toEqual([50, 30])
    expect(r[1]!.zRef!.at).toEqual([21, 21])
  })
})

describe('stored choice (plan.operation.update zRef)', () => {
  it('a floor cut before the run: chosen; its own or a later floor: notYetCut', async () => {
    const { s, planId } = await faced()
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 2),
      zRef: { surface: 'pocket1.floor' },
    })
    const r = refs(s, planId)[2]!
    expect(r.zRef).toMatchObject({ surface: 'pocket1.floor', level: -3.5, chosen: true })
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 1),
      zRef: { surface: 'pocket1.floor' },
    })
    expect(zFindings(s, planId)).toEqual([
      expect.objectContaining({
        severity: 'error',
        rule: 'notYetCut',
        planOperationId: opId(s, planId, 1),
        params: expect.objectContaining({ fixSurface: 'facing1.floor', fixAt: '50,30' }),
      }),
    ])
    // the error blocks the export
    expectErrCode(
      await exportPlan(s.d.doc, planId, {
        workers: createInProcessWorkers(),
        toolpaths: createToolpathCache(),
        region2d,
      }),
      'plan.check',
    )
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 1),
      zRef: null,
    })
    expect(zFindings(s, planId)).toEqual([])
  })

  it('a spot off the flat patch: spotNotFlat; an unknown surface is refused', async () => {
    const { s, planId } = await faced()
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 2),
      zRef: { at: ['50', '30'] },
    })
    expect(zFindings(s, planId).map((f) => f.rule)).toEqual(['spotNotFlat'])
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 2),
      zRef: { at: ['80', '45'] },
    })
    expect(refs(s, planId)[2]!.zRef).toMatchObject({ surface: 'facing1.floor', at: [80, 45] })
    expect(zFindings(s, planId)).toEqual([])
    await s.failWith(
      'plan.operation.update',
      { planId, planOperationId: opId(s, planId, 2), zRef: { surface: 'nope.floor' } },
      'model.invariant',
    )
  })

  it('a choice on an operation that no longer starts a run is inert', async () => {
    const { s, planId } = await faced()
    await s.run('plan.operation.update', {
      planId,
      planOperationId: opId(s, planId, 2),
      zRef: { surface: 'pocket1.floor' },
    })
    await s.run('plan.tool.assign', {
      planId,
      planOperationId: opId(s, planId, 2),
      toolLibraryItemId: s.tools.flat4,
    })
    expect(zFindings(s, planId).map((f) => [f.rule, f.severity])).toEqual([['inert', 'info']])
  })
})

describe('export (docs/modes/z-reference.md#exported-gcode)', () => {
  it('shifts later tool runs onto the facing floor and moves to the spot before each pause', async () => {
    const { s, planId } = await faced()
    const text = await exported(s, planId)
    expect(text).toContain('(Z0 on the top face for tool 1, later tools: see each tool change)')
    expect(text).toContain('(Tool 2: Flat 4, dia 4 mm, Z0 on Facing 1 floor)')
    const lines = text.split('\n')
    const marker = lines.findIndex((l) => l.startsWith('(DFYOM TOOL CHANGE 2'))
    // the fixture machine has a manual spindle: the stop comment stays next to the marker
    expect(lines.slice(marker - 5, marker + 6)).toEqual([
      'M5',
      'X50 Y30',
      '(Z0 for tool 2: Facing 1 floor, 0.50 below the stock top)',
      '(Touch off Z here, X50 Y30: set Z0 on that surface)',
      '(Stop the spindle)',
      expect.stringMatching(/^\(DFYOM TOOL CHANGE 2: /),
      // the surface does not fit on this pause line: the two comments above carry it
      'M0 ;Stop spindle, install T2 Flat 4, 4 mm flat, then zero Z',
      'G90 G94 G17 G21',
      'G54',
      // clearance 10 above the stock top = 10.5 above the faced floor
      'G0 Z10.5',
      expect.anything(),
    ])
  })

  it('a plan without a facing only gains the move to the spot', async () => {
    const { s, planId } = await faced({ facing: false })
    const text = await exported(s, planId)
    expect(text).toContain('(Z0 on the top face: the stock surface facing up)')
    expect(text).not.toContain('Touch off Z here')
    const lines = text.split('\n')
    const marker = lines.findIndex((l) => l.startsWith('(DFYOM TOOL CHANGE 2'))
    expect(lines.slice(marker - 3, marker + 1)).toEqual([
      'M5',
      'X21 Y21',
      '(Stop the spindle)',
      expect.stringMatching(/^\(DFYOM TOOL CHANGE 2: /),
    ])
  })
})
