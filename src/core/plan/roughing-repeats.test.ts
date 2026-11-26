// Roughing repeats (hardening DF122, slice R5): a Clones of a pocket with roughing plans every
// instance's roughing in one tool run before the owners, and each owner instance cuts only its
// rest (the same as its source); a split part's pieces each rough their cell of a pocket crossing
// the split line, the roughing right before the piece's pocket with its clipped shape.
// Spec: docs/modes/roughing.md#slices (R5), docs/modes/roughing.md#implementation-r5
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { len, libraryInput } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { flat6, opsOf, planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const LID = {
  name: 'Lid',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

/** The lid with a Flat 3 and a Flat 8 in the library (the R1 exit's tools). */
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

/** A plan of `partId`, generated: its design ids, toolpaths and program. */
async function planned(s: PlanSetup, svc: object, partId: string) {
  const planId = await s.create({ partId, machineLibraryItemId: s.machineId })
  const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
    .warnings
  expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  expectOk(await s.d.job(jobId).unwrap().result)
  const ops = opsOf(s.plan(planId))
  const paths = new Map(
    ops.map((o) => [
      o.designOperationIds.join('+'),
      (s.query('plan.toolpath.get', { planId, planOperationId: o.id }) as { toolpath: Toolpath })
        .toolpath,
    ]),
  )
  const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  return { ids: ops.map((o) => o.designOperationIds.join('+')), paths, lines: e.lines }
}

const cut = (tp: Toolpath | undefined) => tp!.stats.cutLength
const toolChanges = (lines: readonly string[]) =>
  lines.filter((l) => /^M0 ;Stop spindle, install/.test(l)).length

describe('roughing repeats (DF122 R5)', () => {
  it('Clones of a roughed pocket: the roughings in one tool run, then the owners on their rest', async () => {
    const { s, svc } = await lid()
    const pocket = (roughing: boolean) => ({
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['20', '25'],
        length: '30',
        width: '30',
        cornerRadius: '1.5',
      },
      depth: '6',
      ...(roughing ? { roughing: true } : {}),
    })
    await s.run('design.pocket.add', pocket(true))
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { operationIds: ['pocket1'] },
      rows: [{ kind: 'offset', count: 1, du: '40', dv: '0' }],
    })
    await s.run('project.apply', {})
    const r = await planned(s, svc, s.partId)
    expect(r.ids).toEqual([
      'pocket1_roughing',
      'clones1_2_pocket1_roughing',
      'pocket1',
      'clones1_2_pocket1',
    ])
    // one tool change: Ø 8 for both roughings, then Ø 3 for both owners
    expect(toolChanges(r.lines)).toBe(1)
    // the instance cuts the same rest as its source, far less than its whole pocket
    const plain = await lid()
    await plain.s.run('design.pocket.add', { ...pocket(false), partId: plain.s.partId })
    await plain.s.run('project.apply', {})
    const alone = await planned(plain.s, plain.svc, plain.s.partId)
    expect(cut(r.paths.get('clones1_2_pocket1'))).toBeCloseTo(cut(r.paths.get('pocket1')), 3)
    expect(cut(r.paths.get('clones1_2_pocket1'))).toBeLessThan(
      0.3 * cut(alone.paths.get('pocket1')),
    )
  }, 90_000) // plans and generates two parts; slow under the check-under-load criterion

  it('a split pocket: each piece roughs its cell, the roughing before the pocket', async () => {
    const { s, svc } = await lid()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['40', '25'],
        length: '50',
        width: '30',
        cornerRadius: '1.5',
      },
      depth: '6',
      roughing: { wall: '0.3' },
    })
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '40' }] },
    })
    await s.run('project.apply', {})
    const pieces = Object.values(s.d.doc.parts)
      .filter((p) => p.derivedFrom?.partId === s.partId)
      .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
    expect(pieces).toHaveLength(2)
    for (const p of pieces) {
      const ids = p.operations.map((o) => o.id)
      const at = ids.indexOf('pocket1')
      expect(ids[at - 1]).toBe('pocket1_roughing')
      const [rough, owner] = [p.operations[at - 1]!, p.operations[at]!] as Record<string, unknown>[]
      // the owner's clipped shape and depth, the roughing's own margins
      expect(rough!).toMatchObject({
        kind: 'pocket',
        roughing: true,
        roughingOf: 'pocket1',
        shape: owner!['shape'],
        depth: owner!['depth'],
        leave: owner!['roughingPass'],
      })
      const r = await planned(s, svc, p.id)
      expect(r.ids.indexOf('pocket1_roughing')).toBeLessThan(r.ids.indexOf('pocket1'))
      // the piece's pocket cuts its rest: far less than the roughing's clearing
      expect(cut(r.paths.get('pocket1'))).toBeLessThan(cut(r.paths.get('pocket1_roughing')))
    }
  }, 90_000) // plans and generates two pieces; slow under the check-under-load criterion
})
