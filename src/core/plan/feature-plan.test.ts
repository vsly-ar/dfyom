// Feature and Clones operations in a plan (v0.4 P1): equal chamfers group into one plan operation,
// labels name the feature ("Bolt hole 1 · drill × 3"), Clones of a counterbored hole cut tool by tool
// (D34, one tool change), and the program comments each clone position.
// Spec: docs/modes/plan-v0.4.md (P-B, P-E, Plan side), docs/modes/features.md#plan-and-cut-order
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { planOperationLabel } from './labels'
import { opsOf, planSetup } from './plan.fixture'

async function setup(hole: object) {
  const services = { toolpaths: createToolpathCache(), workers: createInProcessWorkers() }
  const s = await planSetup({ part: false, services })
  await s.run('library.tool.add', {
    values: libraryInput({
      name: 'Chamfer 12',
      type: 'chamferMill' as const,
      diameter: len('12'),
      angle: deg('90'),
      fluteLength: len('8'),
      overallLength: len('50'),
      fluteCount: num('2'),
      toolMaterial: 'carbide' as const,
      presets: [],
    }),
  })
  await s.run('design.hole.add', { partId: s.partId, center: ['20', '20'], ...hole })
  await s.run('design.clones.add', {
    partId: s.partId,
    source: { featureId: 'hole1' },
    rows: [{ kind: 'offset', count: 2, du: '20', dv: '0' }],
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // entered feeds: the drill has no calculator data
  for (const op of opsOf(s.plan(planId)))
    await s.run('plan.operation.update', {
      planId,
      planOperationId: op.id,
      overrides: { spindleSpeed: '10000', feedRate: '600', plungeRate: '200' },
    })
  const plan = () => s.plan(planId)
  const rows = () =>
    opsOf(plan()).map((o) => ({
      ids: o.designOperationIds,
      label: planOperationLabel(plan().design.part, o.designOperationIds),
      tool: o.tool,
    }))
  const errors = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
      (w) => w.severity === 'error',
    )
  const exported = async () => expectOk(await exportPlan(s.d.doc, planId, services))
  return { s, planId, rows, errors, exported }
}

describe('feature operations in a plan', () => {
  it('Clones of a counterbored hole: every counterbore with one tool, then one drilling group', async () => {
    const t = await setup({ type: 'counterbore', diameter: '6', cbDiameter: '11', cbDepth: '3' })
    expect(t.errors()).toEqual([])
    const rows = t.rows()
    // one plan operation per clone source operation (DF146 G1): the counterbores too
    expect(rows.map((r) => r.ids)).toEqual([
      ['hole1_counterbore', 'clones1_2_hole1_counterbore', 'clones1_3_hole1_counterbore'],
      ['hole1_drill', 'clones1_2_hole1_drill', 'clones1_3_hole1_drill'],
    ])
    expect(rows.map((r) => r.label)).toEqual([
      'Bolt hole 1 · counterbore × 3',
      'Bolt hole 1 · drill × 3',
    ])
    // two distinct tools: one tool change (X1's assertion, D34)
    expect(rows[1]!.tool).not.toBe(rows[0]!.tool)
    const e = await t.exported()
    expect(e.stats.toolChanges).toBe(1)
    const comments = e.lines.filter(
      (l) => l.startsWith('(Bolt hole 1') || l.startsWith('(Clones 1'),
    )
    // the counterbores in path order, each position named
    expect(comments).toEqual([
      '(Bolt hole 1 - counterbore x 3)',
      '(Clones 1 #1)',
      '(Clones 1 #2)',
      '(Clones 1 #3)',
      '(Bolt hole 1 - drill x 3)',
      '(Clones 1 #1)',
      '(Clones 1 #2)',
      '(Clones 1 #3)',
    ])
  })

  it('Clones of a countersunk hole: equal chamfers share one plan operation', async () => {
    const t = await setup({ type: 'countersink', diameter: '6', csDiameter: '10', csAngle: '90' })
    expect(t.errors()).toEqual([])
    const rows = t.rows()
    expect(rows.map((r) => r.label)).toEqual([
      'Bolt hole 1 · drill × 3',
      'Bolt hole 1 · countersink × 3',
    ])
    expect(rows[1]!.ids).toEqual([
      'hole1_countersink',
      'clones1_2_hole1_countersink',
      'clones1_3_hole1_countersink',
    ])
    const e = await t.exported()
    expect(e.stats.toolChanges).toBe(1)
    // the generator visits nearest-neighbour from the start; each position named once
    const positions = e.lines.filter((l) => l.startsWith('(Clones 1'))
    expect(positions).toHaveLength(6)
    expect(new Set(positions.slice(3))).toEqual(
      new Set(['(Clones 1 #1)', '(Clones 1 #2)', '(Clones 1 #3)']),
    )
  })
})

describe('clone groups in Plan (hardening DF146)', () => {
  // G0, the user's 100 mm plate (TG #492): the bolt hole was planned before its Clones; the
  // rebuild gave the new instances their own plan operations (grouped among themselves) and left
  // the source's apart: "drill", "drill × 3", "countersink", "countersink × 3"
  it('a rebuild after adding Clones merges the source and its instances (G0)', async () => {
    const services = { toolpaths: createToolpathCache(), workers: createInProcessWorkers() }
    const s = await planSetup({ part: false, services })
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['20', '20'],
      type: 'countersink',
      diameter: '6',
      csDiameter: '10',
      csAngle: '90',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.run('design.clones.add', {
      partId: s.partId,
      source: { featureId: 'hole1' },
      rows: [{ kind: 'offset', count: 3, du: '20', dv: '0' }],
    })
    await s.run('project.apply', {})
    await s.run('plan.rebuild', { planId })
    const plan = s.plan(planId)
    expect(
      opsOf(plan).map((o) => planOperationLabel(plan.design.part, o.designOperationIds)),
    ).toEqual(['Bolt hole 1 · drill × 4', 'Bolt hole 1 · countersink × 4'])
  })

  // a Clones is one cut unit with its source, so a clone group is cut whole or not at all; equal
  // holes of their own are not: an already cut one never shares with an uncut one (DF135)
  it('an already cut hole stays apart from an equal uncut one', async () => {
    const s = await planSetup({ part: false })
    for (const center of [
      ['20', '20'],
      ['50', '20'],
    ])
      await s.run('design.hole.add', { partId: s.partId, center, diameter: '6' })
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['hole1'] })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    expect(opsOf(s.plan(planId)).map((o) => o.designOperationIds)).toEqual([
      ['hole1_drill'],
      ['hole2_drill'],
    ])
  })
})
