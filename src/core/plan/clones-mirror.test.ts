// Clones mirror through the plan (hardening DF126, slice M1): a mirrored pocket and inside profile
// of an asymmetric named shape keep the source's climb sense on the toolpath (the generators
// derive the ring direction from the cut side, not from how the mirrored loop was drawn); a
// mirrored roughed pocket plans every roughing in one tool run before the owners (R5 order).
// Spec: docs/modes/clones-mirror.md#slices (M1)
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { len, libraryInput } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { Pass, Toolpath } from '../toolpath/model'
import { toolpathStats } from '../toolpath/stats'
import { flat6, opsOf, planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const LID = {
  name: 'Lid',
  shape: 'block' as const,
  length: '100',
  width: '60',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

/** An L, asymmetric in u and v (20 × 14, the leg 8 wide). */
const L_SHAPE = {
  kind: 'path',
  start: ['0', '0'],
  closed: true,
  segments: [
    { kind: 'line', to: ['20', '0'] },
    { kind: 'line', to: ['20', '8'] },
    { kind: 'line', to: ['8', '8'] },
    { kind: 'line', to: ['8', '14'] },
    { kind: 'line', to: ['0', '14'] },
  ],
}

async function lid() {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: LID })
  const add = (values: object) => s.run('library.tool.add', { values: libraryInput(values) })
  await add({ ...flat6(), name: 'Flat 3', diameter: len('3'), fluteLength: len('12'), presets: [] })
  await add({ ...flat6(), name: 'Flat 8', diameter: len('8') })
  return { s, svc }
}

/**
 * The part planned and generated: design ids in plan order, toolpaths by design id (a clone
 * group's instance: the passes it names, DF146), program.
 */
async function planned(s: PlanSetup, svc: object) {
  const planId = await s.create({ partId: s.partId, machineLibraryItemId: s.machineId })
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  const ops = opsOf(s.plan(planId))
  const paths = new Map<string, Toolpath>()
  for (const o of ops) {
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: o.id }) as { toolpath: Toolpath }
    ).toolpath
    paths.set(o.designOperationIds.join('+'), tp)
    if (o.designOperationIds.length > 1)
      for (const id of o.designOperationIds) {
        const passes = tp.passes.filter((p) => p.operationId === id)
        paths.set(id, { ...tp, passes, stats: toolpathStats(passes) })
      }
  }
  const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  return { ids: ops.map((o) => o.designOperationIds.join('+')), paths, lines: e.lines }
}

/** The signed area the feed moves of a pass enclose (> 0: counter-clockwise). */
function signedArea(p: Pass): number {
  const pts: [number, number][] = []
  for (const m of p.moves) if (m.kind === 'line' || m.kind === 'arc') pts.push([m.to[0], m.to[1]])
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!
    const [x1, y1] = pts[(i + 1) % pts.length]!
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** The winding of each finishing (else each) pass of a toolpath, as signs. */
const windings = (tp: Toolpath | undefined) => {
  const passes = tp!.passes.filter((p) => p.kind === 'finish')
  return (passes.length > 0 ? passes : tp!.passes).map((p) => Math.sign(signedArea(p)))
}

const toolChanges = (lines: readonly string[]) =>
  lines.filter((l) => /^M0 ;Stop spindle, install/.test(l)).length

describe('Clones mirror through the plan (DF126 M1)', () => {
  it('a mirrored named pocket and inside profile keep the climb sense of their source', async () => {
    const { s, svc } = await lid()
    await s.run('design.shape.add', { partId: s.partId, items: [L_SHAPE] })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['20', '15'] },
      depth: '2',
    })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['20', '42'] },
      side: 'inside',
      slotWidth: '6',
      tabs: { count: '0', width: '6', thickness: '2' },
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1', 'profile1'] },
      rows: [{ kind: 'mirror', flip: 'u' }],
    })
    await s.run('project.apply', {})
    const r = await planned(s, svc)
    for (const id of ['pocket1', 'profile1']) {
      const src = windings(r.paths.get(id))
      expect(src.length, id).toBeGreaterThan(0)
      expect(new Set(src).size, id).toBe(1)
      expect(windings(r.paths.get(`clones1_2_${id}`)), id).toEqual(src)
    }
  }, 90_000) // plans and generates four region toolpaths; slow under the check-under-load criterion

  it('a mirrored roughed pocket: the roughings in one tool run, then the owners', async () => {
    const { s, svc } = await lid()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['10', '15'],
        length: '30',
        width: '20',
        cornerRadius: '1.5',
        rotation: '10',
      },
      anchor: { u: 'min', v: 'min' },
      depth: '5',
      roughing: true,
    })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1'] },
      rows: [{ kind: 'mirror', flip: 'u' }],
    })
    await s.run('project.apply', {})
    const r = await planned(s, svc)
    // one plan operation per clone source operation (DF146)
    expect(r.ids).toEqual([
      'pocket1_roughing+clones1_2_pocket1_roughing',
      'pocket1+clones1_2_pocket1',
    ])
    expect(toolChanges(r.lines)).toBe(1)
    // the mirrored owner cuts the same rest as its source
    expect(r.paths.get('clones1_2_pocket1')!.stats.cutLength).toBeCloseTo(
      r.paths.get('pocket1')!.stats.cutLength,
      1,
    )
  }, 90_000) // plans and generates four region toolpaths; slow under the check-under-load criterion
})
