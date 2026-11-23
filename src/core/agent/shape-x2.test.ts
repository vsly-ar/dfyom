// The X2 shaping (hardening DF38, DF41): plan findings grouped across plan operations, Clones
// instances collapsed in design.operation.list, Clones previews without the drawn path, tools by
// name. A 100-instance Clones on a tool without feeds data is the case X2 measured at ~2 KB per
// plan operation.
// Spec: docs/architecture/llm-api.md#amendment-hardening-df38-df39-df41-x2-agent-friction
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { Ok } from '../../shared/result'
import { uiSource } from '../commands/testing'
import { len, libraryInput } from '../library/library.fixture'
import { flat4, planSetup, type PlanSetup } from '../plan/plan.fixture'
import { FEEDS_NEXT, ResultShaper, splitDetail, type View, type ShaperSession } from './shape'
import type { SessionCallResult } from './session'

const ui = uiSource()

/** Flat 3 without presets: no feeds data in aluminium (the ≤ 3 mm metal band is empty). */
const flat3 = () => ({ ...flat4(), name: 'Flat 3', diameter: len('3') })

/**
 * A Ø3.6 circle pocket (only Flat 3 fits) repeated by a 10 × 10 grid: 100 instances, each its own
 * plan operation; a second pocket outside the Clones for previews.
 */
async function setup() {
  const s = await planSetup({ part: false })
  await s.run('library.tool.add', { values: libraryInput(flat3()) })
  const pocket = (x: string, y: string) =>
    s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'circle', center: [x, y], diameter: '3.6' },
      depth: '1',
    })
  await pocket('6', '4')
  await s.run('design.clones.add', {
    partId: s.partId,
    source: { operationIds: ['pocket1'] },
    rows: [{ kind: 'grid', cols: 10, rows: 10, du: '9.5', dv: '5.5' }],
  })
  await pocket('50', '30')
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const session: ShaperSession = {
    boundKey: 'p',
    peek: (name, args) => s.d.query(name, args, ui).map((o) => o.value),
    resultSchema: () => undefined,
    snapshot: (id) => s.d.doc.snapshots[id],
  }
  return { s, planId, shaper: new ResultShaper(session) }
}

type Setup = { s: PlanSetup; shaper: ResultShaper }

/** A value shaped as the MCP adapter shapes a call's result. */
function shapeValue(t: Setup, name: string, args: unknown, view: View, value: unknown) {
  const call: SessionCallResult = { name, kind: 'query', result: Ok({ value, revision: 1 }) }
  return expectOk(t.shaper.shape(call, args, view).result).value as Record<string, unknown>
}

/** A query through the shaper as MCP does it: reserved args split off, then the result shaped. */
function shaped(t: Setup, name: string, rawArgs: object) {
  const { args, view } = expectOk(splitDetail(name, rawArgs))
  return shapeValue(t, name, args, view, expectOk(t.s.d.query(name, args, ui)).value)
}

const bytes = (v: unknown) => JSON.stringify(v).length

describe('X2 shaping at the agent boundary (DF38, DF41)', () => {
  it('plan_warning_list groups a 100-operation plan under 32 KB, with a next step (DF38, DF39)', async () => {
    const t = await setup()
    const full = shaped(t, 'plan.warning.list', { planId: t.planId, detail: 'full' })
    const findings = full['warnings'] as { code: string; rule: string; next?: string }[]
    const unresolved = findings.filter((f) => f.code === 'plan.check' && f.rule === 'unresolved')
    expect(unresolved.length).toBeGreaterThanOrEqual(200)
    expect(unresolved.every((f) => f.next === FEEDS_NEXT)).toBe(true)
    expect(bytes(full)).toBeGreaterThan(64_000) // what X2 extrapolated, before grouping

    const summary = shaped(t, 'plan.warning.list', { planId: t.planId })
    // the text block repeats a result up to 32,000 chars: both copies stay well under 64 KB
    expect(bytes(summary)).toBeLessThan(32_000)
    const groups = summary['groups'] as {
      code: string
      rule: string
      field?: string
      count: number
      planOperationIds?: string[]
      more?: number
      next?: string
    }[]
    const feedRate = groups.find((g) => g.rule === 'unresolved' && g.field === 'feedRate')!
    expect(feedRate.count).toBe(101)
    expect(feedRate.planOperationIds).toHaveLength(20)
    expect(feedRate.more).toBe(81)
    expect(feedRate.next).toBe(FEEDS_NEXT)
    expect(groups.find((g) => g.code === 'feeds.noData')?.next).toBe(FEEDS_NEXT)
    const counts = summary['counts'] as Record<string, number>
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(findings.length)
    expect(summary['detail']).toMatch(/detail: "full"/)
  })

  it('design_operation_list collapses Clones instances that only move, names tools (DF38, F5)', async () => {
    const t = await setup()
    const full = shaped(t, 'design.operation.list', { partId: t.s.partId, detail: 'full' })
    expect((full['operations'] as unknown[]).length).toBe(101)
    const summary = shaped(t, 'design.operation.list', { partId: t.s.partId })
    expect((summary['operations'] as { id: string }[]).map((o) => o.id)).toEqual([
      'pocket1',
      'pocket2',
    ])
    const clones = summary['clones'] as {
      featureId: string
      sourceOperationIds: string[]
      instances: { n: number; offset?: number[] }[]
    }[]
    expect(clones).toHaveLength(1)
    expect(clones[0]).toMatchObject({ featureId: 'clones1', sourceOperationIds: ['pocket1'] })
    expect(clones[0]!.instances).toHaveLength(99)
    expect(clones[0]!.instances[0]).toEqual({ n: 2, offset: [9.5, 0] })
    expect(bytes(summary)).toBeLessThan(bytes(full) / 4)
    // the auto choice put Flat 3 on the pocket: named beside its snapshot id
    const tool = (summary['operations'] as { tool: Record<string, unknown> }[])[0]!.tool
    expect(tool).toMatchObject({ kind: 'specific', name: 'Flat 3', diameter: 3 })
  })

  it('an instance that differs in more than its position stays listed in full', async () => {
    const t = await setup()
    const list = expectOk(t.s.d.query('design.operation.list', { partId: t.s.partId }, ui))
      .value as { operations: Record<string, unknown>[] }
    const operations = list.operations.map((o) =>
      o['id'] === 'clones1_5_pocket1' ? { ...o, depth: '2' } : o,
    )
    const view: View = { detail: 'summary', from: 0, count: 0 }
    const summary = shapeValue(t, 'design.operation.list', {}, view, { operations })
    expect((summary['operations'] as { id: string }[]).map((o) => o.id)).toEqual([
      'pocket1',
      'clones1_5_pocket1',
      'pocket2',
    ])
    const instances = (summary['clones'] as { instances: { n: number }[] }[])[0]!.instances
    expect(instances.map((i) => i.n)).not.toContain(5)
  })

  it('design_clones_preview leaves out the drawn path unless detail: "full" (F11)', async () => {
    const t = await setup()
    const args = {
      partId: t.s.partId,
      source: { operationIds: ['pocket2'] },
      rows: [{ kind: 'arc', radius: '5', angle: '0', arc: '360', step: '60' }],
    }
    const summary = shaped(t, 'design.clones.preview', args)
    const rows = summary['rows'] as Record<string, unknown>[]
    expect(rows[0]).not.toHaveProperty('path')
    expect(rows[0]).toHaveProperty('points')
    const full = shaped(t, 'design.clones.preview', { ...args, detail: 'full' })
    expect((full['rows'] as Record<string, unknown>[])[0]).toHaveProperty('path')
  })
})
