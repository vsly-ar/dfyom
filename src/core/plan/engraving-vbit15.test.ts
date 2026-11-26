// DF123 (TG #407): a 15° engraving V-bit, now that a chamfer mill's included angle goes down to
// 10°. Added to the library, it is the engraved pattern's auto tool (the only V-bit); the groove
// width read-out (`maxWidth`) is its own, the plan takes it with modest F10 feeds and the export
// cuts to the deepest level. Doc: docs/architecture/library.md#tool (angle row),
// docs/modes/engraved-patterns.md#dryrun-and-maxwidth
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const V15 = {
  name: 'V-bit 15° 1/8',
  type: 'chamferMill' as const,
  diameter: len('3.175'),
  angle: deg('15'),
  fluteLength: len('12'),
  overallLength: len('38'),
  fluteCount: num('1'),
  toolMaterial: 'carbide' as const,
  presets: [],
}

const LID = {
  name: 'Lid',
  shape: 'block',
  length: '150',
  width: '100',
  thickness: '6',
  material: { name: 'Birch plywood', class: 'sheetGood' },
}

interface OpView {
  id: string
  feeds: Record<string, { value: number; source: string } | null>
}

describe('DF123: an engraved pattern with a 15° V-bit', { timeout: 60_000 }, () => {
  it('groove width, plan with the V-bit, modest feeds, export to the deepest level', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    const vbit = (
      (await s.run('library.tool.add', { values: libraryInput(V15) })) as { id: string }
    ).id
    await s.run('design.engraving.add', { partId: s.partId, depth: { min: '0.2', max: '1' } })
    await s.run('project.apply', {})
    // the auto choice took the library V-bit: its groove at 1 mm is 2 · tan 7.5° = 0.26 mm wide
    // (the default 60° bit's would be 1.15 mm)
    const dry = (await s.run('design.engraving.update', {
      partId: s.partId,
      featureId: 'engraving1',
      depth: { min: '0.2', max: '1' },
      dryRun: true,
    })) as { maxWidth?: number; warnings: { code: string }[] }
    expect(dry.maxWidth).toBe(0.26)
    expect(dry.warnings.map((w) => w.code)).not.toContain('dfm.lineTooDeep')

    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('engraving1_line'))!
    const snapshot = s.plan(planId).snapshots.find((x) => x.id === op.tool)
    expect(JSON.stringify(snapshot)).toContain(vbit)
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    // F10 at 1 mm: De 0.26 mm, chip load scaled by De / 3.175: a light engraving feed, never huge
    const view = (
      s.query('plan.operation.list', { planId }) as { operations: OpView[] }
    ).operations.find((o) => o.id === op.id)!
    const feed = view.feeds['feedRate']!
    expect(feed.source).toBe('calculator')
    expect(feed.value).toBeGreaterThan(0)
    expect(feed.value).toBeLessThan(500)

    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const generated = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(generated.operations.every((o) => o.status === 'generated')).toBe(true)
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    const zs = e.lines.flatMap((l) =>
      [...l.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])),
    )
    expect(Math.min(...zs.filter((z) => z < 0))).toBeCloseTo(-1, 3)
    expect(e.lines.some((l) => /15 ?deg/.test(l))).toBe(true)
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })

  it('with a 60° V-bit too, the auto choice keeps the 60°; the 15° is taken when locked', async () => {
    const s = await planSetup({ part: false, services: { region2d }, stock: LID })
    const add = async (values: object) =>
      ((await s.run('library.tool.add', { values: libraryInput(values) })) as { id: string }).id
    // the same size; without the angle rule the id order (tool-10 before tool-9) takes the 15°
    await add({ ...V15, name: 'V-bit 60° 1/8', angle: deg('60') })
    const v15 = await add(V15)
    await s.run('design.engraving.add', { partId: s.partId, depth: { min: '0.2', max: '1' } })
    await s.run('project.apply', {})
    const width = async () =>
      (
        (await s.run('design.engraving.update', {
          partId: s.partId,
          featureId: 'engraving1',
          dryRun: true,
        })) as { maxWidth?: number }
      ).maxWidth
    expect(await width()).toBe(1.15)
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'engraving1_line',
      tool: { kind: 'specific', toolLibraryItemId: v15 },
    })
    expect(await width()).toBe(0.26)
  })
})
